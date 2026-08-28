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
  var APPROVED_EXTENSION_ID = "com.codex.premiere-pro-full-mcp.cep.headless";
  var BRIDGE_PROTOCOL_VERSION = 1;
  var runtimeInstanceId = createRuntimeInstanceId();

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
    sendOn(socket, message);
  }

  function sendOn(target, message) {
    if (target && target.readyState === 1) {
      try { target.send(JSON.stringify(message)); } catch (_) {}
    }
  }

  function normalizeTimeout(value, fallback) {
    var min = 250;
    var max = 300000;
    var base = (typeof fallback === "number" && isFinite(fallback)) ? Math.floor(fallback) : max;
    base = Math.min(max, Math.max(min, base));
    if (typeof value !== "number" || !isFinite(value)) return base;
    return Math.min(max, Math.max(min, Math.floor(value)));
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

  function createRuntimeInstanceId() {
    try {
      var crypto = require("crypto");
      if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    } catch (_) {}
    return "cep-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + "-" + Math.random().toString(36).slice(2);
  }

  function extensionId() {
    try {
      if (cs && typeof cs.getExtensionID === "function") {
        var id = String(cs.getExtensionID() || "");
        if (id) return id;
      }
    } catch (_) {}
    return APPROVED_EXTENSION_ID;
  }

  function bridgeVersion() {
    try {
      var manifestPath = path.join(__dirname, "CSXS", "manifest.xml");
      var manifest = fs.readFileSync(manifestPath, "utf8");
      var extensionPattern = /<Extension\s+Id="([^"]+)"\s+Version="([^"]+)"/g;
      var match = null;
      var candidate;
      while ((candidate = extensionPattern.exec(manifest)) !== null) {
        if (candidate[1] === APPROVED_EXTENSION_ID) { match = [candidate[0], candidate[2]]; break; }
      }
      match = match || /ExtensionBundleVersion="([^"]+)"/.exec(manifest);
      if (match && match[1]) return String(match[1]);
    } catch (_) {}
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
      var premiereVersion = hostVersion();
      var version = bridgeVersion();
      send({
        kind: "ready",
        identity: {
          extensionId: extensionId(),
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          instanceId: runtimeInstanceId,
          bridgeVersion: version || undefined
        },
        premiereVersion: premiereVersion || undefined
      });
      console.log("[premiere-mcp] bridge connected to " + url);
    };
    ws.onmessage = function (event) {
      var msg;
      var text = dataToString(event && event.data);
      try { msg = JSON.parse(text); } catch (_) { return; }
      if (msg.kind === "hello") {
        if (msg.ok === false) console.error("[premiere-mcp] bridge host rejected: " + String(msg.error && msg.error.code || "CEP_HOST_REJECTED"));
        return;
      }
      if (msg.kind === "execute") handleExecute(msg, ws);
      if (msg.kind === "host_probe") handleHostProbe(msg, ws);
      if (msg.kind === "dom_readiness_probe") handleDomReadinessProbe(msg, ws);
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
  function handleExecute(msg, ownerSocket) {
    var requestId = msg.requestId;
    var script = String(msg.script || "");
    var timeoutMs = normalizeTimeout(msg.timeoutMs, 300000);
    var settled = false;
    var timedOut = false;
    var timeoutId = setTimeout(function () {
      if (settled) return;
      settled = true;
      timedOut = true;
      sendOn(ownerSocket, { kind: "response", requestId: requestId, ok: false, error: {
        code: "EXTENDSCRIPT_TIMEOUT",
        message: "ExtendScript execution timed out after " + timeoutMs + "ms",
        retryable: false,
        outcomeUnknown: true
      }, operation: msg.operation });
    }, timeoutMs);

    try {
      cs.evalScript(script, function (result) {
        if (timedOut) {
          var lateText = (typeof result === "string") ? result : String(result || "");
          var lateError = lateText.indexOf("EvalScript error") === 0 || lateText.indexOf("Error") === 0;
          sendOn(ownerSocket, lateError
            ? { kind: "late_completion", requestId: requestId, ok: false, error: { code: "EXTENDSCRIPT_ERROR", message: lateText }, operation: msg.operation }
            : { kind: "late_completion", requestId: requestId, ok: true, data: lateText, operation: msg.operation });
          return;
        }
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        var text = (typeof result === "string") ? result : String(result || "");
        if (text.indexOf("EvalScript error") === 0 || text.indexOf("Error") === 0) {
          sendOn(ownerSocket, { kind: "response", requestId: requestId, ok: false, error: {
            code: "EXTENDSCRIPT_ERROR",
            message: text
          }});
          return;
        }
        sendOn(ownerSocket, { kind: "response", requestId: requestId, ok: true, data: text });
      });
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      sendOn(ownerSocket, { kind: "response", requestId: requestId, ok: false, error: {
        code: "EXTENDSCRIPT_ERROR",
        message: String(e && e.message ? e.message : e)
      }});
    }
  }

  function handleHostProbe(msg, ownerSocket) {
    var requestId = msg.requestId;
    var timeoutMs = normalizeTimeout(msg.timeoutMs, 5000);
    var settled = false;
    var timeoutId = setTimeout(function () {
      if (settled) return;
      settled = true;
      sendOn(ownerSocket, { kind: "response", requestId: requestId, ok: false, error: {
        code: "HOST_PROBE_TIMEOUT",
        message: "Premiere host probe timed out after " + timeoutMs + "ms"
      }});
    }, timeoutMs);
    try {
      cs.evalScript("(function(){return 'PREMIERE_MCP_HOST_OK';})();", function (result) {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        if (String(result || "") !== "PREMIERE_MCP_HOST_OK") {
          sendOn(ownerSocket, { kind: "response", requestId: requestId, ok: false, error: {
            code: "HOST_PROBE_FAILED",
            message: "Premiere host probe returned an unexpected result"
          }});
          return;
        }
        sendOn(ownerSocket, { kind: "response", requestId: requestId, ok: true, data: true });
      });
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      sendOn(ownerSocket, { kind: "response", requestId: requestId, ok: false, error: {
        code: "HOST_PROBE_FAILED",
        message: String(e && e.message ? e.message : e)
      }});
    }
  }

  function handleDomReadinessProbe(msg, ownerSocket) {
    var requestId = msg.requestId;
    var timeoutMs = normalizeTimeout(msg.timeoutMs, 5000);
    var settled = false;
    var timeoutId = setTimeout(function () {
      if (settled) return;
      settled = true;
      sendOn(ownerSocket, { kind: "response", requestId: requestId, ok: false, error: {
        code: "DOM_READINESS_TIMEOUT",
        message: "Premiere DOM readiness probe timed out after " + timeoutMs + "ms"
      }});
    }, timeoutMs);
    var script = "(function(){" +
      "function q(v){return '\"'+String(v).replace(/[\\\\\"\\x00-\\x1f]/g,function(c){" +
        "if(c==='\"')return '\\\\u0022';if(c==='\\\\')return '\\\\u005c';" +
        "if(c==='\\b')return '\\\\b';if(c==='\\f')return '\\\\f';if(c==='\\n')return '\\\\n';if(c==='\\r')return '\\\\r';if(c==='\\t')return '\\\\t';" +
        "var h=c.charCodeAt(0).toString(16);return '\\\\u'+('0000'+h).substring(h.length);})+'\"';}" +
      "function j(v){if(v===null)return 'null';var t=typeof v;if(t==='string')return q(v);" +
        "if(t==='boolean')return v?'true':'false';if(t==='number')return isFinite(v)?String(v):'null';" +
        "if(t==='undefined'||t==='function')return undefined;if(v instanceof Array){var a=[];for(var i=0;i<v.length;i++){var x=j(v[i]);a.push(x===undefined?'null':x);}return '['+a.join(',')+']';}" +
        "var p=[];for(var k in v){if(v.hasOwnProperty&&!v.hasOwnProperty(k))continue;var x=j(v[k]);if(x!==undefined)p.push(q(k)+':'+x);}return '{'+p.join(',')+'}';}" +
      "try{" +
      "var p=app.project;" +
      "var s=p?p.activeSequence:null;" +
      "return j({ok:true,projectOpen:!!p,projectName:p?String(p.name||''):null,activeSequence:s?{id:String(s.sequenceID||''),name:String(s.name||'')}:null});" +
      "}catch(e){return j({ok:false,error:String(e&&e.message?e.message:e)});}})();";
    try {
      cs.evalScript(script, function (result) {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        var text = (typeof result === "string") ? result : String(result || "");
        if (text.indexOf("EvalScript error") === 0 || text.indexOf("Error") === 0) {
          sendOn(ownerSocket, { kind: "response", requestId: requestId, ok: false, error: {
            code: "EXTENDSCRIPT_ERROR", message: text
          }});
          return;
        }
        var payload;
        try { payload = JSON.parse(text); } catch (_) {
          sendOn(ownerSocket, { kind: "response", requestId: requestId, ok: false, error: {
            code: "DOM_READINESS_INVALID_RESPONSE", message: "Premiere DOM readiness probe returned malformed JSON"
          }});
          return;
        }
        if (!payload || payload.ok !== true) {
          sendOn(ownerSocket, { kind: "response", requestId: requestId, ok: false, error: {
            code: "DOM_PROBE_SCRIPT_ERROR", message: String(payload && payload.error || "Premiere DOM readiness script failed")
          }});
          return;
        }
        sendOn(ownerSocket, { kind: "response", requestId: requestId, ok: true, data: payload });
      });
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      sendOn(ownerSocket, { kind: "response", requestId: requestId, ok: false, error: {
        code: "EXTENDSCRIPT_ERROR", message: String(e && e.message ? e.message : e)
      }});
    }
  }

  connect();
})();
