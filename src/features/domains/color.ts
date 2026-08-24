import { defineDomain, state } from "../registry-contract.js";

export const colorFeatures = defineDomain("color-hdr", [
  { id: "color.lumetri", title: "Lumetri Color", status: "UNVERIFIED", backends: ["uxp", "cep", "ui"], risk: "R2", preconditions: state.sequence, verification: ["Lumetri component parameter readback"], fixture: "color-hdr" },
  { id: "color.lut", title: "LUT management", status: "UNVERIFIED", backends: ["uxp", "cep", "ui"], risk: "R2", preconditions: [...state.sequence, "approved LUT path"], verification: ["applied LUT identity readback"] },
  { id: "color.space", title: "Input, working, and output color space", status: "UNVERIFIED", backends: ["uxp", "cep", "ui"], risk: "R2", preconditions: state.project, verification: ["media, sequence, and output color-space readback"] },
  { id: "color.tone_mapping", title: "Tone mapping", status: "UNVERIFIED", backends: ["uxp", "ui"], risk: "R2", preconditions: state.sequence, verification: ["tone-mapping mode readback"] },
  { id: "color.hdr_metadata", title: "HDR metadata", status: "PREVIEW_ONLY", backends: ["uxp", "cep"], risk: "R2", preconditions: state.project, verification: ["HDR metadata readback"], fixture: "color-hdr" },
  { id: "color.curves_hsl_wheels", title: "Curves, HSL, and color wheels", status: "UI_ADAPTER_REQUIRED", backends: ["ui"], risk: "R2", preconditions: ["registered UI fingerprint", ...state.sequence], verification: ["Lumetri parameter readback"] },
]);
