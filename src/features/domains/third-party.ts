import { defineDomain, state } from "../registry-contract.js";

export const thirdPartyFeatures = defineDomain("third-party-native-hybrid", [
  { id: "plugin.inventory", title: "Plugin inventory", status: "SUPPORTED_CONTEXTUAL", backends: ["local", "uxp", "cep"], risk: "R0", preconditions: state.inspect, verification: ["typed plugin catalog readback"] },
  { id: "plugin.adapters", title: "Typed third-party plugin adapters", status: "THIRD_PARTY_DEPENDENT", backends: ["ui", "native"], risk: "R3", preconditions: ["installed allowlisted plugin", "versioned typed adapter"], verification: ["adapter-specific postcondition readback"] },
  { id: "native.codec_importer_exporter", title: "Codec, importer, and exporter plugins", status: "THIRD_PARTY_DEPENDENT", backends: ["native"], risk: "R3", preconditions: ["installed signed compatible native plugin"], verification: ["host plugin registration and media round-trip evidence"] },
  { id: "native.hardware_sdk", title: "Hardware SDK integration", status: "THIRD_PARTY_DEPENDENT", backends: ["native"], risk: "R3", preconditions: ["supported hardware", "signed compatible driver and plugin"], verification: ["device enumeration and frame/audio I/O evidence"] },
  { id: "native.high_performance_video", title: "High-performance video processing", status: "THIRD_PARTY_DEPENDENT", backends: ["native"], risk: "R3", preconditions: ["signed compatible native plugin", "supported GPU and format"], verification: ["frame checksum and performance evidence"] },
  { id: "native.high_performance_audio", title: "High-performance audio processing", status: "THIRD_PARTY_DEPENDENT", backends: ["native"], risk: "R3", preconditions: ["signed compatible native plugin", "supported audio format"], verification: ["audio checksum and performance evidence"] },
  { id: "native.ml", title: "Native machine-learning integration", status: "THIRD_PARTY_DEPENDENT", backends: ["native", "service"], risk: "R3", preconditions: ["approved model and runtime", "signed compatible adapter"], verification: ["model/version receipt and deterministic fixture evidence"] },
]);
