import { defineDomain, state, verify } from "../registry-contract.js";

export const collaborationFeatures = defineDomain("collaboration-cloud-ai", [
  { id: "collaboration.productions", title: "Productions collaboration", status: "UI_ADAPTER_REQUIRED", backends: ["ui"], risk: "R3", preconditions: ["registered UI fingerprint", "production access"], verification: ["production and project membership readback"] },
  { id: "collaboration.team_projects", title: "Team Projects collaboration", status: "ENTITLEMENT_BLOCKED", backends: ["ui", "service"], risk: "R3", preconditions: state.entitlement, verification: verify.service },
  { id: "cloud.frame_io", title: "Frame.io review and sharing", status: "ENTITLEMENT_BLOCKED", backends: ["service", "ui"], risk: "R3", preconditions: state.entitlement, verification: verify.service },
  { id: "cloud.stock", title: "Adobe Stock", status: "ENTITLEMENT_BLOCKED", backends: ["service", "ui"], risk: "R3", preconditions: [...state.entitlement, "purchase authorization when licensing"], verification: ["asset license receipt and imported-item readback"] },
  { id: "cloud.media", title: "Cloud media", status: "ENTITLEMENT_BLOCKED", backends: ["service", "ui"], risk: "R3", preconditions: state.entitlement, verification: verify.service },
  { id: "cloud.speech_caption", title: "Cloud speech and caption services", status: "EXTERNAL_SERVICE_REQUIRED", backends: ["service", "ui"], risk: "R3", preconditions: state.entitlement, verification: verify.service },
  { id: "ai.generative", title: "Generative functions", status: "ENTITLEMENT_BLOCKED", backends: ["service", "ui"], risk: "R3", preconditions: [...state.entitlement, "eligible media and region"], verification: verify.service },
]);
