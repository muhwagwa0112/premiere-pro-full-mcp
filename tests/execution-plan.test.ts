import { describe, expect, it } from "vitest";
import { getAction } from "../src/catalog.js";
import { buildExecutionPlan, strictCanonicalJson, verifyExecutionPlan } from "../src/security/execution-plan.js";

describe("execution plans", () => {
  const request = { actionId: "project.save", args: { z: 1, nested: { b: true, a: "x" } }, operationId: "11111111-1111-4111-8111-111111111111" };
  const probe = { backend: "cep" as const, available: true, operations: ["project.save"], hostVersion: "26.3.2", hostSessionId: "host-1", capabilityFingerprint: "cap-1" };

  it("canonicalizes strict JSON deterministically and rejects unsafe values", () => {
    expect(strictCanonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(() => strictCanonicalJson({ bad: undefined })).toThrow(/unsupported/);
    expect(() => strictCanonicalJson({ bad: Number.NaN })).toThrow(/non-finite/);
    expect(() => strictCanonicalJson(new Array(1))).toThrow(/sparse/);
  });

  it("binds backend, host session, args, roots, state, and verifier", () => {
    const base = buildExecutionPlan({ action: getAction(request.actionId), request, probe, approvedRootDigests: ["sha256:" + "a".repeat(64)] });
    const reordered = buildExecutionPlan({ action: getAction(request.actionId), request: { ...request, args: { nested: { a: "x", b: true }, z: 1 } }, probe, approvedRootDigests: ["sha256:" + "a".repeat(64)] });
    expect(reordered.planHash).toBe(base.planHash);
    expect(verifyExecutionPlan(base)).toBe(true);
    expect(buildExecutionPlan({ action: getAction(request.actionId), request, probe: { ...probe, hostSessionId: "host-2" }, approvedRootDigests: base.approvedRootDigests }).planHash).not.toBe(base.planHash);
    expect(buildExecutionPlan({ action: getAction(request.actionId), request: { ...request, args: { ...request.args, z: 2 } }, probe, approvedRootDigests: base.approvedRootDigests }).planHash).not.toBe(base.planHash);
  });
});
