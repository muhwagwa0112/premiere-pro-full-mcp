import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { allocateGeneratedFixture, buildFixturePlan, cleanupDisposableFixture, prepareDisposableFixture, sealGeneratedFixture, verifyPristineRestore } from "../../dist/evidence/fixture-plan.js";
import { createFixtureEvidence, writeFixtureEvidence } from "../../dist/evidence/record.js";
import { sha256Canonical } from "../../dist/security/execution-plan.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixturesRoot = join(repositoryRoot, "fixtures");
const defaultManifest = join(fixturesRoot, "live-host", "project-save.fixture.json");

function parseOptions(argv) {
  const options = { live: false, confirmedIsolatedHost: false, manifest: defaultManifest, evidence: join(repositoryRoot, "validation-results", "fixture-evidence.json") };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--plan-only") options.live = false;
    else if (argument === "--live") options.live = true;
    else if (argument === "--confirm-isolated-host") options.confirmedIsolatedHost = true;
    else if (argument === "--manifest") options.manifest = resolve(argv[++index] ?? "");
    else if (argument === "--evidence") options.evidence = resolve(argv[++index] ?? "");
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function structured(result) {
  assert.equal(result.isError, undefined, "MCP transport returned a tool error");
  return result.structuredContent;
}

async function call(client, tool, actionId, args, request = {}) {
  return structured(await client.callTool({ name: tool, arguments: { actionId, args, ...request } }, undefined, { timeout: 90_000, maxTotalTimeout: 90_000 }));
}

async function fileEvidence(path) {
  const bytes = await readFile(path);
  const metadata = await stat(path);
  return { bytes: metadata.size, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, modifiedMs: metadata.mtimeMs };
}

function projectState(value) {
  const data = value?.data ?? {};
  return {
    sequences: Array.isArray(data.sequences) ? data.sequences.map((entry) => ({ name: entry?.name ?? null })).sort((left, right) => String(left.name).localeCompare(String(right.name))) : [],
    activeSequencePresent: data.activeSequenceGuid != null || data.activeSequenceId != null,
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  const canonicalFixturesRoot = await realpath(fixturesRoot);
  const canonicalManifest = await realpath(options.manifest);
  const manifestRelative = relative(canonicalFixturesRoot, canonicalManifest);
  if (!manifestRelative || manifestRelative === ".." || manifestRelative.startsWith(`..${sep}`) || isAbsolute(manifestRelative)) throw new Error("Fixture manifest must be stored below the repository fixtures directory");
  const manifest = JSON.parse(await readFile(canonicalManifest, "utf8"));
  let plan = buildFixturePlan(manifest, { mode: options.live ? "live" : "plan_only" });
  if (!options.live) {
    process.stdout.write(`${JSON.stringify({ ok: true, mode: "plan_only", plan }, null, 2)}\n`);
    return;
  }
  if (!options.confirmedIsolatedHost) throw new Error("Live fixture execution requires --confirm-isolated-host");
  if (!["trusted_unattended", "isolated_lab"].includes(process.env.PREMIERE_MCP_AUTOMATION_MODE ?? "") || !process.env.PREMIERE_MCP_TRUST_PROFILE_ID) throw new Error("Live fixture execution requires an enrolled trusted_unattended or isolated_lab trust profile");

  let generated = null;
  let prepared = null;
  let fixtureProjectOpen = false;
  let lastVerifiedRevision = null;
  let unknownMutationOutcome = false;
  let activeFixturePath = null;
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  const launcher = process.env.PREMIERE_MCP_LAUNCHER || join(localAppData, "PremiereMCP", "bin", "PremiereMcp.WindowsUiAgent.exe");
  const bundle = process.env.PREMIERE_MCP_BUNDLE || join(localAppData, "PremiereMCP", "bundle", "premiere-mcp.bundle.mjs");
  const client = new Client({ name: "premiere-mcp-disposable-fixture", version: "0.3.0" });
  const transport = new StdioClientTransport({
    command: launcher,
    args: ["--launch-mcp", bundle],
    cwd: repositoryRoot,
    stderr: "pipe",
    env: { ...process.env, PREMIERE_MCP_UI_PIPE: `PremiereMcpUi.Fixture.${process.pid}` },
  });
  try {
    await client.connect(transport);
    const capabilities = structured(await client.callTool({ name: "premiere_capabilities", arguments: {} }, undefined, { timeout: 30_000 }));
    const host = await call(client, "premiere_inspect", "host.inspect", {});
    assert.equal(host.status, "succeeded", "Host preflight failed");
    assert.ok(["uxp", "cep"].includes(host.backend), "Fixture preflight requires a connected UXP or CEP host, not local inventory");
    assert.equal(host.data?.projectOpen, false, "Refusing fixture dispatch because Premiere already has an active project");
    const backendProbe = capabilities.backends?.[host.backend];
    const apiFingerprint = backendProbe?.capabilityFingerprint ?? capabilities.adobeUxpInventory?.fingerprint;
    assert.match(apiFingerprint ?? "", /^(?:sha256:)?[a-f0-9]{64}$/, "Connected host/API fingerprint is unavailable");
    const hostBuild = String(host.data?.hostVersion ?? host.hostVersion ?? backendProbe?.hostVersion ?? "");
    assert.ok(hostBuild, "Connected host build is unavailable");

    if (manifest.project.strategy === "generated_empty") generated = await allocateGeneratedFixture({ runId: plan.runId, projectName: manifest.project.relativeName });
    else prepared = await prepareDisposableFixture({ repositoryFixturesRoot: fixturesRoot, sourceProject: manifest.project.sourceProject, runId: plan.runId });
    const opened = generated
      ? await call(client, "premiere_project", "project.create", { path: generated.workingProject })
      : await call(client, "premiere_project", "project.open", { path: prepared.workingProject });
    assert.equal(opened.status, "succeeded", "Disposable working copy did not open");
    fixtureProjectOpen = true;
    activeFixturePath = prepared?.workingProject ?? generated?.workingProject ?? null;
    if (generated) prepared = await sealGeneratedFixture(generated);
    plan = buildFixturePlan(manifest, { mode: "live", runId: plan.runId, fixtureDigest: prepared.fixtureDigest });
    const before = await call(client, "premiere_inspect", manifest.verification.beforeActionId, {});
    assert.equal(before.status, "succeeded");
    lastVerifiedRevision = before.afterRevision;
    const beforeStateDigest = sha256Canonical(projectState(before));
    const fileBeforeMutation = await fileEvidence(prepared.workingProject);

    const mutation = await call(client, "premiere_project", manifest.mutation.actionId, manifest.mutation.args, { expectedRevision: lastVerifiedRevision });
    if (mutation.status === "reconciliation_required" || mutation.status === "dispatched") {
      unknownMutationOutcome = true;
      throw new Error("Fixture mutation outcome is unknown; it will not be replayed or automatically restored");
    }
    assert.equal(mutation.status, "succeeded", "Fixture mutation failed before verified completion");
    assert.equal(mutation.verification?.outcome, "verified", "Fixture mutation lacks verified host evidence");
    const after = await call(client, "premiere_inspect", manifest.verification.afterActionId, {});
    assert.equal(after.status, "succeeded");
    lastVerifiedRevision = after.afterRevision;
    const fileAfterMutation = await fileEvidence(prepared.workingProject);
    assert.ok(fileAfterMutation.bytes > 0, "Project save did not produce a non-empty project file");
    assert.ok(fileAfterMutation.modifiedMs >= fileBeforeMutation.modifiedMs, "Project file timestamp regressed after save");
    const afterStateDigest = sha256Canonical({ project: projectState(after), file: { bytes: fileAfterMutation.bytes, sha256: fileAfterMutation.sha256 } });

    const workingClosed = await call(client, "premiere_project", "project.close_disposable", { path: prepared.workingProject, saveBeforeClose: true }, { expectedRevision: lastVerifiedRevision });
    if (workingClosed.status === "reconciliation_required") {
      unknownMutationOutcome = true;
      throw new Error("Disposable working project close outcome is unknown");
    }
    assert.equal(workingClosed.status, "succeeded", "Disposable working project did not close cleanly");
    fixtureProjectOpen = false;
    activeFixturePath = null;

    await verifyPristineRestore(prepared);
    const restoredOpen = await call(client, "premiere_project", "project.open", { path: prepared.restoreProject });
    assert.equal(restoredOpen.status, "succeeded", "Pristine restore copy did not open");
    fixtureProjectOpen = true;
    activeFixturePath = prepared.restoreProject;
    const restored = await call(client, "premiere_inspect", manifest.verification.afterActionId, {});
    assert.equal(restored.status, "succeeded");
    lastVerifiedRevision = restored.afterRevision;
    const restoredStateDigest = sha256Canonical(projectState(restored));
    assert.equal(restoredStateDigest, beforeStateDigest, "Restored fixture state differs from its pre-mutation state");
    await verifyPristineRestore(prepared);
    const restoredClosed = await call(client, "premiere_project", "project.close_disposable", { path: prepared.restoreProject, saveBeforeClose: true }, { expectedRevision: lastVerifiedRevision });
    if (restoredClosed.status === "reconciliation_required") {
      unknownMutationOutcome = true;
      throw new Error("Pristine restore project close outcome is unknown");
    }
    assert.equal(restoredClosed.status, "succeeded", "Pristine restore project did not close cleanly");
    fixtureProjectOpen = false;
    activeFixturePath = null;

    const evidence = createFixtureEvidence({
      featureId: manifest.mutation.actionId,
      backend: mutation.backend,
      hostVersion: String(mutation.hostVersion ?? backendProbe?.hostVersion ?? hostBuild),
      hostBuild,
      apiFingerprint,
      fixtureDigest: prepared.fixtureDigest,
      planHash: plan.planHash,
      beforeStateDigest,
      afterStateDigest,
      restoredStateDigest,
      outcome: "verified",
      rollbackOutcome: "verified",
    });
    await writeFixtureEvidence(options.evidence, evidence);
    process.stdout.write(`${JSON.stringify({ ok: true, mode: "live", evidence }, null, 2)}\n`);
  } finally {
    if (fixtureProjectOpen && !unknownMutationOutcome) {
      try {
        const inspected = await call(client, "premiere_inspect", "project.inspect", {});
        const closed = await call(client, "premiere_project", "project.close_disposable", { path: activeFixturePath, saveBeforeClose: true }, { expectedRevision: inspected.afterRevision });
        fixtureProjectOpen = closed.status !== "succeeded";
      } catch { fixtureProjectOpen = true; }
    }
    await client.close();
    if (prepared && !fixtureProjectOpen && !unknownMutationOutcome) await cleanupDisposableFixture(prepared);
    else if (generated && !prepared && !fixtureProjectOpen) await cleanupDisposableFixture({ ...generated, fixtureDigest: sha256Canonical({ unsealed: true }) });
  }
}

main().catch(() => {
  process.stderr.write(`${JSON.stringify({ ok: false, errorCode: "DISPOSABLE_FIXTURE_VALIDATION_FAILED" })}\n`);
  process.exitCode = 1;
});
