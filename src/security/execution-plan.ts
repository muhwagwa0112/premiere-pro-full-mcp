import { createHash } from "node:crypto";
import { z } from "zod";
import type { ActionDescriptor, ActionRequest, BackendProbe, BridgeRequest, RouteBinding } from "../contracts.js";

const jsonPrimitive = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
type StrictJson = z.infer<typeof jsonPrimitive> | StrictJson[] | { [key: string]: StrictJson };

export function strictCanonicalJson(value: unknown): string {
  return canonicalize(value, new Set());
}

function canonicalize(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Execution plan JSON contains a non-finite number");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value !== "object") throw new Error(`Execution plan JSON contains unsupported ${typeof value}`);
  if (seen.has(value)) throw new Error("Execution plan JSON contains a cycle");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) throw new Error("Execution plan JSON contains a sparse array");
      return `[${value.map((item) => canonicalize(item, seen)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Execution plan JSON must contain only plain objects");
    if (Object.getOwnPropertySymbols(value).length > 0) throw new Error("Execution plan JSON contains symbol keys");
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], seen)}`).join(",")}}`;
  } finally { seen.delete(value); }
}

const nullableText = z.string().max(512).nullable();
export const executionPlanSchema = z.object({
  schemaVersion: z.literal(1), planId: z.uuid(), operationId: z.uuid(), jobId: z.uuid().nullable(),
  actionId: z.string().min(1).max(256), backend: z.enum(["local", "uxp", "cep", "qe", "ui"]),
  hostVersion: nullableText, hostSessionId: nullableText, capabilityFingerprint: nullableText,
  risk: z.enum(["R0", "R1", "R2", "R3"]), normalizedRequestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  effectiveRequestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  approvedRootDigests: z.array(z.string().regex(/^sha256:[a-f0-9]{64}$/)).max(100), expectedStateToken: nullableText,
  preconditions: z.array(z.string().max(512)).max(256), verification: z.array(z.string().min(1).max(512)).min(1).max(256),
  checkpointRequired: z.boolean(), planHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();
export type ExecutionPlan = z.infer<typeof executionPlanSchema>;

export function sha256Canonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(strictCanonicalJson(value), "utf8").digest("hex")}`;
}

export function effectiveBridgeRequestDigest(operation: string, args: Record<string, unknown>, expectedRevision?: string): string {
  return sha256Canonical({ operation, args, expectedRevision: expectedRevision ?? null });
}

export function hasValidEffectiveRequestBinding(request: BridgeRequest): boolean {
  return typeof request.effectiveRequestDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(request.effectiveRequestDigest) &&
    request.effectiveRequestDigest === effectiveBridgeRequestDigest(request.operation, request.args, request.expectedRevision);
}

export function routeBindingFromProbe(probe: BackendProbe): RouteBinding {
  return {
    backend: probe.backend, hostVersion: probe.hostVersion ?? null, hostSessionId: probe.hostSessionId ?? null,
    capabilityFingerprint: probe.capabilityFingerprint ?? null,
  };
}

export function sameRouteBinding(left: RouteBinding, right: RouteBinding): boolean {
  return strictCanonicalJson(left) === strictCanonicalJson(right);
}

export function buildExecutionPlan(input: {
  action: ActionDescriptor; request: ActionRequest; probe: BackendProbe; approvedRootDigests: readonly string[];
  preconditions?: readonly string[]; checkpointRequired?: boolean; effectiveArgs?: Record<string, unknown>;
}): ExecutionPlan {
  if (!input.request.operationId) throw new Error("Execution planning requires an operationId");
  const binding = routeBindingFromProbe(input.probe);
  const material = {
    schemaVersion: 1 as const, planId: input.request.operationId, operationId: input.request.operationId, jobId: null,
    actionId: input.action.id, ...binding, risk: input.action.risk,
    normalizedRequestDigest: sha256Canonical({
      actionId: input.request.actionId, target: input.request.target ?? null, args: input.request.args,
      expectedRevision: input.request.expectedRevision ?? null,
    }),
    effectiveRequestDigest: effectiveBridgeRequestDigest(input.action.id, input.effectiveArgs ?? input.request.args, input.request.expectedRevision),
    approvedRootDigests: [...input.approvedRootDigests].sort(), expectedStateToken: input.request.expectedRevision ?? null,
    preconditions: [...(input.preconditions ?? [])].sort(), verification: [input.action.verification],
    checkpointRequired: input.checkpointRequired ?? false,
  };
  return executionPlanSchema.parse({ ...material, planHash: sha256Canonical(material) });
}

export function verifyExecutionPlan(plan: ExecutionPlan): boolean {
  const parsed = executionPlanSchema.parse(plan);
  const { planHash, ...material } = parsed;
  return planHash === sha256Canonical(material);
}
