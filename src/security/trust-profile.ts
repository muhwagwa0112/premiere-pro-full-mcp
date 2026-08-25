import { z } from "zod";

export const automationModes = ["interactive", "trusted_unattended", "isolated_lab", "watch"] as const;
export const riskLevels = ["R0", "R1", "R2", "R3"] as const;

const capabilitySchema = z.object({
  overwrite: z.boolean(),
  delete: z.boolean(),
  thirdPartyPluginUi: z.boolean(),
  cloudPublish: z.boolean(),
  cloudShare: z.boolean(),
  purchase: z.boolean(),
}).strict();

const checkpointSchema = z.object({
  beforeFirstMutation: z.boolean(),
  beforeNonUndoable: z.boolean(),
  intervalOperations: z.number().int().min(1).max(1_000),
  retainCount: z.number().int().min(1).max(100),
}).strict();

export const trustProfileSchema = z.object({
  schemaVersion: z.literal(1),
  profileId: z.string().regex(/^[A-Za-z0-9._-]{3,64}$/),
  mode: z.enum(automationModes),
  premiereVersions: z.array(z.string().min(1).max(64)).min(1).max(100).optional(),
  riskCeiling: z.enum(riskLevels),
  actionAllow: z.array(z.string().min(1).max(256)).max(1_000).default(["*"]),
  actionDeny: z.array(z.string().min(1).max(256)).max(1_000).default([]),
  approvedRoots: z.array(z.string().min(3).max(32_767)).min(1).max(100),
  capabilities: capabilitySchema,
  checkpoint: checkpointSchema,
  limits: z.object({
    maxOperations: z.number().int().min(1),
    maxRuntimeMinutes: z.number().int().min(1),
  }).strict().optional(),
  unexpectedModalPolicy: z.enum(["pause_and_report", "fail", "known_adapter_only"]).optional(),
}).strict();

export type AutomationMode = z.infer<typeof trustProfileSchema>["mode"];
export type RiskLevel = z.infer<typeof trustProfileSchema>["riskCeiling"];
export type TrustProfile = z.infer<typeof trustProfileSchema>;

export function parseTrustProfile(value: unknown): TrustProfile {
  return trustProfileSchema.parse(value);
}
