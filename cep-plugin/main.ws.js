(function () {
  "use strict";
  /* Always-on bridge client hosted inside Premiere Pro's CEP panel.
   *
   * Connects automatically to the always-on bridge daemon (fixed port,
   * published at %LOCALAPPDATA%\PremiereMCP\bridge-endpoint.json) and stays
   * connected for as long as Premiere is open. The daemon relays ExtendScript
   * from MCP servers as { kind: "execute" } messages; this client runs each
   * script via CSInterface.evalScript (CALLBACK-based, never the broken
   * synchronous form) and replies { kind: "response" }.
   *
   * No auth, no polling, no manual "start the bridge" step.
   */

  var fs = require("fs");
  var path = require("path");
  var os = require("os");

  var WebSocket = global.WebSocket;
  if (!WebSocket && typeof require === "function") {
    try { WebSocket = require("ws"); } catch (_) { WebSocket = null; }
  }
  if (!WebSocket) {
    console.error("[premiere-mcp] WebSocket unavailable in this CEP runtime");
    return;
  }

  var endpointFile = path.join(
    os.homedir ? os.homedir() : process.env.USERPROFILE,
    "AppData", "Local", "PremiereMCP", "bridge-endpoint.json"
  );
  var cs = (typeof CSInterface !== "undefined") ? new CSInterface() : null;
  var socket = null;
  var connected = false;
  var retryTimer = null;
  var closeRequested = false;

  if (!cs) {
    console.error("[premiere-mcp] CSInterface unavailable; cannot run ExtendScript");
    return;
  }

  function readEndpoint() {
    try {
      var parsed = JSON.parse(fs.readFileSync(endpointFile, "utf8"));
      if (parsed && typeof parsed.port === "number" && parsed.host === "127.0.0.1") return parsed;
    } catch (_) {}
    return null;
  }

  function send(message) {
    if (socket && socket.readyState === 1) {
      try { socket.send(JSON.stringify(message)); } catch (_) {}
    }
  }

  function dataToString(data) {
    // CEP DOM WebSocket delivers event.data as a string; the `ws` polyfill can
    // deliver a Buffer/ArrayBuffer or an array of them. Normalize to text.
    try {
      if (typeof data === "string") return data;
      if (data instanceof Array && data.length === 1) return dataToString(data[0]);
      if (data instanceof ArrayBuffer) {
        var buf = new Uint8Array(data);
        var out = "";
        for (var i = 0; i < buf.length; i++) out += String.fromCharCode(buf[i]);
        return decodeURIComponent(escape(out));
      }
      if (typeof Buffer !== "undefined" && typeof Buffer.isBuffer === "function" && Buffer.isBuffer(data)) return data.toString("utf8");
      if (data && typeof data.buffer !== "undefined" && data.buffer instanceof ArrayBuffer && typeof data.length === "number") {
        var u8 = new Uint8Array(data.buffer, data.byteOffset || 0, data.length);
        var s = "";
        for (var j = 0; j < u8.length; j++) s += String.fromCharCode(u8[j]);
        return decodeURIComponent(escape(s));
      }
      return String(data);
    } catch (_) {
      try { return String(data); } catch (_2) { return ""; }
    }
  }

  function hostVersion() {
    try {
      if (cs && typeof cs.getHostEnvironment === "function") {
        var env = cs.getHostEnvironment();
        if (env && env.appVersion) return String(env.appVersion);
      }
    } catch (_) {}
    // `app` does not exist in the CEP panel JS context; only fall back in case
    // some runtime does expose it.
    try { if (typeof app !== "undefined" && app && app.version) return String(app.version); } catch (_) {}
    return "";
  }

  function connect() {
    if (connected || closeRequested) return;
    var endpoint = readEndpoint();
    if (!endpoint) {
      scheduleRetry();
      return;
    }
    var url = "ws://127.0.0.1:" + endpoint.port + "/bridge";
    var ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      scheduleRetry();
      return;
    }
    socket = ws;
    ws.onopen = function () {
      connected = true;
      // Announce as the executing host so the daemon routes scripts here.
      send({ kind: "ready", version: hostVersion() });
      console.log("[premiere-mcp] bridge connected to " + url);
    };
    ws.onmessage = function (event) {
      var msg;
      var text = dataToString(event && event.data);
      try { msg = JSON.parse(text); } catch (_) { return; }
      if (msg.kind === "hello") return;
      if (msg.kind === "execute") handleExecute(msg);
    };
    ws.onclose = function () {
      connected = false;
      socket = null;
      if (closeRequested) return;
      scheduleRetry();
    };
    ws.onerror = function () {
      if (ws) { try { ws.close(); } catch (_) {} }
    };
  }

  function scheduleRetry() {
    if (retryTimer || closeRequested) return;
    retryTimer = setTimeout(function () {
      retryTimer = null;
      connect();
    }, 2000);
  }

  /**
   * Run one ExtendScript from an MCP request and reply with the result.
   *
   * CRITICAL: CSInterface.evalScript is asynchronous and callback-based. The
   * old build tried `evalScript(script, false)` expecting a synchronous return,
   * which is always undefined in CEP. Here we pass a real callback.
   */
  function handleExecute(msg) {
    var requestId = msg.requestId;
    var script = String(msg.script || "");
    var timeoutMs = (typeof msg.timeoutMs === "number" && msg.timeoutMs > 45000) ? msg.timeoutMs : 45000;
    var settled = false;
    var timeoutId = setTimeout(function () {
      if (settled) return;
      settled = true;
      send({ kind: "response", requestId: requestId, ok: false, error: {
        code: "EXTENDSCRIPT_TIMEOUT",
        message: "ExtendScript execution timed out after " + timeoutMs + "ms"
      }});
    }, timeoutMs);

    try {
      cs.evalScript(script, function (result) {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        var text = (typeof result === "string") ? result : String(result || "");
        if (text.indexOf("EvalScript error") === 0 || text.indexOf("Error") === 0) {
          send({ kind: "response", requestId: requestId, ok: false, error: {
            code: "EXTENDSCRIPT_ERROR",
            message: text
          }});
          return;
        }
        send({ kind: "response", requestId: requestId, ok: true, data: text });
      });
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      send({ kind: "response", requestId: requestId, ok: false, error: {
        code: "EXTENDSCRIPT_ERROR",
        message: String(e && e.message ? e.message : e)
      }});
    }
  }

  connect();
})();
