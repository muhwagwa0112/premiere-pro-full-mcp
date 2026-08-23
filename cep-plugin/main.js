(function () {
  "use strict";
  var childProcess = require("child_process");
  var crypto = require("crypto");
  var fs = require("fs");
  var path = require("path");
  var cs = new CSInterface();
  var extensionRoot = path.resolve(__dirname);
  var installedSuffix = path.join("AppData", "Roaming", "Adobe", "CEP", "extensions", "com.local.ppmcp.cep.2026");
  if (extensionRoot.toLowerCase().slice(-installedSuffix.length) !== installedSuffix.toLowerCase()) {
    throw new Error("CEP bridge must run from its trusted installed extension directory");
  }
  var profileRoot = extensionRoot.slice(0, extensionRoot.length - installedSuffix.length);
  var localAppData = path.join(profileRoot, "AppData", "Local");
  var directory = path.join(localAppData, "PremiereMCP", "cep");
  var helper = path.join(localAppData, "PremiereMCP", "bin", "PremiereMcp.WindowsUiAgent.exe");
  var busy = false;
  var MAX_BYTES = 1024 * 1024;
  var usedNonces = {};
  var sessionId = base64url(crypto.randomBytes(18));
  var started = false;
  var hostLoaderPrefix = "";
  var issuedCapabilities = {};
  var issuedCapabilityCount = 0;
  var leader = false;
  var leaderAcquiredAt = 0;
  var lastLeaderRenewal = 0;
  var writeCounter = 0;
  var leaderPath = path.join(directory, "bridge-owner.lock");
  var LEADER_LEASE_MS = 60000;
  var allowed = {
    cep: { "host.inspect": true, "project.inspect": true, "sequence.inspect": true, "project.create": true, "project.save": true, "project.open": true, "media.import": true, "timeline.sequence.create_from_media": true, "export.sequence": true, "workspace.set": true, "cep.surface.catalog": true, "cep.read": true, "cep.edit": true, "cep.filesystem": true, "cep.destructive": true },
    qe: { "host.inspect": true, "project.inspect": true, "sequence.inspect": true, "qe.catalog": true, "qe.read": true, "qe.edit": true, "qe.destructive": true }
  };
  fs.mkdirSync(directory, { recursive: true });

  function processIsAlive(pid) {
    if (typeof pid !== "number" || pid < 1) return false;
    try { process.kill(pid, 0); return true; } catch (_) { return false; }
  }

  function acquireLeadership() {
    if (leader) return true;
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        var descriptor = fs.openSync(leaderPath, "wx", 384);
        leaderAcquiredAt = Date.now();
        lastLeaderRenewal = leaderAcquiredAt;
        fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, sessionId: sessionId, acquiredAt: leaderAcquiredAt, renewedAt: lastLeaderRenewal }), "utf8");
        fs.closeSync(descriptor);
        leader = true;
        return true;
      } catch (error) {
        if (!error || error.code !== "EEXIST") return false;
        try {
          var owner = JSON.parse(fs.readFileSync(leaderPath, "utf8"));
          var renewedAt = Number(owner.renewedAt || owner.acquiredAt || 0);
          if (processIsAlive(owner.pid) && Date.now() - renewedAt <= LEADER_LEASE_MS) return false;
        } catch (_) {}
        try { fs.unlinkSync(leaderPath); } catch (_) { return false; }
      }
    }
    return false;
  }

  function renewLeadership() {
    if (!leader) return false;
    try {
      var owner = JSON.parse(fs.readFileSync(leaderPath, "utf8"));
      if (owner.pid !== process.pid || owner.sessionId !== sessionId) { leader = false; return false; }
      var now = Date.now();
      if (now - lastLeaderRenewal >= 2000) {
        lastLeaderRenewal = now;
        atomicWrite(leaderPath, { pid: process.pid, sessionId: sessionId, acquiredAt: leaderAcquiredAt, renewedAt: now });
      }
      return true;
    } catch (_) {
      leader = false;
      return false;
    }
  }

  function releaseLeadership() {
    if (!leader) return;
    try {
      var owner = JSON.parse(fs.readFileSync(leaderPath, "utf8"));
      if (owner.pid === process.pid && owner.sessionId === sessionId) fs.unlinkSync(leaderPath);
    } catch (_) {}
    leader = false;
  }

  process.on("exit", releaseLeadership);

  function canonical(value) {
    var keys;
    var index;
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) {
      var items = [];
      for (index = 0; index < value.length; index++) items.push(canonical(value[index]));
      return "[" + items.join(",") + "]";
    }
    keys = Object.keys(value).sort();
    var pairs = [];
    for (index = 0; index < keys.length; index++) pairs.push(JSON.stringify(keys[index]) + ":" + canonical(value[keys[index]]));
    return "{" + pairs.join(",") + "}";
  }

  function base64url(buffer) {
    return buffer.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  }

  function sign(value) {
    var result = childProcess.spawnSync(helper, ["--hmac", "cep-hmac", "sign", "premiere"], { input: canonical(value), encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 4096 });
    if (result.error || result.status !== 0 || !/^[A-Za-z0-9_-]{43}$/.test(String(result.stdout || "").trim())) throw new Error("CEP signing broker rejected the caller");
    return String(result.stdout).trim();
  }

  function verify(value, signature) {
    if (typeof signature !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
    var result = childProcess.spawnSync(helper, ["--hmac", "cep-hmac", "verify", "premiere", signature], { input: canonical(value), encoding: "utf8", windowsHide: true, timeout: 10000, maxBuffer: 4096 });
    return !result.error && result.status === 0;
  }

  function withoutSignature(value) {
    var copy = {};
    Object.keys(value).forEach(function (key) { if (key !== "signature") copy[key] = value[key]; });
    return copy;
  }

  function atomicWrite(filename, value) {
    var temporary = filename + "." + process.pid + "." + (++writeCounter) + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", mode: 384 });
    try { fs.renameSync(temporary, filename); }
    catch (error) { try { fs.unlinkSync(temporary); } catch (_) {} throw error; }
  }

  function signedResponse(response, nonce) {
    var unsigned = {};
    Object.keys(response).forEach(function (key) { if (key !== "signature") unsigned[key] = response[key]; });
    unsigned.bridgeNonce = nonce;
    unsigned.issuedAt = Date.now();
    unsigned.signature = sign(unsigned);
    return unsigned;
  }

  function failure(requestId, code, message) {
    return { protocolVersion: 1, requestId: requestId || "unknown", ok: false, error: { code: code, message: message, retryable: false } };
  }

  function heartbeat() {
    if (!renewLeadership()) return;
    cs.evalScript("(function(){" + hostLoaderPrefix + "return PPMCP.heartbeat();}())", function (raw) {
      try {
        var host = {};
        try { host = JSON.parse(raw); } catch (_) {}
        var unsigned = { timestamp: Date.now(), hostVersion: host.hostVersion || "unknown", capabilities: host.capabilities || ["typed"], nonce: base64url(crypto.randomBytes(18)), sessionId: sessionId };
        unsigned.signature = sign(unsigned);
        atomicWrite(path.join(directory, "heartbeat.json"), unsigned);
      } catch (_) {
        // A transient broker or filesystem failure must not terminate the timer.
      }
    });
  }

  function nextCommand() {
    return fs.readdirSync(directory).filter(function (name) { return /^command-[0-9a-f-]+\.json$/i.test(name); }).sort()[0] || null;
  }

  function validateRequest(request, filename) {
    var now = Date.now();
    var filenameNonce = filename.slice("command-".length, -".json".length);
    if (!request || request.protocolVersion !== 1 || typeof request.requestId !== "string" || typeof request.backend !== "string" || typeof request.operation !== "string" || !request.args || typeof request.args !== "object") throw new Error("Invalid typed operation envelope");
    if (typeof request.nonce !== "string" || request.nonce !== filenameNonce || usedNonces[request.nonce]) throw new Error("Invalid or replayed command nonce");
    if (request.sessionId !== sessionId) throw new Error("Command belongs to a different CEP session");
    if (typeof request.issuedAt !== "number" || typeof request.expiresAt !== "number" || request.issuedAt > now + 5000 || request.expiresAt < now || request.expiresAt - request.issuedAt > 60000) throw new Error("Command freshness check failed");
    if (!verify(withoutSignature(request), request.signature)) throw new Error("Command signature is invalid");
    if (!allowed[request.backend] || !allowed[request.backend][request.operation]) throw new Error("Backend operation is not allowlisted");
    usedNonces[request.nonce] = request.expiresAt;
    Object.keys(usedNonces).forEach(function (nonce) { if (usedNonces[nonce] < now) delete usedNonces[nonce]; });
  }

  function poll() {
    if (!renewLeadership()) return;
    if (busy) return;
    var filename;
    try { filename = nextCommand(); } catch (_) { return; }
    if (!filename) return;
    busy = true;
    var commandPath = path.join(directory, filename);
    var responsePath = path.join(directory, filename.replace("command-", "response-"));
    var request;
    var nonce = filename.slice("command-".length, -".json".length);
    try {
      var stats = fs.statSync(commandPath);
      if (stats.size > MAX_BYTES) throw new Error("Command exceeds 1 MiB");
      request = JSON.parse(fs.readFileSync(commandPath, "utf8"));
      validateRequest(request, filename);
      var hostArgs = {};
      Object.keys(request.args).forEach(function (key) { hostArgs[key] = request.args[key]; });
      if (/^(cep|qe)\.(read|edit|filesystem|destructive)$/.test(request.operation)) {
        var issued = issuedCapabilities[request.args.capabilityId];
        if (!issued) throw new Error("Capability was not issued by this CEP session");
        hostArgs._capability = issued;
      }
      var hostRequest = { protocolVersion: 1, requestId: request.requestId, operation: request.operation, args: hostArgs };
      if (request.expectedRevision) hostRequest.expectedRevision = request.expectedRevision;
      var script = "(function(){" + hostLoaderPrefix + "return PPMCP.dispatch(" + JSON.stringify(JSON.stringify(hostRequest)) + ");}())";
      cs.evalScript(script, function (raw) {
        var response;
        try { response = JSON.parse(raw); } catch (_) { response = failure(request.requestId, "CEP_RESULT_PARSE_ERROR", "Host returned invalid JSON"); }
        if ((request.operation === "cep.surface.catalog" || request.operation === "qe.catalog") && !request.args.objectRef && response.ok && response.result && response.result.entries) {
          if (issuedCapabilityCount >= 8192) { issuedCapabilities = {}; issuedCapabilityCount = 0; }
          response.result.entries.forEach(function (entry) {
            if (!entry || typeof entry.capabilityId !== "string" || typeof entry.name !== "string") return;
            issuedCapabilities[entry.capabilityId] = { root: request.args.root || (request.backend === "qe" ? "qeProject" : "app"), name: entry.name, kind: entry.kind, bucket: entry.bucket, qeMode: request.backend === "qe" };
            issuedCapabilityCount++;
          });
        }
        try { atomicWrite(responsePath, signedResponse(response, request.nonce)); } finally { try { fs.unlinkSync(commandPath); } catch (_) {} busy = false; }
      });
    } catch (error) {
      atomicWrite(responsePath, signedResponse(failure(request && request.requestId, "CEP_BRIDGE_REJECTED", String(error.message || error)), nonce));
      try { fs.unlinkSync(commandPath); } catch (_) {}
      busy = false;
    }
  }

  function initializeHost() {
    if (!acquireLeadership()) {
      setTimeout(initializeHost, 2000);
      return;
    }
    var extensionDirectory = cs.getSystemPath("extension");
    if (!extensionDirectory) throw new Error("CEP extension path is unavailable");
    var jsonPath = path.join(extensionDirectory, "json2.jsx").replace(/\\/g, "/");
    var hostPath = path.join(extensionDirectory, "host.jsx").replace(/\\/g, "/");
    hostLoaderPrefix = "$.evalFile(File(" + JSON.stringify(jsonPath) + "));$.evalFile(File(" + JSON.stringify(hostPath) + "));";
    var bootstrapScript = "(function(){try{" + hostLoaderPrefix + "return (typeof PPMCP === \"object\" && typeof PPMCP.heartbeat === \"function\" ? \"ready\" : \"unavailable\");}catch(error){return \"error|line=\" + String(error.line || \"unknown\") + \"|message=\" + String(error.message || error);}}())";
    cs.evalScript(bootstrapScript, function (raw) {
      if (raw !== "ready") {
        var unavailable = { timestamp: Date.now(), hostVersion: "unknown", capabilities: [], nonce: base64url(crypto.randomBytes(18)), sessionId: sessionId };
        unavailable.signature = sign(unavailable);
        atomicWrite(path.join(directory, "heartbeat.json"), unavailable);
        setTimeout(initializeHost, 2000);
        return;
      }
      if (started) return;
      started = true;
      heartbeat();
      setInterval(heartbeat, 2000);
      setInterval(poll, 200);
    });
  }

  initializeHost();
}());
