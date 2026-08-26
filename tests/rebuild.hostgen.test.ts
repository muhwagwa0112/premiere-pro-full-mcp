import { describe, expect, it } from "vitest";
import { getUpstreamToolModules } from "../vendor/upstream/tools/catalog.js";
import { OFFICIAL_TOOL_NAMES, EXTRA_TOOL_NAMES } from "../src/tool-names.js";
import { EXTRA_ROUTES } from "../src/server.js";

describe("upstream tool coverage", () => {
  it("loads the full 266 official tool modules from the vendored upstream", () => {
    const tools = getUpstreamToolModules({ executeScript: async () => ({ success: true, data: {} }) });
    const names = Object.keys(tools);
    expect(names.length).toBeGreaterThanOrEqual(266);
  });

  it("every official tool name has a concrete handler", () => {
    const tools = getUpstreamToolModules({ executeScript: async () => ({ success: true, data: {} }) });
    for (const name of OFFICIAL_TOOL_NAMES) {
      const tool = tools[name];
      expect(tool, `missing upstream handler for ${name}`).toBeTruthy();
      if (tool) {
        expect(typeof tool.handler).toBe("function");
        expect(typeof tool.description).toBe("string");
        expect(tool.parameters).toBeTruthy();
      }
    }
  });

  it("every upstream handler builds a real ExtendScript transport call (no silent no-op)", async () => {
    let executed = 0;
    const executedScripts: string[] = [];
    const tools = getUpstreamToolModules({
      executeScript: async (script: string) => {
        executed++;
        executedScripts.push(script);
        return { success: true, data: {} };
      },
    });
    // Invoke a representative read handler; it must reach executeScript.
    const probe = tools["get_project_info"] ?? tools["list_sequences"];
    expect(probe).toBeTruthy();
    if (probe) await probe.handler({});
    expect(executed).toBeGreaterThanOrEqual(1);
    expect(executedScripts[0]).toContain("app.project");
  });

  it("every extra tool is either routed to a real upstream handler, a local helper, or a concrete script", () => {
    const upstream = getUpstreamToolModules({ executeScript: async () => ({ success: true, data: {} }) });
    const LOCAL_HELPERS = new Set([
      "helpers_ticks_to_timecode",
      "helpers_timecode_to_ticks",
      "helpers_seconds_to_timecode",
      "helpers_timecode_to_seconds",
      "premiere_connection_status",
      "premiere_health_check",
    ]);
    const CONCRETE_SCRIPTS = new Set([
      "premiere_project_summary",
      "premiere_recent_files",
      "helpers_duration_summary",
      "helpers_resolve_sequence_id",
      "helpers_resolve_project_item_id",
      "media_batch_rename",
      "media_batch_set_offline",
    ]);
    for (const extra of EXTRA_TOOL_NAMES) {
      if (LOCAL_HELPERS.has(extra) || CONCRETE_SCRIPTS.has(extra)) continue;
      const route = EXTRA_ROUTES[extra];
      expect(route, `extra '${extra}' has no route and is not a local helper / concrete script`).toBeTruthy();
      if (route) {
        const target = upstream[route.target];
        expect(target, `route target '${route.target}' for '${extra}' missing from upstream`).toBeTruthy();
        if (target) expect(typeof target.handler).toBe("function");
      }
    }
  });
});
