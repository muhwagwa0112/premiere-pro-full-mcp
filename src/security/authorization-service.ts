import type { ActionDescriptor, ActionRequest, DispatchState } from "../contracts.js";
import type { ExecutionPlan } from "./execution-plan.js";
import { ConfirmationService } from "./confirmation.js";
import { AuthorizationPolicy, type AuthorizationPlan } from "./authorization-policy.js";
import { BrokerTrustProfileStore, type TrustProfileStore } from "./trust-profile-store.js";
import type { AutomationMode, TrustProfile } from "./trust-profile.js";
import { CheckpointBarrierActiveError, SessionLease, type LeaseReservation } from "./session-lease.js";
import { requiredCapabilitiesForAdobeEntry, validateAdobeRuntimeCall } from "../adobe-api-catalog.js";

export type AuthorizationGrant = { reservation: LeaseReservation; profileId: string | null; mode: AutomationMode; checkpointRequired: boolean; checkpointRetention: number };
export interface ExecutionRequirements { checkpointRequired: boolean; checkpointRetention: number }

export class AuthorizationError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export class AuthorizationService {
  readonly mode: AutomationMode;
  readonly #lease: SessionLease;
  readonly #confirmations: ConfirmationService;
  readonly #profile: TrustProfile | null;
  readonly #policy: AuthorizationPolicy | null;

  constructor(options: { mode: AutomationMode; lease: SessionLease; confirmations?: ConfirmationService; profile?: TrustProfile }) {
    this.mode = options.mode; this.#lease = options.lease; this.#confirmations = options.confirmations ?? new ConfirmationService();
    this.#profile = options.profile ?? null;
    if (this.mode !== "interactive" && (!this.#profile || this.#profile.mode !== this.mode)) throw new AuthorizationError("TRUST_PROFILE_MODE_MISMATCH", "Unattended mode requires a validated trust profile with the exact same mode");
    if (this.mode === "interactive" && this.#profile && this.#profile.mode !== "interactive") throw new AuthorizationError("TRUST_PROFILE_MODE_MISMATCH", "Interactive mode cannot use an unattended trust profile");
    this.#policy = this.#profile ? new AuthorizationPolicy(this.#profile) : null;
  }

  approvedRoots(): readonly string[] | undefined { return this.#profile ? [...this.#profile.approvedRoots] : undefined; }

  async executionRequirements(action: ActionDescriptor): Promise<ExecutionRequirements> {
    const checkpointRetention = this.#profile?.checkpoint.retainCount ?? 10;
    if (action.id === "project.checkpoint" || this.mode === "interactive" || !this.#profile || !action.mutatesProject) return { checkpointRequired: false, checkpointRetention };
    const next = await this.#lease.previewNextIndexes(true).catch((error) => { throw leaseAuthorizationError(error); });
    const checkpoint = this.#profile.checkpoint;
    const checkpointRequired = (checkpoint.beforeFirstMutation && next.mutationIndex === 0) ||
      (checkpoint.beforeNonUndoable && !action.undoable) ||
      (next.operationIndex > 0 && next.operationIndex % checkpoint.intervalOperations === 0);
    return { checkpointRequired, checkpointRetention };
  }

  static async createFromEnvironment(options: { store?: TrustProfileStore; confirmations?: ConfirmationService; lease?: SessionLease } = {}): Promise<AuthorizationService> {
    const rawMode = process.env.PREMIERE_MCP_AUTOMATION_MODE ?? "interactive";
    if (!(["interactive", "trusted_unattended", "isolated_lab"] as const).includes(rawMode as AutomationMode)) throw new AuthorizationError("INVALID_AUTOMATION_MODE", "PREMIERE_MCP_AUTOMATION_MODE is invalid");
    const mode = rawMode as AutomationMode;
    const lease = options.lease ?? await SessionLease.createForCurrentProcess();
    if (mode === "interactive") return new AuthorizationService({ mode, lease, ...(options.confirmations ? { confirmations: options.confirmations } : {}) });
    const profileId = process.env.PREMIERE_MCP_TRUST_PROFILE_ID;
    if (!profileId) throw new AuthorizationError("TRUST_PROFILE_REQUIRED", `${mode} requires PREMIERE_MCP_TRUST_PROFILE_ID`);
    let profile: TrustProfile;
    try { profile = await (options.store ?? new BrokerTrustProfileStore()).load(profileId); }
    catch (error) { throw new AuthorizationError("TRUST_PROFILE_LOAD_FAILED", error instanceof Error ? error.message : "Trust profile loading failed"); }
    return new AuthorizationService({ mode, lease, profile, ...(options.confirmations ? { confirmations: options.confirmations } : {}) });
  }

  async preview(action: ActionDescriptor, request: ActionRequest, plan: ExecutionPlan): Promise<Record<string, unknown>> {
    if (this.mode !== "interactive") return { confirmationRequired: false, authorizationMode: this.mode };
    if (action.risk !== "R2" && action.risk !== "R3") return { confirmationRequired: false, authorizationMode: this.mode };
    return { confirmationRequired: true, ...await this.#confirmations.issue(action, request, plan) };
  }

  async authorize(action: ActionDescriptor, request: ActionRequest, plan: ExecutionPlan, paths: readonly string[]): Promise<AuthorizationGrant> {
    const reservation = await this.#lease.reserve(plan.planHash, action.mutatesProject, plan.checkpointRequired).catch((error) => { throw leaseAuthorizationError(error); });
    try {
      if (this.mode === "interactive") {
        if (action.risk === "R2" || action.risk === "R3") {
          if (!request.approvalId) throw new AuthorizationError("CONFIRMATION_REQUIRED", "Preview and approve this exact execution plan before apply");
          await this.#confirmations.consume(action, request, request.approvalId, plan).catch((error) => { throw new AuthorizationError("CONFIRMATION_REJECTED", (error as Error).message); });
        }
        if (plan.checkpointRequired) throw new AuthorizationError("PLAN_CHECKPOINT_DRIFT", "Interactive execution plans cannot request unattended trust-profile checkpoints");
        return { reservation, profileId: null, mode: this.mode, checkpointRequired: false, checkpointRetention: 10 };
      }
      const decision = await this.#policy!.authorize(await toAuthorizationPlan(action, request, paths), {
        leaseId: reservation.leaseId, hostVersion: plan.hostVersion ?? undefined, operationIndex: reservation.operationIndex,
        ...(reservation.mutationIndex === null ? {} : { mutationIndex: reservation.mutationIndex }),
        elapsedRuntimeMinutes: reservation.elapsedRuntimeMinutes,
      });
      if (decision.outcome !== "allow" && decision.outcome !== "allow_with_checkpoint") {
        const code = decision.outcome === "deny" ? decision.code : "AUTHORIZATION_MODE_MISMATCH";
        throw new AuthorizationError(code, decision.reason);
      }
      const checkpointRequired = decision.outcome === "allow_with_checkpoint";
      if (checkpointRequired !== plan.checkpointRequired) {
        throw new AuthorizationError("PLAN_CHECKPOINT_DRIFT", "Checkpoint policy changed after the execution plan was prepared; preview and prepare the exact current plan again");
      }
      return { reservation, profileId: decision.profileId, mode: this.mode, checkpointRequired, checkpointRetention: this.#profile!.checkpoint.retainCount };
    } catch (error) {
      this.#lease.release(reservation.reservationId, "not_dispatched");
      throw error;
    }
  }

  markDispatched(grant: AuthorizationGrant): void { this.#lease.markDispatched(grant.reservation.reservationId); }
  async completeCheckpoint(grant: AuthorizationGrant): Promise<void> {
    if (!grant.checkpointRequired) throw new AuthorizationError("CHECKPOINT_NOT_REQUIRED", "The authorization grant does not own a checkpoint barrier");
    try { await this.#lease.completeCheckpoint(grant.reservation.reservationId, grant.reservation.planHash); }
    catch (error) { throw leaseAuthorizationError(error); }
  }
  markCheckpointOutcomeUnknown(grant: AuthorizationGrant): void {
    if (!grant.checkpointRequired) throw new AuthorizationError("CHECKPOINT_NOT_REQUIRED", "The authorization grant does not own a checkpoint barrier");
    try { this.#lease.markCheckpointOutcomeUnknown(grant.reservation.reservationId); }
    catch (error) { throw leaseAuthorizationError(error); }
  }
  async revalidateForDispatch(grant: AuthorizationGrant): Promise<void> {
    try { await this.#lease.revalidateForDispatch(grant.reservation.reservationId, grant.reservation.planHash); }
    catch (error) { throw new AuthorizationError("SESSION_LEASE_INVALID", (error as Error).message); }
  }
  release(grant: AuthorizationGrant, dispatchState: DispatchState): void { this.#lease.release(grant.reservation.reservationId, dispatchState); }
}

function leaseAuthorizationError(error: unknown): AuthorizationError {
  return error instanceof CheckpointBarrierActiveError
    ? new AuthorizationError(error.code, error.message)
    : new AuthorizationError("SESSION_LEASE_INVALID", error instanceof Error ? error.message : "Session lease validation failed");
}

async function toAuthorizationPlan(action: ActionDescriptor, request: ActionRequest, paths: readonly string[]): Promise<AuthorizationPlan> {
  const adobeEntry = await validateAdobeRuntimeCall(action.id, request.args);
  const requiredCapabilities = new Set(requiredCapabilitiesForAdobeEntry(adobeEntry));
  return {
    actionId: action.id, risk: action.risk, authority: action.authority, paths: [...paths], mutation: action.mutatesProject,
    nonUndoable: action.mutatesProject && !action.undoable,
    overwrite: request.args.overwrite === true || requiredCapabilities.has("overwrite"),
    delete: request.args.delete === true || requiredCapabilities.has("delete"),
    thirdPartyPluginUi: request.args.thirdPartyPluginUi === true, cloudPublish: request.args.cloudPublish === true,
    cloudShare: request.args.cloudShare === true, purchase: request.args.purchase === true,
  };
}
