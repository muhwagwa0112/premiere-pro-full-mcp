import { defineDomain, state } from "../registry-contract.js";

export const audioFeatures = defineDomain("audio", [
  { id: "audio.clip_gain", title: "Clip gain", status: "UNVERIFIED", backends: ["uxp", "cep"], risk: "R1", preconditions: state.sequence, verification: ["clip gain readback"], fixture: "audio-multichannel" },
  { id: "audio.volume_pan", title: "Volume and pan", status: "UNVERIFIED", backends: ["uxp", "cep"], risk: "R1", preconditions: state.sequence, verification: ["volume and pan readback"] },
  { id: "audio.keyframes", title: "Audio keyframes", status: "UNVERIFIED", backends: ["uxp", "cep"], risk: "R2", preconditions: state.sequence, verification: ["audio keyframe collection readback"] },
  { id: "audio.channel_mapping", title: "Audio channel mapping", status: "UNVERIFIED", backends: ["uxp", "cep", "ui"], risk: "R2", preconditions: state.project, verification: ["channel mapping readback"], fixture: "audio-multichannel" },
  { id: "audio.track_mixer", title: "Audio track mixer", status: "UI_ADAPTER_REQUIRED", backends: ["ui"], risk: "R2", preconditions: ["registered UI fingerprint", ...state.sequence], verification: ["mixer control and automation-mode readback"] },
  { id: "audio.submix_send", title: "Submixes and sends", status: "UI_ADAPTER_REQUIRED", backends: ["ui"], risk: "R2", preconditions: ["registered UI fingerprint", ...state.sequence], verification: ["routing graph readback"] },
  { id: "audio.essential_sound", title: "Essential Sound", status: "UI_ADAPTER_REQUIRED", backends: ["ui"], risk: "R2", preconditions: ["registered UI fingerprint", ...state.sequence], verification: ["audio type and applied settings readback"] },
  { id: "audio.enhance_speech", title: "Enhance Speech", status: "EXTERNAL_SERVICE_REQUIRED", backends: ["service", "ui"], risk: "R3", preconditions: state.entitlement, verification: ["service receipt", "enhanced clip state readback"] },
  { id: "audio.remix", title: "Remix", status: "UI_ADAPTER_REQUIRED", backends: ["ui"], risk: "R2", preconditions: ["registered UI fingerprint", ...state.sequence], verification: ["remixed duration and clip state readback"] },
  { id: "audio.loudness", title: "Loudness measurement and normalization", status: "UI_ADAPTER_REQUIRED", backends: ["ui"], risk: "R2", preconditions: ["registered UI fingerprint", ...state.sequence], verification: ["measured loudness and applied gain readback"] },
]);
