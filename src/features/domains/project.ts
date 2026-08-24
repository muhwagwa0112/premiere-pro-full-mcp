import { defineDomain, state, verify } from "../registry-contract.js";

export const projectFeatures = defineDomain("project-productions", [
  { id: "project.create", title: "Create project", status: "SUPPORTED_CONTEXTUAL", backends: ["uxp", "cep"], risk: "R2", preconditions: ["approved destination path"], verification: verify.file, fixture: "empty-project" },
  { id: "project.open", title: "Open project", status: "SUPPORTED_CONTEXTUAL", backends: ["uxp", "cep", "ui"], risk: "R2", preconditions: ["approved existing project path"], verification: ["active project identity and canonical path readback"], fixture: "empty-project" },
  { id: "project.save", title: "Save project", status: "SUPPORTED_CONTEXTUAL", backends: ["uxp", "cep"], risk: "R2", preconditions: state.project, verification: verify.file, fixture: "basic-edit" },
  { id: "project.save_as", title: "Save project as", status: "SUPPORTED_CONTEXTUAL", backends: ["cep"], risk: "R2", preconditions: [...state.project, "approved destination path"], verification: verify.file, fixture: "basic-edit" },
  { id: "project.close", title: "Close project", status: "UNVERIFIED", backends: ["uxp", "cep"], risk: "R2", preconditions: [...state.project, "verified checkpoint"], verification: ["closed project identity is absent from host readback"] },
  { id: "project.bin_item.crud", title: "Bin and project-item CRUD", status: "UNVERIFIED", backends: ["uxp", "cep"], risk: "R1", preconditions: state.project, verification: verify.revision, fixture: "bins-and-media" },
  { id: "project.settings", title: "Project settings", status: "PREVIEW_ONLY", backends: ["uxp", "cep"], risk: "R2", preconditions: state.project, verification: ["exact settings readback"] },
  { id: "productions.manage", title: "Productions management", status: "UI_ADAPTER_REQUIRED", backends: ["ui"], risk: "R3", preconditions: ["registered UI fingerprint", "Productions workspace"], verification: ["registered UI postcondition and project membership readback"] },
  { id: "team_projects.manage", title: "Team Projects management", status: "ENTITLEMENT_BLOCKED", backends: ["ui", "service"], risk: "R3", preconditions: state.entitlement, verification: verify.service },
]);
