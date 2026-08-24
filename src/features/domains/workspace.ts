import { defineDomain, state } from "../registry-contract.js";

export const workspaceFeatures = defineDomain("workspace-playback-preferences", [
  { id: "playback.control", title: "Playback control", status: "PREVIEW_ONLY", backends: ["uxp", "cep", "ui"], risk: "R1", preconditions: state.sequence, verification: ["playback and playhead state readback"] },
  { id: "monitors.control", title: "Source and Program Monitor control", status: "UI_ADAPTER_REQUIRED", backends: ["ui"], risk: "R1", preconditions: ["registered UI fingerprint", "known monitor state"], verification: ["monitor state readback"] },
  { id: "workspace.select", title: "Select workspace", status: "UI_ADAPTER_REQUIRED", backends: ["cep", "ui"], risk: "R1", preconditions: ["registered workspace", "matching host version and locale"], verification: ["active workspace readback"] },
  { id: "panels.control", title: "Panel control", status: "UI_ADAPTER_REQUIRED", backends: ["ui"], risk: "R1", preconditions: ["registered UI fingerprint"], verification: ["panel visibility and focus readback"] },
  { id: "history.undo_redo", title: "History, undo, and redo", status: "UI_ADAPTER_REQUIRED", backends: ["cep", "ui"], risk: "R2", preconditions: ["registered UI fingerprint", ...state.project], verification: ["history label and project revision readback"] },
  { id: "preferences.manage", title: "Preferences", status: "UI_ADAPTER_REQUIRED", backends: ["ui"], risk: "R3", preconditions: ["registered UI fingerprint", "explicit preference allowlist"], verification: ["exact preference readback"] },
  { id: "scratch_disk.manage", title: "Scratch disks", status: "UI_ADAPTER_REQUIRED", backends: ["ui"], risk: "R3", preconditions: ["registered UI fingerprint", "approved directory paths", ...state.project], verification: ["scratch-disk path readback"] },
  { id: "media_cache.manage", title: "Media cache", status: "MANUAL_ONLY", backends: ["ui"], risk: "R3", preconditions: ["interactive user presence", "explicit destructive scope"], verification: ["cache location and post-cleanup disk-state readback"] },
]);
