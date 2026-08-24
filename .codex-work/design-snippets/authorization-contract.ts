export type AutomationMode = "interactive" | "trusted_unattended" | "isolated_lab";

export type AuthorizationDecision =
  | { outcome: "allow"; profileId: string; leaseId: string }
  | { outcome: "allow_with_checkpoint"; profileId: string; leaseId: string }
  | { outcome: "interactive_required"; reason: string }
  | { outcome: "deny"; code: string; reason: string };

export interface AuthorizationService {
  authorize(plan: Record<string, unknown>, lease: Record<string, unknown>): Promise<AuthorizationDecision>;
}
