import { defineDomain, state, verify } from "../registry-contract.js";

export const timelineFeatures = defineDomain("sequence-track-clip", [
  { id: "timeline.sequence.crud", title: "Sequence CRUD", status: "SUPPORTED_CONTEXTUAL", backends: ["uxp", "cep"], risk: "R1", preconditions: state.project, verification: verify.revision, fixture: "basic-edit" },
  { id: "timeline.sequence.settings", title: "Sequence settings", status: "UNVERIFIED", backends: ["uxp", "cep", "ui"], risk: "R2", preconditions: state.sequence, verification: ["exact sequence settings readback"] },
  { id: "timeline.track.crud", title: "Track CRUD", status: "UNVERIFIED", backends: ["uxp", "qe"], risk: "R1", preconditions: state.sequence, verification: ["track count and identity readback"] },
  { id: "timeline.track.state", title: "Track state", status: "SUPPORTED_CONTEXTUAL", backends: ["uxp"], risk: "R1", preconditions: [...state.sequence, "bounded track index"], verification: ["mute, lock, visibility, or targeting state readback"], fixture: "basic-edit" },
  { id: "timeline.clip.insert", title: "Insert clip", status: "SUPPORTED_CONTEXTUAL", backends: ["uxp"], risk: "R1", preconditions: [...state.sequence, "session-scoped project-item handle", "bounded target tracks and time"], verification: verify.revision, fixture: "basic-edit" },
  { id: "timeline.clip.overwrite", title: "Overwrite clip", status: "UNVERIFIED", backends: ["uxp", "cep"], risk: "R1", preconditions: state.sequence, verification: verify.revision },
  { id: "timeline.clip.move_copy", title: "Move and copy clips", status: "UNVERIFIED", backends: ["uxp", "qe"], risk: "R1", preconditions: state.sequence, verification: verify.revision },
  { id: "timeline.clip.delete", title: "Delete clips", status: "UNVERIFIED", backends: ["uxp", "qe"], risk: "R2", preconditions: state.sequence, verification: verify.revision },
  { id: "timeline.edit.ripple_lift_extract", title: "Ripple delete, lift, and extract", status: "UNVERIFIED", backends: ["uxp", "qe"], risk: "R2", preconditions: state.sequence, verification: verify.revision },
  { id: "timeline.clip.link_group_nest", title: "Link, group, and nest clips", status: "UNVERIFIED", backends: ["uxp", "qe"], risk: "R1", preconditions: state.sequence, verification: verify.revision },
  { id: "timeline.markers", title: "Sequence and clip markers", status: "PREVIEW_ONLY", backends: ["uxp", "cep"], risk: "R1", preconditions: state.sequence, verification: ["marker collection readback"] },
  { id: "timeline.in_out", title: "Sequence in and out points", status: "PREVIEW_ONLY", backends: ["uxp", "cep"], risk: "R1", preconditions: state.sequence, verification: ["exact in/out time readback"] },
  { id: "timeline.playhead", title: "Playhead positioning", status: "PREVIEW_ONLY", backends: ["uxp", "cep"], risk: "R1", preconditions: state.sequence, verification: ["playhead time readback"] },
]);
