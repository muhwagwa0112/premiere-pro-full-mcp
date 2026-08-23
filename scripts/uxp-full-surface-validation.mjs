import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SCRIPT_NAME = basename(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalogUrl = new URL("../generated/adobe-uxp-api.json", import.meta.url);

const SKIP_REASONS = Object.freeze({
  edit: "project_mutation_preview_only",
  sensitive: "sensitive_or_external_side_effect_preview_only",
  filesystem: "filesystem_side_effect_preview_only",
  destructive: "destructive_or_external_side_effect_preview_only",
});

function requiredArgumentCount(entry) {
  return entry.parameters.filter((parameter) => !parameter.optional && !parameter.rest).length;
}

function hasCallback(entry) {
  return entry.parameters.some((parameter) => String(parameter.type).includes("=>"));
}

/**
 * Deliberately narrow allowlist for live calls. Everything else is still checked
 * against the live catalog, but is represented as preview-only in the ledger.
 */
export function classifyEntry(entry) {
  if (entry.bucket !== "read" || entry.mutates) {
    return { disposition: "preview_only", reason: SKIP_REASONS[entry.bucket] ?? "non_read_authority_preview_only" };
  }
  if (["Project.executeTransaction", "Project.lockedAccess"].includes(entry.id) || entry.container === "EventManagerStatic") {
    return { disposition: "skipped", reason: "bridge_owned_special_adapter" };
  }
  if (entry.classification === "deferred_action") {
    return { disposition: "skipped", reason: "deferred_action_factory_requires_transaction_context" };
  }
  if (requiredArgumentCount(entry) > 0) {
    return { disposition: "skipped", reason: "required_arguments_not_safely_synthesizable" };
  }
  if (hasCallback(entry)) {
    return { disposition: "skipped", reason: "callback_not_safely_synthesizable" };
  }
  if (entry.memberKind === "constructor") {
    return { disposition: "execute_live", reason: "zero_argument_value_constructor" };
  }
  if ((entry.dispatchKind === "root_member" || entry.dispatchKind === "enum_constant") && entry.memberKind === "property") {
    return { disposition: "execute_live", reason: "root_readonly_property" };
  }
  if (entry.dispatchKind === "root_member" && entry.memberKind === "method" && entry.classification === "getter_name") {
    return { disposition: "execute_live", reason: "zero_argument_root_getter" };
  }
  if (!entry.root) return { disposition: "skipped", reason: "instance_member_requires_typed_live_handle" };
  return { disposition: "skipped", reason: "read_member_not_allowlisted_by_safe_policy" };
}

function stableEntry(entry) {
  const classification = classifyEntry(entry);
  return {
    id: entry.id,
    container: entry.container,
    member: entry.member,
    memberKind: entry.memberKind,
    dispatchKind: entry.dispatchKind,
    bucket: entry.bucket,
    risk: entry.risk,
    authority: entry.authority,
    mutates: !!entry.mutates,
    classification: entry.classification || null,
    requiredArguments: requiredArgumentCount(entry),
    disposition: classification.disposition,
    policyReason: classification.reason,
  };
}

export function buildPlan(catalog) {
  assert.equal(catalog.schemaVersion, 2, "Unsupported generated Adobe catalog schema");
  assert.ok(Array.isArray(catalog.entries), "Generated Adobe catalog entries are missing");
  const ids = new Set(catalog.entries.map((entry) => entry.id));
  assert.equal(ids.size, catalog.entries.length, "Generated Adobe catalog contains duplicate member IDs");
  assert.equal(catalog.counts.members, catalog.entries.length, "Generated Adobe member count does not match entries");
  const entries = catalog.entries.map(stableEntry);
  const counts = entries.reduce((result, entry) => {
    result[entry.disposition] = (result[entry.disposition] ?? 0) + 1;
    return result;
  }, {});
  return { entries, counts };
}

function safeResultShape(value) {
  if (value === null || value === undefined) return { wireType: "null" };
  if (Array.isArray(value)) return { wireType: "array", itemCount: value.length };
  if (typeof value !== "object") return { wireType: typeof value };
  if (typeof value.$ref === "string") return { wireType: "handle", handleType: typeof value.type === "string" ? value.type : "unknown" };
  if (Array.isArray(value.items)) return { wireType: "paged_array", itemCount: value.items.length, truncated: !!value.truncated };
  return { wireType: "object", propertyCount: Object.keys(value).length };
}

function callData(result) {
  assert.equal(result.isError, undefined, "MCP transport returned a tool error");
  return result.structuredContent;
}

async function callTool(client, name, argumentsValue, timeout) {
  return callData(await client.callTool({ name, arguments: argumentsValue }, undefined, { timeout }));
}

async function waitForUxp(client, waitMs, timeout) {
  const deadline = Date.now() + waitMs;
  let capabilities;
  while (Date.now() < deadline) {
    capabilities = await callTool(client, "premiere_capabilities", {}, timeout);
    if (capabilities.backends?.uxp?.available) return capabilities;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`UXP bridge did not become available within ${waitMs}ms`);
}

async function readLiveCatalog(client, timeout) {
  const entries = [];
  let offset = 0;
  let fingerprint = null;
  let counts = null;
  while (offset !== null) {
    const response = await callTool(client, "premiere_api", { actionId: "uxp.catalog", args: { offset, limit: 200 } }, timeout);
    assert.equal(response.status, "succeeded", `Live UXP catalog page failed at offset ${offset}`);
    const page = response.data?.result ?? response.data;
    assert.ok(page && Array.isArray(page.entries), `Live UXP catalog page is malformed at offset ${offset}`);
    fingerprint ??= page.fingerprint;
    counts ??= page.counts;
    assert.equal(page.fingerprint, fingerprint, "Live UXP catalog fingerprint changed during validation");
    entries.push(...page.entries);
    offset = page.nextOffset;
  }
  return { fingerprint, counts, entries };
}

function assertCatalogParity(generated, live) {
  assert.equal(live.fingerprint, generated.fingerprint, "Generated and live UXP catalog fingerprints differ");
  assert.equal(live.entries.length, generated.entries.length, "Live UXP catalog member count differs from generated catalog");
  const liveIds = new Set(live.entries.map((entry) => entry.id));
  assert.equal(liveIds.size, live.entries.length, "Live UXP catalog contains duplicate member IDs");
  for (const entry of generated.entries) assert.ok(liveIds.has(entry.id), `Live UXP catalog is missing ${entry.id}`);
  return liveIds;
}

async function executeSafeEntry(client, entry, timeout) {
  const startedAt = Date.now();
  const response = await callTool(client, "premiere_api", {
    actionId: "uxp.read",
    operationId: randomUUID(),
    args: { memberId: entry.id, arguments: [] },
  }, timeout);
  const durationMs = Date.now() - startedAt;
  if (response.status !== "succeeded") {
    return { outcome: "live_failed", errorCode: response.error?.code ?? "UNKNOWN_BRIDGE_ERROR", durationMs };
  }
  const runtimeResult = response.data?.result ?? response.data;
  const memberResult = runtimeResult?.result ?? runtimeResult;
  return { outcome: "live_succeeded", resultShape: safeResultShape(memberResult), durationMs };
}

function parseOptions(argv) {
  const options = {
    planOnly: false,
    ledger: resolve(repositoryRoot, "validation-results", "uxp-full-surface-ledger.json"),
    timeout: 15_000,
    wait: 45_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--plan-only") options.planOnly = true;
    else if (argument === "--ledger") options.ledger = resolve(argv[++index] ?? "");
    else if (argument === "--timeout-ms") options.timeout = Number(argv[++index]);
    else if (argument === "--wait-ms") options.wait = Number(argv[++index]);
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (!options.ledger) throw new Error("--ledger requires a path");
  if (!Number.isInteger(options.timeout) || options.timeout < 1_000 || options.timeout > 120_000) throw new Error("--timeout-ms must be 1000-120000");
  if (!Number.isInteger(options.wait) || options.wait < 1_000 || options.wait > 300_000) throw new Error("--wait-ms must be 1000-300000");
  return options;
}

async function writeLedger(path, ledger) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: "utf8" });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  const catalog = JSON.parse(await readFile(catalogUrl, "utf8"));
  const plan = buildPlan(catalog);
  const ledger = {
    schemaVersion: 1,
    runner: SCRIPT_NAME,
    mode: options.planOnly ? "plan_only" : "live",
    generatedAt: new Date().toISOString(),
    policy: {
      liveExecution: "read-only root properties, zero-argument root getters, and zero-argument value constructors only",
      unsafeHandling: "catalog-presence validation plus explicit preview-only or skip reason; never apply mutation, filesystem, sensitive, destructive, or external effects",
      outputRedaction: "no return values, error messages, secrets, tokens, or absolute paths",
    },
    catalog: {
      schemaVersion: catalog.schemaVersion,
      fingerprint: catalog.fingerprint,
      declaredMembers: catalog.counts.members,
      ledgerMembers: plan.entries.length,
      uniqueMembers: new Set(plan.entries.map((entry) => entry.id)).size,
      counts: catalog.counts,
    },
    live: null,
    summary: { ...plan.counts },
    entries: plan.entries.map((entry) => ({ ...entry, catalogPresence: options.planOnly ? "not_checked" : false, outcome: options.planOnly ? "planned" : "pending" })),
  };

  if (!options.planOnly) {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    const launcher = join(localAppData, "PremiereMCP", "bin", "PremiereMcp.WindowsUiAgent.exe");
    const bundle = join(localAppData, "PremiereMCP", "bundle", "premiere-mcp.bundle.mjs");
    const client = new Client({ name: "premiere-mcp-uxp-full-surface-validation", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: launcher,
      args: ["--launch-mcp", bundle],
      stderr: "pipe",
      env: {
        ...process.env,
        PREMIERE_MCP_UXP_PORT: process.env.PREMIERE_MCP_UXP_PORT || "17777",
        PREMIERE_MCP_UI_PIPE: `PremiereMcpUi.FullSurface.${process.pid}`,
      },
    });
    try {
      await client.connect(transport);
      const capabilities = await waitForUxp(client, options.wait, options.timeout);
      const liveCatalog = await readLiveCatalog(client, options.timeout);
      const liveIds = assertCatalogParity(catalog, liveCatalog);
      ledger.live = {
        available: true,
        backend: "uxp",
        hostVersion: capabilities.backends.uxp.hostVersion ?? null,
        catalogFingerprintMatch: true,
        catalogMembers: liveCatalog.entries.length,
      };
      for (const entry of ledger.entries) {
        entry.catalogPresence = liveIds.has(entry.id);
        if (entry.disposition === "execute_live") {
          Object.assign(entry, await executeSafeEntry(client, entry, options.timeout));
        } else {
          entry.outcome = entry.disposition === "preview_only" ? "preview_only_not_applied" : "skipped_with_reason";
        }
      }
    } finally {
      await client.close();
    }
  }

  const outcomes = ledger.entries.reduce((result, entry) => {
    result[entry.outcome] = (result[entry.outcome] ?? 0) + 1;
    return result;
  }, {});
  ledger.summary = { ...ledger.summary, outcomes };
  assert.equal(ledger.catalog.ledgerMembers, catalog.counts.members);
  assert.equal(ledger.catalog.uniqueMembers, catalog.counts.members);
  await writeLedger(options.ledger, ledger);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode: ledger.mode,
    catalogMembers: ledger.catalog.ledgerMembers,
    uniqueMembers: ledger.catalog.uniqueMembers,
    live: ledger.live,
    summary: ledger.summary,
    ledgerWritten: true,
  })}\n`);
  return ledger;
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Top-level errors can originate in process launchers and include local
    // absolute paths. Keep CLI failure output deliberately opaque; the ledger
    // itself records only stable bridge error codes.
    process.stderr.write(`${JSON.stringify({ ok: false, errorCode: "FULL_SURFACE_VALIDATION_FAILED" })}\n`);
    process.exitCode = 1;
  });
}
