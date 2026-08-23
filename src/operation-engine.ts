import { randomUUID } from "node:crypto";
import { actionRequestSchema, riskNeedsConfirmation, type ActionRequest, type Authority, type Backend, type BackendAdapter, type OperationResult } from "./contracts.js";
import { getAction, listActions, validateActionArgs } from "./catalog.js";
import { ConfirmationService } from "./security/confirmation.js";
import { OperationLedger } from "./ledger.js";
import { readFile, stat } from "node:fs/promises";
import { PathPolicy } from "./security/path-policy.js";
import { pathArgumentsForEntry, validateAdobeRuntimeCall } from "./adobe-api-catalog.js";

interface AdobeInventorySummary {
  source: unknown;
  fingerprint: string;
  counts: unknown;
}

async function adobeInventorySummary(): Promise<AdobeInventorySummary | { status: "not_generated" }> {
  try {
    const parsed = JSON.parse(await readFile(new URL("../generated/adobe-uxp-api.json", import.meta.url), "utf8")) as AdobeInventorySummary;
    return { source: parsed.source, fingerprint: parsed.fingerprint, counts: parsed.counts };
  } catch {
    return { status: "not_generated" };
  }
}

function enabledAuthorities(): Set<Authority> {
  const configured = process.env.PREMIERE_MCP_AUTHORITIES ?? "inspect,edit,filesystem,experimental,cloud";
  const allowed: Authority[] = ["inspect", "edit", "filesystem", "experimental", "cloud"];
  return new Set(configured.split(",").map((item) => item.trim()).filter((item): item is Authority => allowed.includes(item as Authority)));
}

async function assertOutputPolicy(actionId: string, args: Record<string, unknown>): Promise<void> {
  if (actionId !== "export.sequence" || args.overwrite === true || typeof args.outputPath !== "string") return;
  try {
    const existing = await stat(args.outputPath);
    if (existing.isFile() || existing.isDirectory()) throw new Error("Sequence export refused to overwrite an existing output path");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export class OperationEngine {
  readonly #adapters: Map<Backend, BackendAdapter>;
  readonly #confirmations: ConfirmationService;
  readonly #ledger: OperationLedger;
  readonly #authorities: Set<Authority>;
  readonly #pathPolicy: PathPolicy;

  constructor(adapters: BackendAdapter[], options: { confirmations?: ConfirmationService; ledger?: OperationLedger; authorities?: Set<Authority>; pathPolicy?: PathPolicy } = {}) {
    this.#adapters = new Map(adapters.map((adapter) => [adapter.backend, adapter]));
    this.#confirmations = options.confirmations ?? new ConfirmationService();
    this.#ledger = options.ledger ?? new OperationLedger();
    this.#authorities = options.authorities ?? enabledAuthorities();
    this.#pathPolicy = options.pathPolicy ?? new PathPolicy();
  }

  async capabilities(): Promise<Record<string, unknown>> {
    const backendEntries = await Promise.all([...this.#adapters.entries()].map(async ([backend, adapter]) => {
      const availability = await adapter.availability();
      return [backend, availability] as const;
    }));
    const backends = Object.fromEntries(backendEntries);
    return {
      server: { name: "premiere-pro-full-mcp", version: "0.2.0", transport: "stdio" },
      target: { product: "Adobe Premiere Pro 2026", version: "26.3.2", platform: "win32" },
      authorities: [...this.#authorities].sort(),
      backends,
      adobeUxpInventory: await adobeInventorySummary(),
      actions: listActions().map((action) => ({
        id: action.id,
        domain: action.domain,
        title: action.title,
        risk: action.risk,
        authority: action.authority,
        preferredBackends: action.preferredBackends,
        support: action.support,
        mutatesProject: action.mutatesProject,
        undoable: action.undoable,
        minimumPremiereVersion: action.minimumPremiereVersion,
        verification: action.verification,
        enabled: this.#authorities.has(action.authority),
      })),
      fallbackPolicy: "Select an available backend before dispatch. Never replay a failed mutation through another backend.",
      liveHostClaims: "unverified_until_exercised",
    };
  }

  async preview(input: unknown): Promise<Record<string, unknown>> {
    const request = this.normalizeRequest(input);
    const action = getAction(request.actionId);
    this.assertAuthority(action.authority);
    const args = validateActionArgs(action, request.args);
    await validateAdobeRuntimeCall(action.id, args);
    if (!riskNeedsConfirmation(action.risk)) {
      return { confirmationRequired: false, actionId: action.id, risk: action.risk, message: "This R0/R1 action may execute directly." };
    }
    const issued = await this.#confirmations.issue(action, request);
    return { confirmationRequired: true, ...issued };
  }

  async execute(input: unknown): Promise<OperationResult> {
    let request: ActionRequest;
    try {
      request = this.normalizeRequest(input);
    } catch (error) {
      return this.invalidRequestResult(input, error as Error);
    }
    const operationId = request.operationId ?? randomUUID();
    let action;
    try {
      action = getAction(request.actionId);
      this.assertAuthority(action.authority);
      request = { ...request, args: validateActionArgs(action, request.args), operationId };
      const adobeEntry = await validateAdobeRuntimeCall(action.id, request.args);
      await this.#pathPolicy.assert(action, pathArgumentsForEntry(adobeEntry, request.args));
      await assertOutputPolicy(action.id, request.args);
      if (action.authority !== "filesystem" && Array.isArray(request.args.paths) && request.args.paths.length > 0) {
        await this.#pathPolicy.assert({ ...action, authority: "filesystem" }, { paths: request.args.paths });
      }
    } catch (error) {
      return this.failureResult(operationId, request.actionId, "R0", null, "REQUEST_REJECTED", (error as Error).message, false);
    }

    const previous = await this.#ledger.get(operationId);
    if (previous) {
      return this.failureResult(operationId, action.id, action.risk, previous.backend, "DUPLICATE_OPERATION", `operationId already recorded with status ${previous.status}`, false, "blocked");
    }

    if (riskNeedsConfirmation(action.risk)) {
      if (!request.approvalId) {
        return this.failureResult(operationId, action.id, action.risk, null, "CONFIRMATION_REQUIRED", "Preview this exact request, approve it in a local interactive terminal, then apply it with approvalId", false, "confirmation_required");
      }
    }

    const unavailable: string[] = [];
    let selected: { backend: Backend; adapter: BackendAdapter; hostVersion?: string } | null = null;
    for (const backend of action.preferredBackends) {
      const adapter = this.#adapters.get(backend);
      if (!adapter) {
        unavailable.push(`${backend}: adapter not configured`);
        continue;
      }
      const status = await adapter.availability();
      if (status.available) {
        selected = status.hostVersion ? { backend, adapter, hostVersion: status.hostVersion } : { backend, adapter };
        break;
      }
      unavailable.push(`${backend}: ${status.reason ?? "unavailable"}`);
    }
    if (!selected) {
      const blocked = this.failureResult(operationId, action.id, action.risk, null, "NO_BACKEND_AVAILABLE", unavailable.join("; "), true, "blocked");
      await this.record(blocked);
      return blocked;
    }

    // Availability is checked before consuming a one-shot approval. A transient bridge
    // disconnect must not force the user to approve the exact same operation again.
    if (riskNeedsConfirmation(action.risk)) {
      try {
        await this.#confirmations.consume(action, request, request.approvalId!);
      } catch (error) {
        return this.failureResult(operationId, action.id, action.risk, null, "CONFIRMATION_REJECTED", (error as Error).message, false, "blocked");
      }
    }

    await this.#ledger.record({
      operationId,
      actionId: action.id,
      backend: selected.backend,
      risk: action.risk,
      status: "dispatched",
      timestamp: new Date().toISOString(),
      verificationOutcome: "pending",
      beforeRevision: request.expectedRevision ?? null,
      afterRevision: null,
    });

    try {
      const response = await selected.adapter.execute({
        protocolVersion: 1,
        requestId: operationId,
        operation: action.id,
        args: request.args,
        ...(request.expectedRevision ? { expectedRevision: request.expectedRevision } : {}),
      });
      const result: OperationResult = response.ok
        ? {
            operationId,
            actionId: action.id,
            status: "succeeded",
            backend: selected.backend,
            hostVersion: response.hostVersion ?? selected.hostVersion ?? null,
            risk: action.risk,
            beforeRevision: response.beforeRevision ?? request.expectedRevision ?? null,
            afterRevision: response.afterRevision ?? null,
            verification: response.verification ?? { outcome: action.mutatesProject ? "committed_unverified" : "not_applicable", method: action.verification },
            undo: { available: action.undoable, method: action.undoable ? "Premiere undo history" : null },
            createdFiles: response.createdFiles ?? [],
            warnings: response.verification?.outcome === "committed_unverified" ? ["Host accepted the operation, but its full postcondition was not verified."] : [],
            data: response.result,
          }
        : this.isOutcomeSensitive(action) && (response.error?.retryable ?? false)
          ? this.outcomeUnknownResult(operationId, action.id, action.risk, selected.backend, response.error?.message ?? "The host may have accepted the operation before the bridge failed")
          : this.failureResult(operationId, action.id, action.risk, selected.backend, response.error?.code ?? "BRIDGE_ERROR", response.error?.message ?? "Bridge request failed", response.error?.retryable ?? false);
      await this.record(result);
      return result;
    } catch (error) {
      const result = this.isOutcomeSensitive(action)
        ? this.outcomeUnknownResult(operationId, action.id, action.risk, selected.backend, (error as Error).message)
        : this.failureResult(operationId, action.id, action.risk, selected.backend, "BRIDGE_EXCEPTION", (error as Error).message, true);
      await this.record(result);
      return result;
    }
  }

  async status(operationId: string): Promise<Record<string, unknown>> {
    const record = await this.#ledger.get(operationId);
    return record ? { ...record } : { operationId, status: "not_found" };
  }

  private normalizeRequest(input: unknown): ActionRequest {
    return actionRequestSchema.parse(input);
  }

  private assertAuthority(authority: Authority): void {
    if (!this.#authorities.has(authority)) throw new Error(`Authority '${authority}' is disabled`);
  }

  private invalidRequestResult(input: unknown, error: Error): OperationResult {
    const actionId = typeof input === "object" && input && "actionId" in input && typeof (input as { actionId?: unknown }).actionId === "string"
      ? (input as { actionId: string }).actionId
      : "unknown";
    return this.failureResult(randomUUID(), actionId, "R0", null, "INVALID_REQUEST", error.message, false);
  }

  private failureResult(operationId: string, actionId: string, risk: "R0" | "R1" | "R2" | "R3", backend: Backend | null, code: string, message: string, retryable: boolean, status: "failed" | "blocked" | "confirmation_required" = "failed"): OperationResult {
    return {
      operationId,
      actionId,
      status,
      backend,
      hostVersion: null,
      risk,
      beforeRevision: null,
      afterRevision: null,
      verification: { outcome: "failed", method: "none", detail: message },
      undo: { available: false, method: null },
      createdFiles: [],
      warnings: [],
      error: { code, message, retryable },
    };
  }

  private isOutcomeSensitive(action: { mutatesProject: boolean; authority: Authority; risk: "R0" | "R1" | "R2" | "R3" }): boolean {
    return action.mutatesProject || action.authority === "filesystem" || action.authority === "cloud" || action.risk === "R2" || action.risk === "R3";
  }

  private outcomeUnknownResult(operationId: string, actionId: string, risk: "R0" | "R1" | "R2" | "R3", backend: Backend, detail: string): OperationResult {
    return {
      operationId,
      actionId,
      status: "failed",
      backend,
      hostVersion: null,
      risk,
      beforeRevision: null,
      afterRevision: null,
      verification: { outcome: "committed_unverified", method: "bridge outcome unavailable after dispatch", detail },
      undo: { available: false, method: null },
      createdFiles: [],
      warnings: ["The host outcome is unknown. Inspect Premiere and output files before any manual retry; never retry this operation automatically."],
      error: { code: "OUTCOME_UNKNOWN", message: "The operation may have committed before the bridge failed. Inspect host state before retrying.", retryable: false },
    };
  }

  private async record(result: OperationResult): Promise<void> {
    await this.#ledger.record({
      operationId: result.operationId,
      actionId: result.actionId,
      backend: result.backend,
      risk: result.risk,
      status: result.status,
      timestamp: new Date().toISOString(),
      verificationOutcome: result.verification.outcome,
      beforeRevision: result.beforeRevision,
      afterRevision: result.afterRevision,
    });
  }
}
