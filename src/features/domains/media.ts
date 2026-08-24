import { defineDomain, state, verify } from "../registry-contract.js";

export const mediaFeatures = defineDomain("media-ingest-proxy", [
  { id: "media.import", title: "Import media", status: "SUPPORTED_CONTEXTUAL", backends: ["uxp", "cep"], risk: "R2", preconditions: [...state.project, "approved media path"], verification: ["imported project-item identity readback"], fixture: "basic-edit" },
  { id: "media.folder.import", title: "Import folder", status: "UNVERIFIED", backends: ["uxp", "cep"], risk: "R2", preconditions: [...state.project, "approved folder path"], verification: ["expected imported-item set readback"] },
  { id: "media.relink", title: "Relink media", status: "SUPPORTED_CONTEXTUAL", backends: ["uxp"], risk: "R2", preconditions: [...state.project, "session-scoped clip handle", "approved replacement path"], verification: ["exact media path readback"], fixture: "offline-relink" },
  { id: "media.replace", title: "Replace footage", status: "UNVERIFIED", backends: ["uxp", "cep"], risk: "R2", preconditions: [...state.project, "scoped project-item handle", "approved replacement path"], verification: ["project-item media identity readback"] },
  { id: "media.offline", title: "Make media offline", status: "UNVERIFIED", backends: ["uxp", "cep"], risk: "R2", preconditions: state.project, verification: ["offline state readback"] },
  { id: "media.proxy.attach", title: "Attach proxy", status: "SUPPORTED_CONTEXTUAL", backends: ["uxp"], risk: "R2", preconditions: [...state.project, "session-scoped clip handle", "approved proxy path"], verification: ["proxy presence and exact proxy path readback"], fixture: "proxy-attach" },
  { id: "media.proxy.manage", title: "Create, detach, and toggle proxies", status: "UNVERIFIED", backends: ["uxp", "cep", "ui"], risk: "R2", preconditions: state.project, verification: ["proxy association and display state readback"] },
  { id: "media.ingest", title: "Ingest and copy media", status: "UI_ADAPTER_REQUIRED", backends: ["ui"], risk: "R3", preconditions: ["registered UI fingerprint", "approved ingest destination"], verification: ["ingest receipt and imported item readback"] },
  { id: "media.interpret_footage", title: "Interpret footage", status: "UNVERIFIED", backends: ["uxp", "cep", "ui"], risk: "R2", preconditions: state.project, verification: ["frame rate, pixel aspect, field order, and alpha readback"] },
  { id: "media.metadata", title: "Read and edit metadata", status: "PREVIEW_ONLY", backends: ["uxp", "cep"], risk: "R2", preconditions: state.project, verification: ["typed metadata field readback"] },
  { id: "media.subclip", title: "Create and manage subclips", status: "UNVERIFIED", backends: ["uxp", "cep"], risk: "R1", preconditions: state.project, verification: verify.revision, fixture: "basic-edit" },
]);
