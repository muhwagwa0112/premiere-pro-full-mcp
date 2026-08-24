import { defineDomain, state, verify } from "../registry-contract.js";

export const exportFeatures = defineDomain("export-ame-interchange", [
  { id: "export.frame", title: "Export frame", status: "SUPPORTED_CONTEXTUAL", backends: ["uxp"], risk: "R2", preconditions: [...state.sequence, "approved output path"], verification: verify.file, fixture: "basic-edit" },
  { id: "export.sequence", title: "Export sequence", status: "SUPPORTED_CONTEXTUAL", backends: ["uxp", "cep"], risk: "R2", preconditions: [...state.sequence, "approved output path", "available export preset"], verification: verify.file, fixture: "basic-edit" },
  { id: "export.range", title: "Export sequence range", status: "UNVERIFIED", backends: ["uxp", "cep"], risk: "R2", preconditions: [...state.sequence, "bounded in/out range", "approved output path"], verification: verify.file },
  { id: "export.batch", title: "Batch export", status: "UNVERIFIED", backends: ["local", "uxp", "cep"], risk: "R2", preconditions: ["durable job plan", "approved output roots"], verification: ["per-output stable-file evidence and job receipt"] },
  { id: "ame.queue_status", title: "Adobe Media Encoder queue and status", status: "UNVERIFIED", backends: ["cep", "ui"], risk: "R2", preconditions: ["compatible Adobe Media Encoder installation", ...state.sequence], verification: ["queue item identity and terminal status readback"] },
  { id: "interchange.aaf", title: "AAF interchange", status: "UI_ADAPTER_REQUIRED", backends: ["ui"], risk: "R2", preconditions: ["registered UI fingerprint", "approved output path", ...state.sequence], verification: verify.file },
  { id: "interchange.xml", title: "Final Cut Pro XML interchange", status: "UNVERIFIED", backends: ["cep", "ui"], risk: "R2", preconditions: ["approved output path", ...state.sequence], verification: verify.file },
  { id: "interchange.edl", title: "EDL interchange", status: "UNVERIFIED", backends: ["cep", "ui"], risk: "R2", preconditions: ["approved output path", ...state.sequence], verification: verify.file },
  { id: "interchange.omf", title: "OMF interchange", status: "UI_ADAPTER_REQUIRED", backends: ["ui"], risk: "R2", preconditions: ["registered UI fingerprint", "approved output path", ...state.sequence], verification: verify.file },
  { id: "export.captions", title: "Export captions", status: "UNVERIFIED", backends: ["uxp", "cep", "ui"], risk: "R2", preconditions: ["caption track", "approved output path", ...state.sequence], verification: verify.file },
  { id: "project_manager.collect", title: "Project Manager collect and consolidate", status: "UI_ADAPTER_REQUIRED", backends: ["ui"], risk: "R3", preconditions: ["registered UI fingerprint", "approved destination", "verified checkpoint", ...state.project], verification: ["collected project and media manifest readback"] },
]);
