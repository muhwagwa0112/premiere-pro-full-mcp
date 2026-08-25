/**
 * Runtime configuration. All values can be overridden with environment
 * variables so the server never hard-codes a host product, version, port,
 * or storage root.
 *
 * The default target is intentionally broad: a Windows workstation running
 * Adobe Premiere Pro 2026 (26.x). Each backend adapter reports the actual
 * installed host version at runtime, which is authoritative over any value
 * here.
 */

export interface PremiereRuntimeConfig {
  /** Human-readable product family used in capability reports. */
  product: string;
  /** Minimum major/minor host version accepted by the local inventory. */
  minimumHostVersion: string;
  /** Preferred local WebSocket port for the UXP bridge. */
  uxpPort: number;
  /** Adobe product code used for UXP/CEP manifests. */
  appCode: string;
  /** Relative UXP plug-in storage folder under AppData/Roaming/Adobe/UXP. */
  uxpPluginsStorage: string;
  /** Storage root for operation ledger, job store, confirmations. */
  dataRoot: string;
  /** Approved local roots (semicolon separated). */
  approvedRoots: string;
}

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

const DEFAULT_UXP_PORT = Number.parseInt(env("PREMIERE_MCP_UXP_PORT", ""), 10);

export function loadRuntimeConfig(): PremiereRuntimeConfig {
  return {
    product: env("PREMIERE_MCP_PRODUCT", "Adobe Premiere Pro 2026"),
    minimumHostVersion: env("PREMIERE_MCP_MIN_HOST_VERSION", "26.3"),
    uxpPort: Number.isInteger(DEFAULT_UXP_PORT) && DEFAULT_UXP_PORT > 1024 && DEFAULT_UXP_PORT < 65536 ? DEFAULT_UXP_PORT : 17_777,
    appCode: "PPRO",
    uxpPluginsStorage: env("PREMIERE_MCP_UXP_PLUGIN_STORAGE", "PluginsStorage\\PPRO"),
    dataRoot: env("LOCALAPPDATA", ""),
    approvedRoots: env("PREMIERE_MCP_APPROVED_ROOTS", ""),
  };
}

export const runtimeConfig = loadRuntimeConfig();
