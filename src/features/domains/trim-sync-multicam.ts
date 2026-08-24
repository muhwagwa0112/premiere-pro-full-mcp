import { defineDomain, state, verify } from "../registry-contract.js";

export const trimSyncMulticamFeatures = defineDomain("trim-sync-multicam", [
  { id: "trim.ripple", title: "Ripple trim", status: "UNVERIFIED", backends: ["qe", "ui"], risk: "R2", preconditions: state.sequence, verification: verify.revision },
  { id: "trim.roll", title: "Roll trim", status: "UNVERIFIED", backends: ["qe", "ui"], risk: "R2", preconditions: state.sequence, verification: verify.revision },
  { id: "trim.slip", title: "Slip edit", status: "UNVERIFIED", backends: ["qe", "ui"], risk: "R2", preconditions: state.sequence, verification: verify.revision },
  { id: "trim.slide", title: "Slide edit", status: "UNVERIFIED", backends: ["qe", "ui"], risk: "R2", preconditions: state.sequence, verification: verify.revision },
  { id: "trim.rate_stretch", title: "Rate stretch", status: "UNVERIFIED", backends: ["uxp", "qe", "ui"], risk: "R2", preconditions: state.sequence, verification: ["clip timing and speed readback"] },
  { id: "sync.audio_timecode", title: "Audio and timecode synchronization", status: "UI_ADAPTER_REQUIRED", backends: ["ui"], risk: "R2", preconditions: ["registered UI fingerprint", ...state.sequence], verification: verify.revision },
  { id: "multicam.source", title: "Create multicamera source sequence", status: "UI_ADAPTER_REQUIRED", backends: ["ui"], risk: "R2", preconditions: ["registered UI fingerprint", ...state.project], verification: ["multicam source identity readback"] },
  { id: "multicam.angle", title: "Switch multicamera angle", status: "UI_ADAPTER_REQUIRED", backends: ["ui"], risk: "R2", preconditions: ["registered UI fingerprint", ...state.sequence], verification: ["selected angle readback"] },
  { id: "multicam.flatten", title: "Flatten multicamera clips", status: "UI_ADAPTER_REQUIRED", backends: ["ui"], risk: "R2", preconditions: ["registered UI fingerprint", ...state.sequence], verification: verify.revision },
]);
