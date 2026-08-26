/**
 * Wire contract between the MCP server (Node), the always-on bridge daemon,
 * and the Premiere CEP host.
 *
 * Local-first: no auth, no signatures, no nonces, no session tokens.
 *
 * The daemon is a small loopback WebSocket router that stays up permanently
 * (installed to auto-start at logon). Two kinds of clients connect to it:
 *
 *   1. The Premiere CEP extension — announces with kind:"ready", receives
 *      kind:"execute" messages carrying an ExtendScript string, runs it via
 *      CSInterface.evalScript (callback), and replies kind:"response".
 *   2. MCP servers — send kind:"execute" messages; the daemon forwards them
 *      to the CEP host and relays the reply back to the requesting MCP client.
 *
 * This is a strict request/response relay, one script per request.
 */

/** Message a client (MCP server) sends to ask the host to run a script. */
export interface ExecuteRequest {
  kind: "execute";
  requestId: string;
  /** Full ExtendScript source (already wrapped to return a JSON string). */
  script: string;
  /** Optional execution budget in ms. The CEP host honours it per call. */
  timeoutMs?: number;
}

/** Message the CEP host sends to answer an ExecuteRequest. */
export interface ExecuteResponse {
  kind: "response";
  requestId: string;
  ok: boolean;
  /** Raw result produced by evalScript (usually a JSON string). */
  data?: unknown;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
}

/** Message the CEP host sends upon (re)connecting. */
export interface ReadyMessage {
  kind: "ready";
  version?: string;
}

/** Message the daemon sends to a ready CEP host. */
export interface HelloMessage {
  kind: "hello";
  ok: true;
  port: number;
}

export type BridgeMessage = ExecuteRequest | ExecuteResponse | ReadyMessage | HelloMessage;

/** Information the daemon writes once so every client can find the port. */
export interface BridgeEndpoint {
  port: number;
  host: "127.0.0.1";
  protocol: "ws";
}
