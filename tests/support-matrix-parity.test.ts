import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { listActions } from "../src/catalog.js";
import {
  SUPPORT_MATRIX_BACKENDS,
  SUPPORT_MATRIX_HANDLER_EVIDENCE,
  generateSupportMatrix,
  serializeSupportMatrix,
} from "../src/support-matrix.js";

describe("generated support matrix", () => {
  it("contains every catalog action crossed with every backend in stable order", () => {
    const matrix = generateSupportMatrix();
    expect(matrix.actions.map((action) => action.actionId)).toEqual(listActions().map((action) => action.id).sort());
    expect(matrix.summary.backendCellCount).toBe(listActions().length * SUPPORT_MATRIX_BACKENDS.length);
    for (const action of matrix.actions) {
      expect(action.backends.map((backend) => backend.backend)).toEqual(SUPPORT_MATRIX_BACKENDS);
    }
  });

  it("backs every implemented cell with a source fragment", async () => {
    for (const item of SUPPORT_MATRIX_HANDLER_EVIDENCE) {
      const source = await readFile(resolve(item.source), "utf8");
      expect(source, `${item.actionId}/${item.backend} evidence`).toContain(item.sourceFragment);
    }
    for (const action of generateSupportMatrix().actions) {
      for (const backend of action.backends) {
        expect(backend.handlerState === "implemented_unverified").toBe(backend.evidence !== null);
        if (backend.evidence) expect(backend.evidence.liveEvidenceStatus).toBe("not_run");
      }
    }
  });

  it("flags preferred backend declarations that are not backed by a handler", () => {
    const matrix = generateSupportMatrix();
    const insert = matrix.actions.find((action) => action.actionId === "timeline.clip.insert");
    expect(insert?.mismatches).toContain("preferred_backend_without_handler");
    expect(insert?.backends.find((backend) => backend.backend === "uxp")?.mismatches).toContain("preferred_backend_without_handler");
    expect(insert?.backends.find((backend) => backend.backend === "cep")?.mismatches).toContain("preferred_backend_without_handler");
  });

  it("does not declare implemented_unverified without at least one real handler", () => {
    const violations = generateSupportMatrix().actions
      .filter((action) => action.declaredSupport === "implemented_unverified")
      .filter((action) => !action.backends.some((backend) => backend.handlerState === "implemented_unverified"))
      .map((action) => action.actionId);
    expect(violations).toEqual([]);
  });

  it("keeps declared semantic actions aligned with reachable concrete handlers", () => {
    const matrix = generateSupportMatrix();
    const action = (actionId: string) => matrix.actions.find((entry) => entry.actionId === actionId)!;
    const implemented = (actionId: string, backend: string) => action(actionId).backends.find((entry) => entry.backend === backend)?.handlerState;

    for (const actionId of ["project.create", "project.open", "media.import"]) {
      expect(action(actionId).preferredBackends).toContain("cep");
      expect(implemented(actionId, "cep")).toBe("implemented_unverified");
    }
    expect(action("effects.catalog").preferredBackends).toContain("local");
    expect(implemented("effects.catalog", "local")).toBe("implemented_unverified");
    expect(action("export.sequence").preferredBackends).toEqual(["uxp", "cep"]);
    expect(implemented("export.sequence", "uxp")).toBe("implemented_unverified");
    expect(implemented("export.sequence", "cep")).toBe("implemented_unverified");
    for (const actionId of ["timeline.clip.insert", "effects.apply", "history.undo"]) {
      expect(action(actionId).declaredSupport).toBe("unsupported");
      expect(action(actionId).backends.every((entry) => entry.handlerState === "not_implemented")).toBe(true);
    }
  });

  it("matches the committed deterministic artifact", async () => {
    const committed = await readFile(resolve("generated/support-matrix.json"), "utf8");
    expect(committed).toBe(serializeSupportMatrix());
  });

  it("passes the shipped build-and-generator check path", async () => {
    const run = promisify(execFile);
    const npmCli = process.env.npm_execpath;
    if (!npmCli) throw new Error("npm_execpath is unavailable");
    await expect(run(process.execPath, [npmCli, "run", "inventory:support:check"], { cwd: resolve("."), timeout: 60_000 })).resolves.toBeDefined();
  }, 70_000);
});
