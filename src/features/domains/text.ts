import { defineDomain, state, verify } from "../registry-contract.js";

export const textFeatures = defineDomain("text-transcript-captions-graphics", [
  { id: "transcript.status", title: "Transcript status", status: "PREVIEW_ONLY", backends: ["uxp", "cep"], risk: "R0", preconditions: state.inspect, verification: ["typed transcript status readback"] },
  { id: "transcript.create", title: "Create transcript", status: "EXTERNAL_SERVICE_REQUIRED", backends: ["service", "ui"], risk: "R3", preconditions: state.entitlement, verification: verify.service },
  { id: "transcript.search_edit", title: "Search and edit transcript", status: "UI_ADAPTER_REQUIRED", backends: ["ui"], risk: "R2", preconditions: ["registered UI fingerprint", "available transcript", ...state.sequence], verification: ["transcript segment readback"] },
  { id: "text_based_editing", title: "Text-based editing", status: "UI_ADAPTER_REQUIRED", backends: ["ui"], risk: "R3", preconditions: ["registered UI fingerprint", "available transcript", ...state.sequence], verification: verify.revision },
  { id: "captions.track_cue.crud", title: "Caption track and cue CRUD", status: "UNVERIFIED", backends: ["uxp", "cep", "ui"], risk: "R2", preconditions: state.sequence, verification: ["caption track and cue collection readback"], fixture: "captions-transcript" },
  { id: "captions.import_export", title: "Caption import and export", status: "UNVERIFIED", backends: ["uxp", "cep", "ui"], risk: "R2", preconditions: [...state.sequence, "approved caption path"], verification: ["caption cue readback or stable exported file"] },
  { id: "graphics.mogrt", title: "Motion Graphics templates", status: "THIRD_PARTY_DEPENDENT", backends: ["cep", "ui"], risk: "R2", preconditions: ["installed compatible template", ...state.sequence], verification: ["inserted graphic identity and properties readback"] },
  { id: "graphics.properties", title: "Graphic properties", status: "UNVERIFIED", backends: ["uxp", "cep", "ui"], risk: "R2", preconditions: state.sequence, verification: ["typed graphic property readback"] },
]);
