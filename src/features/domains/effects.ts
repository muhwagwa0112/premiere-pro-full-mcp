import { defineDomain, state, verify } from "../registry-contract.js";

export const effectsFeatures = defineDomain("effects-transitions-motion-masks", [
  { id: "effects.inventory", title: "Effect inventory", status: "SUPPORTED_CONTEXTUAL", backends: ["local", "uxp", "cep"], risk: "R0", preconditions: state.inspect, verification: ["typed effect catalog readback"] },
  { id: "effects.apply_remove_reorder", title: "Apply, remove, and reorder effects", status: "UNVERIFIED", backends: ["uxp", "cep", "qe"], risk: "R2", preconditions: state.sequence, verification: ["ordered component-chain readback"] },
  { id: "effects.parameters", title: "Effect parameters", status: "PREVIEW_ONLY", backends: ["uxp", "cep"], risk: "R1", preconditions: state.sequence, verification: ["typed parameter value readback"] },
  { id: "effects.keyframes", title: "Effect keyframes", status: "UNVERIFIED", backends: ["uxp", "cep"], risk: "R2", preconditions: state.sequence, verification: ["keyframe time, value, and interpolation readback"], fixture: "effects-keyframes-masks" },
  { id: "transitions.manage", title: "Video and audio transitions", status: "UNVERIFIED", backends: ["uxp", "qe", "ui"], risk: "R2", preconditions: state.sequence, verification: verify.revision },
  { id: "motion.transform", title: "Motion properties", status: "UNVERIFIED", backends: ["uxp", "cep"], risk: "R1", preconditions: state.sequence, verification: ["position, scale, rotation, and anchor readback"] },
  { id: "opacity.manage", title: "Opacity and blend modes", status: "UNVERIFIED", backends: ["uxp", "cep"], risk: "R1", preconditions: state.sequence, verification: ["opacity and blend-mode readback"] },
  { id: "time_remapping.manage", title: "Time remapping", status: "UNVERIFIED", backends: ["uxp", "qe", "ui"], risk: "R2", preconditions: state.sequence, verification: ["speed keyframe and duration readback"] },
  { id: "masks.manage", title: "Effect masks", status: "UNVERIFIED", backends: ["uxp", "cep", "ui"], risk: "R2", preconditions: state.sequence, verification: ["mask path and property readback"], fixture: "effects-keyframes-masks" },
  { id: "masks.object", title: "Object masks", status: "BLOCKED_BY_HOST_VERSION", backends: ["ui", "service"], risk: "R3", preconditions: ["supported host build", "eligible media", ...state.entitlement], verification: ["object mask identity and tracked path readback"] },
]);
