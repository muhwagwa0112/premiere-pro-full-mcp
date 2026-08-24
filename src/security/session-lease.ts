import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { DispatchState } from "../contracts.js";
import { brokerSign, brokerVerify } from "./hmac-broker.js";
import { strictCanonicalJson } from "./execution-plan.js";

const leasePayloadSchema = z.object({
  version: z.literal(1), leaseId: z.uuid(), pid: z.number().int().positive(), processStartTime: z.number().finite().positive(),
  launcherChain: z.literal("broker-verified-pinned-node"), issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
}).strict();
export type SessionLeasePayload = z.infer<typeof leasePayloadSchema>;

export interface LeaseAuthenticator {
  sign(message: string): Promise<string>;
  verify(message: string, signature: string): Promise<boolean>;
}
const brokerAuthenticator: LeaseAuthenticator = {
  sign: (message) => brokerSign("lease-hmac", message), verify: (message, signature) => brokerVerify("lease-hmac", message, signature),
};

export interface LeaseReservation { leaseId: string; reservationId: string; planHash: string; operationIndex: number; mutationIndex: number | null; elapsedRuntimeMinutes: number }
export interface LeaseIndexPreview { operationIndex: number; mutationIndex: number | null; elapsedRuntimeMinutes: number }

export class CheckpointBarrierActiveError extends Error {
  readonly code = "CHECKPOINT_BARRIER_ACTIVE";
  constructor(message = "A trusted mutation checkpoint barrier is active") { super(message); }
}

export class SessionLease {
  readonly payload: SessionLeasePayload;
  readonly signature: string;
  readonly #authenticate: LeaseAuthenticator;
  readonly #now: () => number;
  readonly #currentPid: () => number;
  readonly #currentProcessStart: () => number;
  readonly #reservations = new Map<string, { planHash: string; dispatched: boolean; operationIndex: number; mutationIndex: number | null; checkpointRequired: boolean; checkpointCompleted: boolean }>();
  readonly #releasedOperationIndexes: number[] = [];
  readonly #releasedMutationIndexes: number[] = [];
  #nextOperationIndex = 0;
  #nextMutationIndex = 0;
  #checkpointBarrierReservationId: string | null = null;

  private constructor(payload: SessionLeasePayload, signature: string, authenticate: LeaseAuthenticator, options: { now: () => number; currentPid: () => number; currentProcessStart: () => number }) {
    this.payload = payload; this.signature = signature; this.#authenticate = authenticate; this.#now = options.now;
    this.#currentPid = options.currentPid; this.#currentProcessStart = options.currentProcessStart;
  }

  static async createForCurrentProcess(options: {
    ttlMs?: number; authenticate?: LeaseAuthenticator; now?: () => number; pid?: number; processStartTime?: number;
  } = {}): Promise<SessionLease> {
    const now = options.now ?? Date.now;
    const pid = options.pid ?? process.pid;
    const processStartTime = options.processStartTime ?? performance.timeOrigin;
    const issuedAt = Math.trunc(now());
    const ttlMs = options.ttlMs ?? 60 * 60_000;
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error("Session lease TTL must be a positive integer");
    const payload = leasePayloadSchema.parse({ version: 1, leaseId: randomUUID(), pid, processStartTime, launcherChain: "broker-verified-pinned-node", issuedAt, expiresAt: issuedAt + ttlMs });
    const authenticate = options.authenticate ?? brokerAuthenticator;
    const signature = await authenticate.sign(strictCanonicalJson(payload));
    return new SessionLease(payload, signature, authenticate, { now, currentPid: () => options.pid ?? process.pid, currentProcessStart: () => options.processStartTime ?? performance.timeOrigin });
  }

  async reserve(planHash: string, mutation = false, checkpointRequired = false): Promise<LeaseReservation> {
    await this.assertValid();
    if (!/^sha256:[a-f0-9]{64}$/.test(planHash)) throw new Error("Session lease reservation requires a valid planHash");
    if (checkpointRequired && !mutation) throw new Error("Only a mutation reservation may own a checkpoint barrier");
    if (mutation && this.#checkpointBarrierReservationId) throw new CheckpointBarrierActiveError();
    if ([...this.#reservations.values()].some((reservation) => reservation.planHash === planHash)) throw new Error("This exact plan is already reserved in the session lease");
    const reservationId = randomUUID();
    // Dispatched reservations remain for the lease lifetime. Only an explicit
    // not_dispatched release returns that exact unique index to the pool.
    const operationIndex = this.#releasedOperationIndexes.shift() ?? this.#nextOperationIndex++;
    const mutationIndex = mutation ? this.#releasedMutationIndexes.shift() ?? this.#nextMutationIndex++ : null;
    this.#reservations.set(reservationId, { planHash, dispatched: false, operationIndex, mutationIndex, checkpointRequired, checkpointCompleted: !checkpointRequired });
    if (checkpointRequired) this.#checkpointBarrierReservationId = reservationId;
    return { leaseId: this.payload.leaseId, reservationId, planHash, operationIndex, mutationIndex, elapsedRuntimeMinutes: Math.max(0, (this.#now() - this.payload.issuedAt) / 60_000) };
  }

  async previewNextIndexes(mutation = false): Promise<LeaseIndexPreview> {
    await this.assertValid();
    if (mutation && this.#checkpointBarrierReservationId) throw new CheckpointBarrierActiveError();
    return {
      operationIndex: this.#releasedOperationIndexes[0] ?? this.#nextOperationIndex,
      mutationIndex: mutation ? this.#releasedMutationIndexes[0] ?? this.#nextMutationIndex : null,
      elapsedRuntimeMinutes: Math.max(0, (this.#now() - this.payload.issuedAt) / 60_000),
    };
  }

  async revalidateForDispatch(reservationId: string, planHash: string): Promise<void> {
    await this.assertValid();
    const reservation = this.#reservations.get(reservationId);
    if (!reservation || reservation.dispatched) throw new Error("Session lease reservation is unavailable for dispatch");
    if (reservation.planHash !== planHash) throw new Error("Session lease reservation does not match the exact execution plan");
    if (reservation.checkpointRequired && !reservation.checkpointCompleted) throw new Error("The required checkpoint barrier has not been completed");
  }

  async completeCheckpoint(reservationId: string, planHash: string): Promise<void> {
    await this.assertValid();
    const reservation = this.#reservations.get(reservationId);
    if (!reservation || reservation.dispatched) throw new Error("Session lease reservation is unavailable for checkpoint completion");
    if (reservation.planHash !== planHash) throw new Error("Checkpoint completion does not match the exact execution plan");
    if (!reservation.checkpointRequired || this.#checkpointBarrierReservationId !== reservationId) throw new Error("Reservation does not own the active checkpoint barrier");
    reservation.checkpointCompleted = true;
    this.#checkpointBarrierReservationId = null;
  }

  markCheckpointOutcomeUnknown(reservationId: string): void {
    const reservation = this.#reservations.get(reservationId);
    if (!reservation || reservation.dispatched) throw new Error("Session lease reservation is unavailable for checkpoint reconciliation");
    if (!reservation.checkpointRequired || this.#checkpointBarrierReservationId !== reservationId) throw new Error("Reservation does not own the active checkpoint barrier");
    reservation.dispatched = true;
  }

  markDispatched(reservationId: string): void {
    const reservation = this.#reservations.get(reservationId);
    if (!reservation) throw new Error("Unknown session lease reservation");
    if (reservation.checkpointRequired && !reservation.checkpointCompleted) throw new Error("The required checkpoint barrier has not been completed");
    reservation.dispatched = true;
  }

  release(reservationId: string, dispatchState: DispatchState): void {
    const reservation = this.#reservations.get(reservationId);
    if (!reservation) throw new Error("Unknown session lease reservation");
    if (reservation.dispatched || dispatchState !== "not_dispatched") throw new Error("A session lease slot can only be released before dispatch");
    this.#reservations.delete(reservationId);
    if (this.#checkpointBarrierReservationId === reservationId) this.#checkpointBarrierReservationId = null;
    this.#releasedOperationIndexes.push(reservation.operationIndex);
    this.#releasedOperationIndexes.sort((left, right) => left - right);
    if (reservation.mutationIndex !== null) {
      this.#releasedMutationIndexes.push(reservation.mutationIndex);
      this.#releasedMutationIndexes.sort((left, right) => left - right);
    }
  }

  async assertValid(): Promise<void> {
    const payload = leasePayloadSchema.parse(this.payload);
    if (!await this.#authenticate.verify(strictCanonicalJson(payload), this.signature)) throw new Error("Session lease signature is invalid");
    if (payload.pid !== this.#currentPid() || payload.processStartTime !== this.#currentProcessStart()) throw new Error("Session lease is not bound to the current pinned Node process");
    const now = this.#now();
    if (now < payload.issuedAt - 5_000 || now >= payload.expiresAt) throw new Error("Session lease has expired or is not yet valid");
  }
}
