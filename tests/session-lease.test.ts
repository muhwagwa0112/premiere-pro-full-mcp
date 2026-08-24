import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SessionLease } from "../src/security/session-lease.js";

const authenticate = {
  sign: async (message: string) => createHash("sha256").update(message).digest("base64url"),
  verify: async (message: string, signature: string) => signature === createHash("sha256").update(message).digest("base64url"),
};

describe("process session lease", () => {
  it("expires and is process-start scoped", async () => {
    let now = 1_000;
    const lease = await SessionLease.createForCurrentProcess({ ttlMs: 100, now: () => now, pid: 42, processStartTime: 500, authenticate });
    await expect(lease.reserve("sha256:" + "a".repeat(64))).resolves.toMatchObject({ operationIndex: 0 });
    now = 1_100;
    await expect(lease.reserve("sha256:" + "b".repeat(64))).rejects.toThrow(/expired/);
  });

  it("atomically reserves unique slots and returns only not_dispatched slots", async () => {
    const lease = await SessionLease.createForCurrentProcess({ now: () => 1_000, pid: 42, processStartTime: 500, authenticate });
    const reservations = await Promise.all(Array.from({ length: 20 }, (_, index) => lease.reserve(`sha256:${index.toString(16).padStart(64, "0")}`)));
    expect(new Set(reservations.map((item) => item.operationIndex)).size).toBe(20);
    const released = reservations[4]!;
    lease.release(released.reservationId, "not_dispatched");
    const replacement = await lease.reserve("sha256:" + "f".repeat(64));
    expect(replacement.operationIndex).toBe(released.operationIndex);
    expect(new Set([...reservations.filter((item) => item !== released).map((item) => item.operationIndex), replacement.operationIndex]).size).toBe(20);
    lease.markDispatched(reservations[0]!.reservationId);
    expect(() => lease.release(reservations[0]!.reservationId, "not_dispatched")).toThrow(/only be released/);
  });

  it("tracks the first mutation independently from prior read operations", async () => {
    const lease = await SessionLease.createForCurrentProcess({ now: () => 1_000, pid: 42, processStartTime: 500, authenticate });
    const read = await lease.reserve("sha256:" + "a".repeat(64), false);
    const mutation = await lease.reserve("sha256:" + "b".repeat(64), true);
    expect(read).toMatchObject({ operationIndex: 0, mutationIndex: null });
    expect(mutation).toMatchObject({ operationIndex: 1, mutationIndex: 0 });
  });

  it("fails closed when a reservation expires before dispatch", async () => {
    let now = 1_000;
    const lease = await SessionLease.createForCurrentProcess({ ttlMs: 100, now: () => now, pid: 42, processStartTime: 500, authenticate });
    const reservation = await lease.reserve("sha256:" + "c".repeat(64), true);
    now = 1_100;
    await expect(lease.revalidateForDispatch(reservation.reservationId, reservation.planHash)).rejects.toThrow(/expired/);
  });

  it("holds a global mutation barrier until the owning checkpoint is completed", async () => {
    const lease = await SessionLease.createForCurrentProcess({ now: () => 1_000, pid: 42, processStartTime: 500, authenticate });
    const planHash = "sha256:" + "d".repeat(64);
    const owner = await lease.reserve(planHash, true, true);

    await expect(lease.previewNextIndexes(true)).rejects.toMatchObject({ code: "CHECKPOINT_BARRIER_ACTIVE" });
    await expect(lease.reserve("sha256:" + "e".repeat(64), true, false)).rejects.toMatchObject({ code: "CHECKPOINT_BARRIER_ACTIVE" });
    await expect(lease.revalidateForDispatch(owner.reservationId, owner.planHash)).rejects.toThrow(/checkpoint barrier has not been completed/);
    expect(() => lease.markDispatched(owner.reservationId)).toThrow(/checkpoint barrier has not been completed/);

    await lease.completeCheckpoint(owner.reservationId, owner.planHash);
    await expect(lease.revalidateForDispatch(owner.reservationId, owner.planHash)).resolves.toBeUndefined();
    await expect(lease.reserve("sha256:" + "e".repeat(64), true, false)).resolves.toMatchObject({ mutationIndex: 1 });
  });

  it("releases a failed checkpoint barrier and returns its exact first-mutation slot", async () => {
    const lease = await SessionLease.createForCurrentProcess({ now: () => 1_000, pid: 42, processStartTime: 500, authenticate });
    const owner = await lease.reserve("sha256:" + "1".repeat(64), true, true);

    lease.release(owner.reservationId, "not_dispatched");

    await expect(lease.previewNextIndexes(true)).resolves.toMatchObject({ mutationIndex: 0 });
    await expect(lease.reserve("sha256:" + "2".repeat(64), true, true)).resolves.toMatchObject({ mutationIndex: 0 });
  });

  it("keeps mutations blocked when checkpoint dispatch needs reconciliation", async () => {
    const lease = await SessionLease.createForCurrentProcess({ now: () => 1_000, pid: 42, processStartTime: 500, authenticate });
    const owner = await lease.reserve("sha256:" + "3".repeat(64), true, true);

    lease.markCheckpointOutcomeUnknown(owner.reservationId);

    await expect(lease.previewNextIndexes(true)).rejects.toMatchObject({ code: "CHECKPOINT_BARRIER_ACTIVE" });
    await expect(lease.reserve("sha256:" + "4".repeat(64), true, true)).rejects.toMatchObject({ code: "CHECKPOINT_BARRIER_ACTIVE" });
    expect(() => lease.release(owner.reservationId, "not_dispatched")).toThrow(/only be released/);
  });
});
