import { createHash, randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import type { ActionDescriptor, ActionRequest } from "../contracts.js";
import { brokerProtect, brokerSign, brokerUnprotect, brokerVerify } from "./hmac-broker.js";
import { canonicalJson } from "./signed-envelope.js";
import type { ExecutionPlan } from "./execution-plan.js";

interface ApprovalPayload {
  version: 2;
  approvalId: string;
  state: "pending" | "approved";
  operationId: string;
  actionId: string;
  requestDigest: string;
  planHash: string;
  route: { backend: string; hostVersion: string | null; hostSessionId: string | null; capabilityFingerprint: string | null };
  request: {
    actionId: string;
    target: Record<string, unknown> | null;
    args: Record<string, unknown>;
    expectedRevision: string | null;
  };
  summary: {
    title: string;
    risk: string;
    mutatesProject: boolean;
    undoable: boolean;
    backend: string;
  };
  issuedAt: number;
  expiresAt: number;
  approvedAt: number | null;
  nonce: string;
}

interface ApprovalEnvelope { payload: string; signature: string }

export interface ApprovalAuthenticator {
  sign(message: string): Promise<string>;
  verify(message: string, signature: string): Promise<boolean>;
  protect(message: string): Promise<string>;
  unprotect(ciphertext: string): Promise<string>;
}

const brokerAuthenticator: ApprovalAuthenticator = {
  sign: (message) => brokerSign("approval-hmac", message),
  verify: (message, signature) => brokerVerify("approval-hmac", message, signature),
  protect: brokerProtect,
  unprotect: brokerUnprotect,
};

function defaultApprovalDirectory(): string {
  const localAppData = process.env.LOCALAPPDATA;
  return join(localAppData && localAppData.length > 0 ? localAppData : join(homedir(), "AppData", "Local"), "PremiereMCP", "approvals");
}

function installedHelperPath(): string {
  const localAppData = process.env.LOCALAPPDATA;
  const base = localAppData && localAppData.length > 0 ? localAppData : join(homedir(), "AppData", "Local");
  return join(base, "PremiereMCP", "bin", "PremiereMcp.WindowsUiAgent.exe");
}

function requestSnapshot(request: ActionRequest): ApprovalPayload["request"] {
  return { actionId: request.actionId, target: request.target ?? null, args: request.args, expectedRevision: request.expectedRevision ?? null };
}

function requestDigest(request: ActionRequest): string {
  return createHash("sha256").update(canonicalJson(requestSnapshot(request))).digest("base64url");
}

function approvalPath(directory: string, approvalId: string, state: "pending" | "approved"): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(approvalId)) throw new Error("Invalid approval id");
  return join(directory, `${state}-${approvalId}.json`);
}

async function readEnvelope(path: string): Promise<ApprovalEnvelope> {
  const raw = await readFile(path, "utf8");
  if (Buffer.byteLength(raw, "utf8") > 256 * 1024) throw new Error("Approval record is too large");
  const value = JSON.parse(raw) as Partial<ApprovalEnvelope>;
  if (typeof value.payload !== "string" || typeof value.signature !== "string") throw new Error("Approval envelope is malformed");
  return { payload: value.payload, signature: value.signature };
}

async function writeAtomic(path: string, value: ApprovalEnvelope): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { await rename(temporary, path); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}

export class ConfirmationService {
  readonly #directory: string;
  readonly #authenticate: ApprovalAuthenticator;

  constructor(directory = defaultApprovalDirectory(), authenticate: ApprovalAuthenticator = brokerAuthenticator) {
    this.#directory = directory;
    this.#authenticate = authenticate;
  }

  async issue(action: ActionDescriptor, request: ActionRequest, plan: ExecutionPlan, ttlMs = 5 * 60_000): Promise<{ approvalId: string; expiresAt: string; summary: Record<string, unknown>; approvalCommand: string }> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("Confirmation TTL must be a positive integer");
    const binding = confirmationBinding(plan);
    const planHash = binding.planHash;
    if (!/^sha256:[a-f0-9]{64}$/.test(planHash)) throw new Error("Confirmation requires a valid planHash");
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await this.cleanupStaleRecords();
    const now = Date.now();
    const approvalId = randomUUID();
    const payload: ApprovalPayload = {
      version: 2, approvalId, state: "pending", operationId: binding.operationId, actionId: action.id, requestDigest: requestDigest(request), planHash, route: binding.route, request: requestSnapshot(request),
      summary: { title: action.title, risk: action.risk, mutatesProject: action.mutatesProject, undoable: action.undoable, backend: binding.route.backend },
      issuedAt: now, expiresAt: now + ttlMs, approvedAt: null, nonce: randomBytes(18).toString("base64url"),
    };
    const protectedPayload = await this.#authenticate.protect(canonicalJson(payload));
    await writeAtomic(approvalPath(this.#directory, approvalId, "pending"), { payload: protectedPayload, signature: await this.#authenticate.sign(protectedPayload) });
    return { approvalId, expiresAt: new Date(payload.expiresAt).toISOString(), summary: { actionId: action.id, ...payload.summary }, approvalCommand: `& '${installedHelperPath().replaceAll("'", "''")}' --approval approve ${approvalId}` };
  }

  async consume(action: ActionDescriptor, request: ActionRequest, approvalId: string, plan: ExecutionPlan): Promise<void> {
    const binding = confirmationBinding(plan);
    await this.cleanupStaleRecords();
    const approvedPath = approvalPath(this.#directory, approvalId, "approved");
    const claimedPath = join(this.#directory, `claimed-${approvalId}-${randomUUID()}.json`);
    // Claim before any asynchronous verification. rename() is the one-shot arbitration
    // point: exactly one concurrent consumer can move the approved record away.
    await rename(approvedPath, claimedPath);
    try {
      const envelope = await readEnvelope(claimedPath);
      if (!await this.#authenticate.verify(envelope.payload, envelope.signature)) throw new Error("Approval signature is invalid");
      const payload = JSON.parse(await this.#authenticate.unprotect(envelope.payload)) as ApprovalPayload;
      if (payload.version !== 2 || payload.state !== "approved" || payload.approvalId !== approvalId) throw new Error("Approval is not a supported v2 approved record");
      if (payload.expiresAt < Date.now()) throw new Error("Approval has expired");
      if (payload.actionId !== action.id) throw new Error("Approval is for a different action");
      if (payload.operationId !== binding.operationId || payload.planHash !== binding.planHash || canonicalJson(payload.route) !== canonicalJson(binding.route)) throw new Error("Approval does not match this exact execution plan and route");
      if (payload.requestDigest !== requestDigest(request)) throw new Error("Approval does not match this exact request");
      if (payload.request.expectedRevision !== (request.expectedRevision ?? null)) throw new Error("Approval revision mismatch");
    } finally {
      await rm(claimedPath, { force: true });
    }
  }

  private async cleanupStaleRecords(maxAgeMs = 10 * 60_000): Promise<void> {
    const cutoff = Date.now() - maxAgeMs;
    for (const name of await readdir(this.#directory).catch(() => [] as string[])) {
      if (!/^(pending|approved|claimed)-[0-9a-f-]+(?:-[0-9a-f-]+)?\.json(?:\..+\.tmp)?$/i.test(name) && !/\.tmp$/i.test(name)) continue;
      const path = join(this.#directory, name);
      const metadata = await stat(path).catch(() => null);
      if (metadata?.isFile() && metadata.mtimeMs < cutoff) await rm(path, { force: true });
    }
  }
}

function confirmationBinding(plan: ExecutionPlan): Pick<ApprovalPayload, "operationId" | "planHash" | "route"> {
  return {
    operationId: plan.operationId, planHash: plan.planHash,
    route: { backend: plan.backend, hostVersion: plan.hostVersion, hostSessionId: plan.hostSessionId, capabilityFingerprint: plan.capabilityFingerprint },
  };
}
