import { describe, expect, it } from "vitest";
import { OFFICIAL_TOOL_NAMES, EXTRA_TOOL_NAMES, ALL_TOOL_NAMES } from "../src/tool-names.js";

describe("tool surface", () => {
  it("exposes the official 266-tool floor", () => {
    expect(OFFICIAL_TOOL_NAMES.length).toBe(266);
  });

  it("adds project-specific extras on top", () => {
    expect(EXTRA_TOOL_NAMES.length).toBeGreaterThanOrEqual(87);
  });

  it("keeps all tool names unique and stable", () => {
    const all = [...ALL_TOOL_NAMES];
    expect(new Set(all).size).toBe(all.length);
    for (const name of all) expect(name).toMatch(/^[a-z0-9_]+$/);
  });

  it("total surface is at least 353", () => {
    expect(ALL_TOOL_NAMES.length).toBeGreaterThanOrEqual(353);
  });
});
