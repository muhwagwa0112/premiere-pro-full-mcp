import { z } from "zod";

export const backendSchema = z.enum(["local", "uxp", "cep", "qe", "ui"]);
export type Backend = z.infer<typeof backendSchema>;

export const riskSchema = z.enum(["R0", "R1", "R2", "R3"]);
export type Risk = z.infer<typeof riskSchema>;

export const domainSchema = z.enum([
  "api",
  "inspection",
  "project",
  "media",
  "timeline",
  "effects_audio",
  "text_captions",
  "export",
  "workspace",
  "plugins",
  "cloud",
]);
export type ActionDomain = z.infer<typeof domainSchema>;

export const authoritySchema = z.enum([
  "inspect",
  "edit",
  "filesystem",
  "experimental",
  "cloud",
]);
export type Authority = z.infer<typeof authoritySchema>;

export const supportStatusSchema = z.enum([
  "verified",
  "implemented_unverified",
  "experimental",
  "ui_fallback",
  "entitlement_blocked",
  "manual_only",
  "unsupported",
]);
export type SupportStatus = z.infer<typeof supportStatusSchema>;

export interface ActionDescriptor {
  id: string;
  domain: ActionDomain;
  title: string;
  description: string;
  risk: Risk;
  authority: Authority;
  preferredBackends: Backend[];
  minimumPremiereVersion: string;
  mutatesProject: boolean;
  undoable: boolean;
  verification: string;
  support: SupportStatus;
  argsSchema: z.ZodType<Record<string, unknown>>;
}

const jsonRecordSchema = z.record(z.string(), z.unknown());

export const actionRequestSchema = z.object({
  actionId: z.string().min(3).max(128),
  target: jsonRecordSchema.optional(),
  args: jsonRecordSchema.default({}),
  operationId: z.uuid().optional(),
  expectedRevision: z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/).optional(),
  approvalId: z.uuid().optional(),
}).strict();

export type ActionRequest = z.infer<typeof actionRequestSchema>;

export const operationStatusSchema = z.enum([
  "planned",
  "confirmation_required",
  "dispatched",
  "succeeded",
  "failed",
  "cancelled",
  "blocked",
]);
export type OperationStatus = z.infer<typeof operationStatusSchema>;

export interface VerificationEvidence {
  outcome: "verified" | "committed_unverified" | "not_applicable" | "failed";
  method: string;
  detail?: string;
}

export interface OperationResult {
  operationId: string;
  actionId: string;
  status: OperationStatus;
  backend: Backend | null;
  hostVersion: string | null;
  risk: Risk;
  beforeRevision: string | null;
  afterRevision: string | null;
  verification: VerificationEvidence;
  undo: { available: boolean; method: string | null };
  createdFiles: Array<{ name: string; verified: boolean }>;
  warnings: string[];
  data?: unknown;
  error?: { code: string; message: string; retryable: boolean };
}

export interface BridgeRequest {
  protocolVersion: 1;
  requestId: string;
  operation: string;
  args: Record<string, unknown>;
  expectedRevision?: string;
}

export interface BridgeResponse {
  protocolVersion: 1;
  requestId: string;
  ok: boolean;
  hostVersion?: string;
  beforeRevision?: string;
  afterRevision?: string;
  verification?: VerificationEvidence;
  createdFiles?: Array<{ name: string; verified: boolean }>;
  result?: unknown;
  error?: { code: string; message: string; retryable?: boolean };
}

export interface BackendAdapter {
  readonly backend: Backend;
  availability(): Promise<{ available: boolean; reason?: string; hostVersion?: string }>;
  execute(request: BridgeRequest): Promise<BridgeResponse>;
  close?(): Promise<void>;
}

export function riskNeedsConfirmation(risk: Risk): boolean {
  return risk === "R2" || risk === "R3";
}
