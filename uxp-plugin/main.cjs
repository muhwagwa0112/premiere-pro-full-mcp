const ppro = require("premierepro");
const uxp = require("uxp");
const API_CATALOG = require("./api-catalog.cjs");
const { AUTH_FILE_NAME, authenticationTranscript, constantTimeHexEqual, hmacSha256Hex, randomHex } = require("./auth.cjs");

const CAPABILITIES = [
  "host.inspect", "project.inspect", "sequence.inspect", "project.save", "project.close_disposable", "project.checkpoint", "captions.inspect",
  "media.relink", "media.proxy.attach", "timeline.track.set_mute", "timeline.clip.insert",
  "export.frame", "export.sequence",
  "uxp.catalog", "uxp.read", "uxp.edit", "uxp.sensitive", "uxp.filesystem", "uxp.destructive", "uxp.handle.release",
  "uxp.page.read", "uxp.transaction.execute", "uxp.locked.batch", "uxp.events.subscribe", "uxp.events.poll", "uxp.events.unsubscribe"
];
const MEMBER_INDEX = new Map(API_CATALOG.entries.map((entry) => [entry.id, entry]));
const OPERATION_BY_BUCKET = { read: "uxp.read", edit: "uxp.edit", sensitive: "uxp.sensitive", filesystem: "uxp.filesystem", destructive: "uxp.destructive" };
const handles = new Map();
const subscriptions = new Map();
const managedCallbacks = new Map();
const callbackEvents = [];
const sessionPrefix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
let handleCounter = 0;
let socket = null;
let connectedSessionId = null;
let reconnectTimer = null;
let bridgeIdentityPromise = null;
let liveProbe = { status: "not_run", availableRoots: 0, unavailableRoots: [], probedRootMembers: 0, unavailableRootMembers: [] };

function status(message, kind) {
  const element = document.getElementById("status");
  element.textContent = message;
  element.className = kind || "";
}

async function bridgeIdentity() {
  if (bridgeIdentityPromise) return bridgeIdentityPromise;
  bridgeIdentityPromise = (async () => {
    const localFileSystem = uxp.storage.localFileSystem;
    const dataFolder = await localFileSystem.getDataFolder();
    let keyFile;
    try { keyFile = await dataFolder.getEntry(AUTH_FILE_NAME); }
    catch (_) { keyFile = await dataFolder.createFile(AUTH_FILE_NAME, { overwrite: true }); }
    let secret = "";
    try { secret = String(await keyFile.read()).trim().toLowerCase(); } catch (_) { secret = ""; }
    if (!/^[a-f0-9]{64}$/.test(secret)) {
      secret = randomHex(32);
      await keyFile.write(secret);
    }
    const authFilePath = localFileSystem.getNativePath(keyFile);
    if (typeof authFilePath !== "string" || !authFilePath) throw new Error("UXP authentication data path is unavailable");
    return { authFilePath, secret };
  })().catch((error) => {
    bridgeIdentityPromise = null;
    throw error;
  });
  return bridgeIdentityPromise;
}

function hash(input) {
  let value = 2166136261;
  const valueText = String(input || "");
  for (let index = 0; index < valueText.length; index += 1) {
    value ^= valueText.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return (value >>> 0).toString(16).padStart(8, "0");
}

async function activeContext() {
  const project = await ppro.Project.getActiveProject();
  const sequence = project ? await project.getActiveSequence() : null;
  return { project, sequence };
}

async function snapshotRevision(project, sequence) {
  if (!project) return "no-project";
  const sequences = Array.from(await project.getSequences() || []);
  return hash([project.guid || "", project.name || "", sequence && sequence.guid || "", sequences.map((item) => item.guid || "").join(",")].join("|"));
}

function safeSegments(path) {
  const segments = String(path || "").split(".");
  if (!segments.length || segments.some((segment) => !/^[A-Za-z_$][\w$]*$/.test(segment) || ["__proto__", "prototype", "constructor"].includes(segment))) {
    throw Object.assign(new Error("Catalog member path is invalid"), { code: "UXP_MEMBER_PATH_INVALID" });
  }
  return segments;
}

function nestedOwner(target, path) {
  const segments = safeSegments(path);
  let owner = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    owner = owner && owner[segments[index]];
    if (owner === null || owner === undefined) throw Object.assign(new Error("Catalog member owner is unavailable"), { code: "UXP_MEMBER_UNAVAILABLE" });
  }
  return { owner, key: segments[segments.length - 1] };
}

function probeCatalog() {
  const unavailableRoots = [];
  const unavailableRootMembers = [];
  let availableRoots = 0;
  let probedRootMembers = 0;
  for (const rootName of Object.keys(API_CATALOG.roots)) {
    if (ppro[rootName] === null || ppro[rootName] === undefined) unavailableRoots.push(rootName);
    else availableRoots += 1;
  }
  for (const entry of API_CATALOG.entries) {
    if (!entry.root || unavailableRoots.includes(entry.root)) continue;
    try {
      const resolved = nestedOwner(ppro[entry.root], entry.member);
      probedRootMembers += 1;
      if (!(resolved.key in resolved.owner)) unavailableRootMembers.push(entry.id);
    } catch (_) { unavailableRootMembers.push(entry.id); }
  }
  return { status: "probed", availableRoots, unavailableRoots, probedRootMembers, unavailableRootMembers: unavailableRootMembers.slice(0, 256), unavailableRootMemberCount: unavailableRootMembers.length, instanceMembers: "lazy_probe_on_typed_handle" };
}

function registerHandle(value, typeHint, projectIdentity) {
  expireHandles();
  if (handles.size >= 1024) handles.delete(handles.keys().next().value);
  const id = `${sessionPrefix}-${(++handleCounter).toString(36)}`;
  handles.set(id, { value, typeHint: String(typeHint || "unknown"), projectIdentity: projectIdentity || null, createdAt: Date.now(), expiresAt: Date.now() + 30 * 60 * 1000 });
  return { $ref: id, type: String(typeHint || "unknown"), session: sessionPrefix };
}

function expireHandles() {
  const now = Date.now();
  for (const [id, record] of handles) if (record.expiresAt <= now) handles.delete(id);
}

function handleRecord(id, session) {
  expireHandles();
  if (session && session !== sessionPrefix) throw Object.assign(new Error("Object handle belongs to another UXP session"), { code: "UXP_HANDLE_SESSION_MISMATCH" });
  const record = handles.get(id);
  if (!record) throw Object.assign(new Error("Object handle is unknown or expired"), { code: "UXP_HANDLE_NOT_FOUND" });
  record.expiresAt = Date.now() + 30 * 60 * 1000;
  return record;
}

function typeTokens(typeHint) {
  return new Set(String(typeHint || "").match(/[A-Za-z_$][\w$]*/g) || []);
}

function assertHandleType(record, expected) {
  const tokens = typeTokens(record.typeHint);
  let runtimeName = "";
  try { runtimeName = record.value && record.value.constructor && record.value.constructor.name || ""; } catch (_) { runtimeName = ""; }
  if (!tokens.has(expected) && runtimeName !== expected) throw Object.assign(new Error(`Handle type ${record.typeHint} cannot be used as ${expected}`), { code: "UXP_HANDLE_TYPE_MISMATCH" });
}

async function semanticStateMaterial(record) {
  const value = record.value;
  const tokens = typeTokens(record.typeHint);
  let runtimeName = "";
  try { runtimeName = value && value.constructor && value.constructor.name || ""; } catch (_) { runtimeName = ""; }
  if (tokens.has("Sequence") || runtimeName === "Sequence") {
    const videoCount = await value.getVideoTrackCount();
    const audioCount = await value.getAudioTrackCount();
    if (videoCount > 128 || audioCount > 128) throw Object.assign(new Error("Sequence exceeds the semantic state-token track limit"), { code: "UXP_SEMANTIC_SCOPE_TOO_LARGE" });
    const tracks = [];
    for (let index = 0; index < videoCount; index += 1) {
      const track = await value.getVideoTrack(index);
      const items = Array.from(await track.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || []);
      tracks.push(["v", index, await track.isMuted(), items.length]);
    }
    for (let index = 0; index < audioCount; index += 1) {
      const track = await value.getAudioTrack(index);
      tracks.push(["a", index, await track.isMuted()]);
    }
    return JSON.stringify({ type: "Sequence", projectIdentity: record.projectIdentity, guid: String(value.guid || ""), videoCount, audioCount, tracks });
  }
  if (tokens.has("ClipProjectItem") || runtimeName === "ClipProjectItem") {
    const mediaPath = typeof value.getMediaFilePath === "function" ? await value.getMediaFilePath() : "";
    const hasProxy = typeof value.hasProxy === "function" ? await value.hasProxy() : false;
    const proxyPath = hasProxy && typeof value.getProxyPath === "function" ? await value.getProxyPath() : "";
    return JSON.stringify({ type: "ClipProjectItem", projectIdentity: record.projectIdentity, guid: String(value.guid || value.nodeId || ""), name: String(value.name || ""), mediaPath: String(mediaPath || ""), hasProxy: !!hasProxy, proxyPath: String(proxyPath || "") });
  }
  if (tokens.has("ProjectItem") || runtimeName === "ProjectItem") {
    return JSON.stringify({ type: "ProjectItem", projectIdentity: record.projectIdentity, guid: String(value.guid || value.nodeId || ""), name: String(value.name || "") });
  }
  return null;
}

async function enrichSemanticHandleTokens(value, depth = 0) {
  if (depth > 8 || !value || typeof value !== "object") return;
  if (typeof value.$ref === "string") {
    const record = handleRecord(value.$ref, value.session);
    const material = await semanticStateMaterial(record);
    if (material !== null && record.projectIdentity) {
      record.semanticStateMaterial = material;
      record.semanticStateToken = `semantic-v1-${value.$ref}-${hash(material)}`;
      value.stateToken = record.semanticStateToken;
    }
    return;
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) await enrichSemanticHandleTokens(child, depth + 1);
}

async function semanticHandle(reference, expectedTypes, activeProjectIdentity) {
  if (!reference || typeof reference !== "object" || typeof reference.$ref !== "string" || typeof reference.session !== "string" || typeof reference.stateToken !== "string") {
    throw Object.assign(new Error("A session-scoped UXP object handle with a state token is required"), { code: "UXP_SEMANTIC_HANDLE_REQUIRED" });
  }
  const record = handleRecord(reference.$ref, reference.session);
  const types = Array.isArray(expectedTypes) ? expectedTypes : [expectedTypes];
  const matched = types.some((expected) => {
    try { assertHandleType(record, expected); return true; } catch (_) { return false; }
  });
  if (!matched) throw Object.assign(new Error(`Handle cannot be used as ${types.join(" or ")}`), { code: "UXP_HANDLE_TYPE_MISMATCH" });
  if (!record.projectIdentity || record.projectIdentity !== activeProjectIdentity) throw Object.assign(new Error("Object handle is not bound to the active project"), { code: "UXP_HANDLE_PROJECT_MISMATCH" });
  if (!record.semanticStateToken || reference.stateToken !== record.semanticStateToken) throw Object.assign(new Error("Object handle state token is invalid"), { code: "UXP_SEMANTIC_STATE_TOKEN_INVALID" });
  const currentMaterial = await semanticStateMaterial(record);
  if (currentMaterial === null || currentMaterial !== record.semanticStateMaterial) throw Object.assign(new Error("Target object state changed after the handle was issued"), { code: "UXP_SEMANTIC_STATE_STALE" });
  return record.value;
}

function sameWindowsPath(left, right) {
  return String(left || "").replace(/\//g, "\\").replace(/\\+$/g, "").toLowerCase() === String(right || "").replace(/\//g, "\\").replace(/\\+$/g, "").toLowerCase();
}

function decode(value, depth = 0) {
  if (depth > 8) throw Object.assign(new Error("Argument nesting exceeds the safe limit"), { code: "UXP_ARGUMENT_DEPTH" });
  if (Array.isArray(value)) return value.map((item) => decode(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  if (typeof value.$ref === "string") {
    const keys = Object.keys(value);
    if (keys.some((key) => !["$ref", "type", "session", "stateToken"].includes(key))) throw Object.assign(new Error("Handle reference contains unsupported properties"), { code: "UXP_HANDLE_SHAPE" });
    return handleRecord(value.$ref, value.session).value;
  }
  if (value.$callback && typeof value.$callback === "object") return callbackFromSpec(value.$callback);
  const output = {};
  const keys = Object.keys(value);
  if (keys.length > 256) throw Object.assign(new Error("Argument object has too many properties"), { code: "UXP_ARGUMENT_SIZE" });
  for (const key of keys) {
    if (["__proto__", "prototype", "constructor"].includes(key)) throw Object.assign(new Error("Unsafe argument property"), { code: "UXP_ARGUMENT_PROPERTY" });
    output[key] = decode(value[key], depth + 1);
  }
  return output;
}

function elementType(typeHint) {
  const value = String(typeHint || "unknown").replace(/^Promise<(.+)>$/, "$1").replace(/\s*\|\s*(null|undefined)/g, "").trim();
  const generic = /^(?:Readonly)?Array<(.+)>$/.exec(value);
  if (generic) return generic[1];
  if (value.endsWith("[]")) return value.slice(0, -2);
  return value;
}

function encode(value, typeHint, depth = 0, seen = new Set(), projectIdentity = null) {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value ?? null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return registerHandle(value, typeHint || "Function", projectIdentity);
  if (depth >= 6 || seen.has(value)) return registerHandle(value, typeHint, projectIdentity);
  seen.add(value);
  if (Array.isArray(value)) {
    const itemType = elementType(typeHint);
    const result = value.slice(0, 512).map((item) => encode(item, itemType, depth + 1, seen, projectIdentity));
    seen.delete(value);
    return value.length <= 512 ? result : { items: result, truncated: true, totalKnown: value.length, continuation: registerHandle({ kind: "page", items: value, itemType, offset: 512 }, "PagedResult", projectIdentity) };
  }
  let prototype;
  try { prototype = Object.getPrototypeOf(value); } catch (_) { prototype = null; }
  if (prototype === Object.prototype || prototype === null) {
    const output = {};
    const allKeys = Object.keys(value);
    if (allKeys.length > 256) {
      seen.delete(value);
      return { properties: Object.fromEntries(allKeys.slice(0, 256).map((key) => {
        try { return [key, encode(value[key], "unknown", depth + 1, seen, projectIdentity)]; } catch (_) { return [key, { unavailable: true }]; }
      })), truncated: true, totalKnown: allKeys.length, continuation: registerHandle({ kind: "objectPage", value, keys: allKeys, offset: 256 }, "PagedResult", projectIdentity) };
    }
    const keys = allKeys;
    for (const key of keys) {
      try { output[key] = encode(value[key], "unknown", depth + 1, seen, projectIdentity); } catch (_) { output[key] = { unavailable: true }; }
    }
    seen.delete(value);
    return output;
  }
  seen.delete(value);
  return registerHandle(value, typeHint || (value.constructor && value.constructor.name) || "PremiereObject", projectIdentity);
}

function targetFor(entry, target) {
  if (target && typeof target.$ref === "string") {
    const record = handleRecord(target.$ref, target.session);
    assertHandleType(record, entry.container);
    return record.value;
  }
  if (!entry.root) throw Object.assign(new Error(`${entry.container} requires a prior object handle`), { code: "UXP_HANDLE_REQUIRED" });
  const root = ppro[entry.root];
  if (root === null || root === undefined) throw Object.assign(new Error(`Premiere root ${entry.root} is unavailable`), { code: "UXP_ROOT_UNAVAILABLE" });
  return root;
}

function callbackFromSpec(spec) {
  const mode = String(spec.mode || "capture");
  const callbackId = typeof spec.id === "string" ? spec.id : `${sessionPrefix}-cb-${(++handleCounter).toString(36)}`;
  if (managedCallbacks.has(callbackId)) return managedCallbacks.get(callbackId);
  if (managedCallbacks.size >= 256) throw Object.assign(new Error("Managed callback limit reached for this UXP session"), { code: "UXP_CALLBACK_LIMIT" });
  if (mode === "noop") {
    const callback = function () {};
    managedCallbacks.set(callbackId, callback);
    return callback;
  }
  if (mode === "compoundActions") {
    const actionRefs = Array.isArray(spec.actions) ? spec.actions : [];
    const actions = actionRefs.map((ref) => decode(ref));
    const callback = function (compoundAction) { for (const action of actions) compoundAction.addAction(action); };
    managedCallbacks.set(callbackId, callback);
    return callback;
  }
  const callback = function () {
    const values = Array.prototype.slice.call(arguments).map((value) => encode(value, "unknown"));
    callbackEvents.push({ callbackId, timestamp: new Date().toISOString(), values });
    if (callbackEvents.length > 1024) callbackEvents.splice(0, callbackEvents.length - 1024);
  };
  managedCallbacks.set(callbackId, callback);
  return callback;
}

function validateWireArgument(parameter, value) {
  const expected = String(parameter.type || "unknown");
  if (value === undefined) {
    if (!parameter.optional && !parameter.rest) throw Object.assign(new Error(`Required argument ${parameter.name} is missing`), { code: "UXP_ARGUMENT_REQUIRED" });
    return;
  }
  if (expected.includes("=>")) {
    if (!value || typeof value !== "object" || !value.$callback) throw Object.assign(new Error(`Callback argument ${parameter.name} requires a declarative $callback specification`), { code: "UXP_CALLBACK_SPEC_REQUIRED" });
    return;
  }
  if (value && typeof value === "object" && typeof value.$ref === "string") {
    const record = handleRecord(value.$ref, value.session);
    const candidates = typeTokens(expected);
    if (candidates.size && !Array.from(candidates).some((candidate) => {
      try { assertHandleType(record, candidate); return true; } catch (_) { return false; }
    })) throw Object.assign(new Error(`Handle argument ${parameter.name} is incompatible with ${expected}`), { code: "UXP_ARGUMENT_HANDLE_TYPE" });
    return;
  }
  if (/^(?:string)(?:\s*\||$)/.test(expected) && typeof value !== "string") throw Object.assign(new Error(`${parameter.name} must be a string`), { code: "UXP_ARGUMENT_TYPE" });
  if (/^(?:number)(?:\s*\||$)/.test(expected) && (typeof value !== "number" || !Number.isFinite(value))) throw Object.assign(new Error(`${parameter.name} must be a finite number`), { code: "UXP_ARGUMENT_TYPE" });
  if (/^(?:boolean)(?:\s*\||$)/.test(expected) && typeof value !== "boolean") throw Object.assign(new Error(`${parameter.name} must be a boolean`), { code: "UXP_ARGUMENT_TYPE" });
}

function collectAbsolutePaths(value, output, depth) {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === "string") { if (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value)) output.push(value); return; }
  if (Array.isArray(value)) { for (const item of value) collectAbsolutePaths(item, output, depth + 1); return; }
  if (typeof value === "object") {
    if (value.$ref || value.$callback) return;
    for (const key of Object.keys(value)) collectAbsolutePaths(value[key], output, depth + 1);
  }
}

async function invokeMember(operation, args) {
  const memberId = args && args.memberId;
  if (typeof memberId !== "string") throw Object.assign(new Error("memberId is required"), { code: "UXP_MEMBER_REQUIRED" });
  const entry = MEMBER_INDEX.get(memberId);
  if (!entry) throw Object.assign(new Error("memberId is not present in the generated Adobe allowlist"), { code: "UXP_MEMBER_NOT_ALLOWLISTED" });
  if (entry.id === "Project.executeTransaction" || entry.id === "Project.lockedAccess" || entry.container === "EventManagerStatic") {
    throw Object.assign(new Error(`${entry.id} requires its bridge-owned transaction, locked batch, or event adapter`), { code: "UXP_SPECIAL_ADAPTER_REQUIRED" });
  }
  if (entry.id === "EncoderManager.startBatchEncode") throw Object.assign(new Error("Batch queue destinations cannot be verified through the current Adobe API; startBatchEncode is fail-closed"), { code: "UXP_IMPLICIT_PATH_UNVERIFIABLE" });
  if (OPERATION_BY_BUCKET[entry.bucket] !== operation) throw Object.assign(new Error(`Member ${memberId} requires ${OPERATION_BY_BUCKET[entry.bucket]}`), { code: "UXP_RISK_BUCKET_MISMATCH" });
  const suppliedArguments = Array.isArray(args.arguments) ? args.arguments : [];
  if (suppliedArguments.length > 64) throw Object.assign(new Error("Too many arguments"), { code: "UXP_ARGUMENT_COUNT" });
  const minimumArguments = entry.parameters.filter((parameter) => !parameter.optional && !parameter.rest).length;
  const hasRest = entry.parameters.some((parameter) => parameter.rest);
  if (suppliedArguments.length < minimumArguments || (!hasRest && suppliedArguments.length > entry.parameters.length)) throw Object.assign(new Error(`Argument count for ${entry.id} must be ${minimumArguments}-${hasRest ? 64 : entry.parameters.length}`), { code: "UXP_ARGUMENT_COUNT" });
  for (let index = 0; index < entry.parameters.length; index += 1) validateWireArgument(entry.parameters[index], suppliedArguments[index]);
  if (entry.bucket === "filesystem" || entry.bucket === "destructive") {
    const declaredPaths = Array.isArray(args.paths) ? args.paths : [];
    const observedPaths = [];
    collectAbsolutePaths(suppliedArguments, observedPaths, 0);
    if (entry.id === "Project.save") {
      const project = targetFor(entry, args.target);
      const activePath = String(project && project.path || "");
      if (!activePath || !declaredPaths.includes(activePath)) throw Object.assign(new Error("Project.save requires the exact active project path in server-approved paths metadata"), { code: "UXP_IMPLICIT_PATH_REQUIRED" });
      observedPaths.push(activePath);
    }
    if (entry.bucket === "filesystem" && !declaredPaths.length) throw Object.assign(new Error("Filesystem member requires server-approved paths metadata"), { code: "UXP_PATHS_REQUIRED" });
    if (observedPaths.length && !declaredPaths.length) throw Object.assign(new Error("Path-bearing member requires server-approved paths metadata"), { code: "UXP_PATHS_REQUIRED" });
    if (observedPaths.some((path) => !declaredPaths.includes(path))) throw Object.assign(new Error("A filesystem argument path was not declared for server policy validation"), { code: "UXP_PATH_NOT_DECLARED" });
  }
  const decodedArguments = suppliedArguments.map((item) => decode(item));
  let result;
  if (entry.memberKind === "constructor") {
    const factory = targetFor(entry, null);
    if (typeof factory !== "function") throw Object.assign(new Error("Catalog constructor is not callable in this host"), { code: "UXP_CONSTRUCTOR_UNAVAILABLE" });
    result = entry.member === "$new" ? Reflect.construct(factory, decodedArguments) : factory(...decodedArguments);
  } else {
    const target = targetFor(entry, args.target);
    const resolved = nestedOwner(target, entry.member);
    if (entry.memberKind === "method") {
      const method = resolved.owner && resolved.owner[resolved.key];
      if (typeof method !== "function") throw Object.assign(new Error("Catalog method is unavailable in this host version"), { code: "UXP_METHOD_UNAVAILABLE" });
      result = method.apply(resolved.owner, decodedArguments);
    } else if (entry.readonly || entry.bucket === "read") {
      result = resolved.owner[resolved.key];
    } else {
      if (!("value" in args)) throw Object.assign(new Error("value is required for a writable property"), { code: "UXP_VALUE_REQUIRED" });
      resolved.owner[resolved.key] = decode(args.value);
      result = resolved.owner[resolved.key];
    }
  }
  result = await Promise.resolve(result);
  return { entry, result };
}

async function executeRuntime(operation, args, context) {
  if (operation === "uxp.catalog") {
    const query = typeof args.query === "string" ? args.query.toLowerCase() : "";
    const container = typeof args.container === "string" ? args.container : null;
    const bucket = typeof args.bucket === "string" ? args.bucket : null;
    const offset = Number.isInteger(args.offset) && args.offset >= 0 ? args.offset : 0;
    const limit = Number.isInteger(args.limit) ? Math.max(1, Math.min(200, args.limit)) : 100;
    const filtered = API_CATALOG.entries.filter((entry) => (!query || `${entry.id} ${entry.returnType}`.toLowerCase().includes(query)) && (!container || entry.container === container) && (!bucket || entry.bucket === bucket));
    return { fingerprint: API_CATALOG.fingerprint, counts: API_CATALOG.counts, roots: API_CATALOG.roots, liveProbe, total: filtered.length, offset, limit, nextOffset: offset + limit < filtered.length ? offset + limit : null, entries: filtered.slice(offset, offset + limit), advertisedOperations: CAPABILITIES.filter((item) => item.startsWith("uxp.")) };
  }
  if (operation === "uxp.handle.release") {
    const id = args && args.$ref;
    if (typeof id !== "string") throw Object.assign(new Error("$ref is required"), { code: "UXP_HANDLE_REQUIRED" });
    if (args.session && args.session !== sessionPrefix) throw Object.assign(new Error("Object handle belongs to another UXP session"), { code: "UXP_HANDLE_SESSION_MISMATCH" });
    return { released: handles.delete(id), remainingHandles: handles.size };
  }
  if (operation === "uxp.page.read") {
    const record = handleRecord(args && args.page && args.page.$ref, args && args.page && args.page.session);
    if (record.typeHint !== "PagedResult") throw Object.assign(new Error("Handle is not a paged result"), { code: "UXP_PAGE_TYPE" });
    const limit = Number.isInteger(args.limit) ? Math.max(1, Math.min(512, args.limit)) : 512;
    const page = record.value;
    if (page.kind === "page") {
      const start = page.offset;
      const items = page.items.slice(start, start + limit).map((item) => encode(item, page.itemType));
      page.offset += items.length;
      return { items, truncated: page.offset < page.items.length, totalKnown: page.items.length, continuation: page.offset < page.items.length ? { $ref: args.page.$ref, type: "PagedResult", session: sessionPrefix } : null };
    }
    const keys = page.keys.slice(page.offset, page.offset + limit);
    const properties = {};
    for (const key of keys) properties[key] = encode(page.value[key], "unknown");
    page.offset += keys.length;
    return { properties, truncated: page.offset < page.keys.length, totalKnown: page.keys.length, continuation: page.offset < page.keys.length ? { $ref: args.page.$ref, type: "PagedResult", session: sessionPrefix } : null };
  }
  if (operation === "uxp.transaction.execute") {
    const projectRecord = handleRecord(args.target && args.target.$ref, args.target && args.target.session);
    assertHandleType(projectRecord, "Project");
    const project = projectRecord.value;
    const actionPlans = Array.isArray(args.actions) ? args.actions : [];
    if (!actionPlans.length || actionPlans.length > 256) throw Object.assign(new Error("Transaction requires 1-256 action plans"), { code: "UXP_TRANSACTION_PLAN" });
    const invocations = [];
    for (const plan of actionPlans) {
      const entry = MEMBER_INDEX.get(plan && plan.memberId);
      if (!entry || entry.memberKind !== "method" || !/^create.*Action$/i.test(entry.member) || entry.bucket !== "read") throw Object.assign(new Error("Transaction plans may only call cataloged create*Action factories"), { code: "UXP_TRANSACTION_FACTORY" });
      const suppliedArguments = Array.isArray(plan.arguments) ? plan.arguments : [];
      const minimumArguments = entry.parameters.filter((parameter) => !parameter.optional && !parameter.rest).length;
      const hasRest = entry.parameters.some((parameter) => parameter.rest);
      if (suppliedArguments.length < minimumArguments || (!hasRest && suppliedArguments.length > entry.parameters.length)) throw Object.assign(new Error(`Argument count for ${entry.id} must be ${minimumArguments}-${hasRest ? 64 : entry.parameters.length}`), { code: "UXP_ARGUMENT_COUNT" });
      for (let index = 0; index < entry.parameters.length; index += 1) validateWireArgument(entry.parameters[index], suppliedArguments[index]);
      const target = targetFor(entry, plan.target);
      const resolved = nestedOwner(target, entry.member);
      const method = resolved.owner && resolved.owner[resolved.key];
      if (typeof method !== "function") throw Object.assign(new Error("Catalog action factory is unavailable in this host version"), { code: "UXP_METHOD_UNAVAILABLE" });
      invocations.push({ owner: resolved.owner, method, arguments: suppliedArguments.map((item) => decode(item)) });
    }
    let committed = false;
    project.lockedAccess(function () {
      committed = project.executeTransaction(function (compoundAction) {
        for (const invocation of invocations) {
          // Since Premiere 26.3, Adobe Action objects must be created while the
          // project is locked and consumed before leaving that locked scope.
          compoundAction.addAction(invocation.method.apply(invocation.owner, invocation.arguments));
        }
      }, typeof args.undoString === "string" ? args.undoString : undefined);
    });
    return { committed: !!committed, actionCount: invocations.length };
  }
  if (operation === "uxp.locked.batch") {
    const projectRecord = handleRecord(args.target && args.target.$ref, args.target && args.target.session);
    assertHandleType(projectRecord, "Project");
    const plans = Array.isArray(args.reads) ? args.reads : [];
    if (plans.length > 128) throw Object.assign(new Error("Locked batch exceeds 128 reads"), { code: "UXP_LOCKED_BATCH_SIZE" });
    const results = [];
    projectRecord.value.lockedAccess(function () {
      for (const plan of plans) {
        const entry = MEMBER_INDEX.get(plan && plan.memberId);
        if (!entry || entry.bucket !== "read") throw Object.assign(new Error("Locked batch accepts read members only"), { code: "UXP_LOCKED_BATCH_MEMBER" });
        const target = targetFor(entry, plan.target);
        const resolved = nestedOwner(target, entry.member);
        if (entry.memberKind === "property") results.push(resolved.owner[resolved.key]);
        else {
          const method = resolved.owner && resolved.owner[resolved.key];
          const decodedArguments = (Array.isArray(plan.arguments) ? plan.arguments : []).map((item) => decode(item));
          const value = method.apply(resolved.owner, decodedArguments);
          if (value && typeof value.then === "function") throw Object.assign(new Error("Promise-returning members cannot run inside lockedAccess"), { code: "UXP_LOCKED_ASYNC_UNSUPPORTED" });
          results.push(value);
        }
      }
    });
    return { results: results.map((value) => encode(value, "unknown")) };
  }
  if (operation === "uxp.events.subscribe") {
    const eventName = args && args.eventName;
    if (typeof eventName !== "string" || !eventName) throw Object.assign(new Error("eventName is required"), { code: "UXP_EVENT_NAME" });
    if (subscriptions.size >= 64) throw Object.assign(new Error("Event subscription limit reached for this UXP session"), { code: "UXP_SUBSCRIPTION_LIMIT" });
    for (const subscription of subscriptions.values()) {
      const requestedTarget = args.target ? handleRecord(args.target.$ref, args.target.session).value : null;
      if (subscription.target === requestedTarget && subscription.eventName === eventName && subscription.capture === !!args.capture) throw Object.assign(new Error("Duplicate event subscription"), { code: "UXP_SUBSCRIPTION_DUPLICATE" });
    }
    const subscriptionId = `${sessionPrefix}-sub-${(++handleCounter).toString(36)}`;
    const queue = [];
    const handler = function (event) { queue.push({ timestamp: new Date().toISOString(), event: encode(event, "object") }); if (queue.length > 512) queue.shift(); };
    const manager = ppro.EventManager;
    let target = null;
    if (args.target) {
      target = handleRecord(args.target.$ref, args.target.session).value;
      manager.addEventListener(target, eventName, handler, !!args.capture);
    } else manager.addGlobalEventListener(eventName, handler, !!args.capture);
    subscriptions.set(subscriptionId, { target, eventName, handler, queue, capture: !!args.capture });
    return { subscriptionId, session: sessionPrefix };
  }
  if (operation === "uxp.events.poll") {
    const limit = Number.isInteger(args.limit) ? Math.max(1, Math.min(200, args.limit)) : 100;
    const selected = args.subscriptionId ? [[args.subscriptionId, subscriptions.get(args.subscriptionId)]] : Array.from(subscriptions.entries());
    const events = [];
    for (const [subscriptionId, subscription] of selected) {
      if (!subscription) continue;
      while (subscription.queue.length && events.length < limit) events.push({ subscriptionId, ...subscription.queue.shift() });
    }
    while (callbackEvents.length && events.length < limit) events.push(callbackEvents.shift());
    return { events, remaining: Array.from(subscriptions.values()).reduce((sum, item) => sum + item.queue.length, 0) + callbackEvents.length };
  }
  if (operation === "uxp.events.unsubscribe") {
    const subscription = subscriptions.get(args.subscriptionId);
    if (!subscription) return { removed: false };
    if (subscription.target) ppro.EventManager.removeEventListener(subscription.target, subscription.eventName, subscription.handler);
    else ppro.EventManager.removeGlobalEventListener(subscription.eventName, subscription.handler);
    subscriptions.delete(args.subscriptionId);
    return { removed: true };
  }
  const outcome = await invokeMember(operation, args);
  const projectIdentity = context && context.project ? String(context.project.guid || context.project.path || "") : null;
  const encodedResult = encode(outcome.result, outcome.entry.returnTypeHint, 0, new Set(), projectIdentity);
  await enrichSemanticHandleTokens(encodedResult);
  return { memberId: outcome.entry.id, bucket: outcome.entry.bucket, result: encodedResult, activeHandles: handles.size, callbackEventsPending: callbackEvents.length };
}

async function execute(operation, args, expectedRevision) {
  if (operation.startsWith("uxp.")) {
    const context = await activeContext();
    const beforeRevision = await snapshotRevision(context.project, context.sequence);
    if (expectedRevision && expectedRevision !== beforeRevision) throw Object.assign(new Error("Project state changed after the request was prepared"), { code: "UXP_STALE_REVISION" });
    const runtimeResult = await executeRuntime(operation, args || {}, context);
    const after = await activeContext();
    const afterRevision = await snapshotRevision(after.project, after.sequence);
    return { beforeRevision, afterRevision, verification: { outcome: operation === "uxp.read" || operation === "uxp.catalog" ? "verified" : "committed_unverified", method: "generated Adobe UXP allowlist and host response" }, result: runtimeResult };
  }
  const context = await activeContext();
  const beforeRevision = await snapshotRevision(context.project, context.sequence);
  if (expectedRevision && expectedRevision !== beforeRevision) throw Object.assign(new Error("Project state changed after the request was prepared"), { code: "UXP_STALE_REVISION" });
  if (operation === "host.inspect") return { beforeRevision, afterRevision: beforeRevision, verification: { outcome: "verified", method: "local UXP handshake" }, result: { hostName: uxp.host.name, hostVersion: uxp.host.version, uxpVersion: uxp.versions && uxp.versions.uxp || null, projectOpen: !!context.project, sequenceOpen: !!context.sequence } };
  if (operation === "project.inspect") {
    if (!context.project) return { beforeRevision, afterRevision: beforeRevision, verification: { outcome: "verified", method: "UXP host snapshot" }, result: { project: null, sequences: [] } };
    const sequences = Array.from(await context.project.getSequences() || []).slice(0, 256).map((sequence) => ({ guid: String(sequence.guid || ""), name: String(sequence.name || "") }));
    return { beforeRevision, afterRevision: beforeRevision, verification: { outcome: "verified", method: "UXP host snapshot" }, result: { project: { guid: String(context.project.guid || ""), name: String(context.project.name || "") }, activeSequenceGuid: context.sequence ? String(context.sequence.guid || "") : null, sequences } };
  }
  if (operation === "sequence.inspect") {
    if (!context.sequence) throw Object.assign(new Error("No active sequence"), { code: "UXP_NO_ACTIVE_SEQUENCE" });
    const position = await context.sequence.getPlayerPosition();
    const result = { guid: String(context.sequence.guid || ""), name: String(context.sequence.name || ""), playheadSeconds: position ? position.seconds : null, videoTrackCount: typeof context.sequence.getVideoTrackCount === "function" ? await context.sequence.getVideoTrackCount() : null, audioTrackCount: typeof context.sequence.getAudioTrackCount === "function" ? await context.sequence.getAudioTrackCount() : null, captionTrackCount: typeof context.sequence.getCaptionTrackCount === "function" ? await context.sequence.getCaptionTrackCount() : null };
    return { beforeRevision, afterRevision: beforeRevision, verification: { outcome: "verified", method: "UXP sequence snapshot" }, result };
  }
  if (operation === "captions.inspect") {
    if (!context.sequence) throw Object.assign(new Error("No active sequence"), { code: "UXP_NO_ACTIVE_SEQUENCE" });
    const count = typeof context.sequence.getCaptionTrackCount === "function" ? await context.sequence.getCaptionTrackCount() : 0;
    const tracks = [];
    for (let index = 0; index < count && index < 64; index += 1) {
      const track = await context.sequence.getCaptionTrack(index);
      tracks.push({ index, name: String(track && track.name || ""), muted: track && typeof track.getMute === "function" ? await track.getMute() : null });
    }
    return { beforeRevision, afterRevision: beforeRevision, verification: { outcome: "verified", method: "UXP caption track snapshot" }, result: { count, tracks } };
  }
  if (operation === "project.save") {
    if (!context.project) throw Object.assign(new Error("No active project"), { code: "UXP_NO_ACTIVE_PROJECT" });
    const saved = await context.project.save();
    if (!saved) throw Object.assign(new Error("Premiere did not confirm save"), { code: "UXP_SAVE_NOT_CONFIRMED" });
    const after = await activeContext();
    const afterRevision = await snapshotRevision(after.project, after.sequence);
    return { beforeRevision, afterRevision, verification: { outcome: "verified", method: "Project.save returned true and active project remained available" }, result: { saved: true, projectGuid: String(context.project.guid || "") } };
  }
  if (operation === "project.checkpoint") {
    if (!context.project) throw Object.assign(new Error("No active project"), { code: "UXP_NO_ACTIVE_PROJECT" });
    const phase = args && args.checkpoint && args.checkpoint.phase;
    const inspectedPath = String(context.project.path || "");
    if (!inspectedPath) throw Object.assign(new Error("Active project did not provide a path"), { code: "UXP_CHECKPOINT_PROJECT_PATH_UNAVAILABLE" });
    const inspectedIdentity = String(context.project.guid || "");
    if (phase === "inspect") return { beforeRevision, afterRevision: beforeRevision, verification: { outcome: "verified", method: "Active project path and identity readback before checkpoint save" }, result: { inspected: true, projectPath: inspectedPath, projectIdentity: inspectedIdentity } };
    if (phase !== "save") throw Object.assign(new Error("Checkpoint phase must be inspect or save"), { code: "UXP_CHECKPOINT_PHASE_INVALID" });
    const expectedPath = args.checkpoint && args.checkpoint.expectedProjectPath;
    const expectedIdentity = args.checkpoint && args.checkpoint.expectedProjectIdentity;
    const normalizeProjectPath = value => String(value || "").replace(/\\/g, "/").toLowerCase();
    if (typeof expectedPath !== "string" || normalizeProjectPath(expectedPath) !== normalizeProjectPath(inspectedPath) || (expectedIdentity && String(expectedIdentity) !== inspectedIdentity)) throw Object.assign(new Error("Active project changed after checkpoint inspection"), { code: "UXP_CHECKPOINT_PROJECT_IDENTITY_DRIFT" });
    const saved = await context.project.save();
    if (!saved) throw Object.assign(new Error("Premiere did not confirm checkpoint save"), { code: "UXP_CHECKPOINT_SAVE_NOT_CONFIRMED" });
    const after = await activeContext();
    const projectPath = String(after.project && after.project.path || "");
    if (!projectPath) throw Object.assign(new Error("Saved active project did not provide a path"), { code: "UXP_CHECKPOINT_PROJECT_PATH_UNAVAILABLE" });
    return { beforeRevision, afterRevision: await snapshotRevision(after.project, after.sequence), verification: { outcome: "verified", method: "Project.save returned true and active project path was read back" }, result: { saved: true, projectPath } };
  }
  if (operation === "project.close_disposable") {
    if (!context.project) throw Object.assign(new Error("No active project"), { code: "UXP_NO_ACTIVE_PROJECT" });
    if (!args || args.saveBeforeClose !== true || typeof args.path !== "string") throw Object.assign(new Error("project.close_disposable requires an exact disposable path and saveBeforeClose=true"), { code: "UXP_CLOSE_FIXTURE_BINDING_REQUIRED" });
    if (!sameWindowsPath(context.project.path, args.path)) throw Object.assign(new Error("Active project path does not match the disposable fixture binding"), { code: "UXP_CLOSE_FIXTURE_PATH_MISMATCH" });
    if (typeof context.project.close !== "function" || typeof ppro.CloseProjectOptions !== "function") throw Object.assign(new Error("Typed project close APIs are unavailable"), { code: "UXP_PROJECT_CLOSE_API_UNAVAILABLE" });
    const closedProjectIdentity = String(context.project.guid || context.project.path || "");
    let closeDispatched = false;
    let saveDispatched = false;
    try {
      saveDispatched = true;
      const savedBeforeClose = await context.project.save();
      if (savedBeforeClose !== true) throw new Error("Premiere did not confirm the required save before close");
      const closeOptions = new ppro.CloseProjectOptions();
      if (typeof closeOptions.setPromptIfDirty === "function") closeOptions.setPromptIfDirty(false);
      if (typeof closeOptions.setShowCancelButton === "function") closeOptions.setShowCancelButton(false);
      if (typeof closeOptions.setSaveWorkspace === "function") closeOptions.setSaveWorkspace(false);
      if (typeof closeOptions.setIsAppBeingPreparedToQuit === "function") closeOptions.setIsAppBeingPreparedToQuit(false);
      closeDispatched = true;
      const closed = await context.project.close(closeOptions);
      const after = await activeContext();
      const activeIdentity = after.project ? String(after.project.guid || after.project.path || "") : "";
      const closedProjectIdentityAbsent = closedProjectIdentity.length > 0 && activeIdentity !== closedProjectIdentity;
      if (closed === false || !closedProjectIdentityAbsent) throw new Error("Premiere did not confirm that the exact project identity was closed");
      return { beforeRevision, afterRevision: after.project ? await snapshotRevision(after.project, after.sequence) : null, verification: { outcome: "verified", method: "Project.save returned true and closed project identity is absent from active project readback" }, result: { savedBeforeClose: true, closed: true, closedProjectIdentity, closedProjectIdentityAbsent } };
    } catch (error) {
      throw Object.assign(new Error(`Project save/close outcome could not be verified after dispatch: ${String(error && error.message || error)}`), { code: closeDispatched || saveDispatched ? "UXP_PROJECT_CLOSE_NOT_VERIFIED" : "UXP_PROJECT_CLOSE_FAILED" });
    }
  }
  if (operation === "media.relink") {
    if (!context.project) throw Object.assign(new Error("No active project"), { code: "UXP_NO_ACTIVE_PROJECT" });
    const activeProjectIdentity = String(context.project.guid || context.project.path || "");
    const clip = await semanticHandle(args && args.clip, "ClipProjectItem", activeProjectIdentity);
    const requestedPath = args && args.path;
    if (typeof requestedPath !== "string" || !/^[A-Za-z]:[\\/]/.test(requestedPath)) throw Object.assign(new Error("A Windows media path is required"), { code: "UXP_INVALID_MEDIA_PATH" });
    if (typeof clip.changeMediaFilePath !== "function" || typeof clip.getMediaFilePath !== "function") throw Object.assign(new Error("Clip media relink APIs are unavailable"), { code: "UXP_RELINK_API_UNAVAILABLE" });
    const priorPath = await clip.getMediaFilePath();
    let relinkDispatched = false;
    try {
      relinkDispatched = true;
      const changed = await clip.changeMediaFilePath(requestedPath, args.overrideCompatibilityCheck === true);
      const mediaPath = await clip.getMediaFilePath();
      if (changed === false || !sameWindowsPath(mediaPath, requestedPath)) throw new Error("Premiere did not confirm the exact relinked path");
      const after = await activeContext();
      return { beforeRevision, afterRevision: await snapshotRevision(after.project, after.sequence), verification: { outcome: "verified", method: "ClipProjectItem media path readback" }, result: { relinked: true, pathVerified: true, priorPath: String(priorPath || ""), mediaPath: String(mediaPath) } };
    } catch (error) {
      throw Object.assign(new Error(`Relink outcome could not be verified after dispatch: ${String(error && error.message || error)}`), { code: relinkDispatched ? "UXP_RELINK_NOT_VERIFIED" : "UXP_RELINK_FAILED" });
    }
  }
  if (operation === "media.proxy.attach") {
    if (!context.project) throw Object.assign(new Error("No active project"), { code: "UXP_NO_ACTIVE_PROJECT" });
    const activeProjectIdentity = String(context.project.guid || context.project.path || "");
    const clip = await semanticHandle(args && args.clip, "ClipProjectItem", activeProjectIdentity);
    const requestedPath = args && args.path;
    if (typeof requestedPath !== "string" || !/^[A-Za-z]:[\\/]/.test(requestedPath)) throw Object.assign(new Error("A Windows proxy path is required"), { code: "UXP_INVALID_PROXY_PATH" });
    if (typeof clip.attachProxy !== "function" || typeof clip.hasProxy !== "function" || typeof clip.getProxyPath !== "function") throw Object.assign(new Error("Clip proxy APIs are unavailable"), { code: "UXP_PROXY_API_UNAVAILABLE" });
    let proxyDispatched = false;
    try {
      proxyDispatched = true;
      const attached = await clip.attachProxy(requestedPath, args.isHiRes === true, false);
      const hasProxy = await clip.hasProxy();
      const proxyPath = await clip.getProxyPath();
      if (attached === false || hasProxy !== true || !sameWindowsPath(proxyPath, requestedPath)) throw new Error("Premiere did not confirm the exact attached proxy path");
      const after = await activeContext();
      return { beforeRevision, afterRevision: await snapshotRevision(after.project, after.sequence), verification: { outcome: "verified", method: "ClipProjectItem proxy presence and path readback" }, result: { proxyAttached: true, pathVerified: true, proxyPath: String(proxyPath) } };
    } catch (error) {
      throw Object.assign(new Error(`Proxy attachment outcome could not be verified after dispatch: ${String(error && error.message || error)}`), { code: proxyDispatched ? "UXP_PROXY_NOT_VERIFIED" : "UXP_PROXY_FAILED" });
    }
  }
  if (operation === "timeline.track.set_mute") {
    if (!context.project || !context.sequence) throw Object.assign(new Error("No active sequence"), { code: "UXP_NO_ACTIVE_SEQUENCE" });
    const activeProjectIdentity = String(context.project.guid || context.project.path || "");
    const sequence = await semanticHandle(args && args.sequence, "Sequence", activeProjectIdentity);
    if (String(sequence.guid || "") !== String(context.sequence.guid || "")) throw Object.assign(new Error("Sequence handle is not the active sequence covered by expectedRevision"), { code: "UXP_SEQUENCE_SCOPE_MISMATCH" });
    const isVideo = args.mediaType === "video";
    if (!isVideo && args.mediaType !== "audio") throw Object.assign(new Error("mediaType must be video or audio"), { code: "UXP_INVALID_MEDIA_TYPE" });
    const count = await sequence[isVideo ? "getVideoTrackCount" : "getAudioTrackCount"]();
    if (!Number.isInteger(args.trackIndex) || args.trackIndex < 0 || args.trackIndex >= count) throw Object.assign(new Error("Target track index is out of range"), { code: "UXP_TRACK_INDEX_OUT_OF_RANGE" });
    const track = await sequence[isVideo ? "getVideoTrack" : "getAudioTrack"](args.trackIndex);
    if (!track || typeof track.setMute !== "function" || typeof track.isMuted !== "function") throw Object.assign(new Error("Track mute APIs are unavailable"), { code: "UXP_TRACK_MUTE_API_UNAVAILABLE" });
    const beforeMuted = await track.isMuted();
    let muteDispatched = false;
    try {
      muteDispatched = true;
      const changed = await track.setMute(args.muted);
      const muted = await track.isMuted();
      if (changed === false || muted !== args.muted) throw new Error("Premiere did not confirm the requested track mute state");
      const after = await activeContext();
      return { beforeRevision, afterRevision: await snapshotRevision(after.project, after.sequence), verification: { outcome: "verified", method: "Track.isMuted state readback" }, result: { stateVerified: true, mediaType: args.mediaType, trackIndex: args.trackIndex, beforeMuted, muted } };
    } catch (error) {
      throw Object.assign(new Error(`Track mute outcome could not be verified after dispatch: ${String(error && error.message || error)}`), { code: muteDispatched ? "UXP_TRACK_MUTE_NOT_VERIFIED" : "UXP_TRACK_MUTE_FAILED" });
    }
  }
  if (operation === "timeline.clip.insert") {
    if (!context.project || !context.sequence) throw Object.assign(new Error("No active sequence"), { code: "UXP_NO_ACTIVE_SEQUENCE" });
    const activeProjectIdentity = String(context.project.guid || context.project.path || "");
    const sequence = await semanticHandle(args && args.sequence, "Sequence", activeProjectIdentity);
    const projectItem = await semanticHandle(args && args.projectItem, ["ProjectItem", "ClipProjectItem"], activeProjectIdentity);
    if (String(sequence.guid || "") !== String(context.sequence.guid || "")) throw Object.assign(new Error("Sequence handle is not the active sequence covered by expectedRevision"), { code: "UXP_SEQUENCE_SCOPE_MISMATCH" });
    const videoTrackCount = await sequence.getVideoTrackCount();
    const audioTrackCount = await sequence.getAudioTrackCount();
    if (!Number.isFinite(args.timeSeconds) || args.timeSeconds < 0 || args.timeSeconds > 604800) throw Object.assign(new Error("Insert time must be between zero and seven days"), { code: "UXP_INSERT_TIME_OUT_OF_RANGE" });
    if (!Number.isInteger(args.videoTrackIndex) || args.videoTrackIndex < 0 || args.videoTrackIndex >= videoTrackCount || !Number.isInteger(args.audioTrackIndex) || args.audioTrackIndex < 0 || args.audioTrackIndex >= audioTrackCount) throw Object.assign(new Error("Target track index is out of range"), { code: "UXP_TRACK_INDEX_OUT_OF_RANGE" });
    if (typeof ppro.SequenceEditor.getEditor !== "function" || typeof ppro.TickTime.createWithSeconds !== "function" || typeof context.project.lockedAccess !== "function" || typeof context.project.executeTransaction !== "function") throw Object.assign(new Error("Transactional sequence editing APIs are unavailable"), { code: "UXP_SEQUENCE_EDIT_API_UNAVAILABLE" });
    const videoTrack = await sequence.getVideoTrack(args.videoTrackIndex);
    const beforeItems = Array.from(await videoTrack.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || []);
    let committed = false;
    let insertDispatched = false;
    try {
      context.project.lockedAccess(function () {
        const editor = ppro.SequenceEditor.getEditor(sequence);
        if (!editor || typeof editor.createInsertProjectItemAction !== "function") throw Object.assign(new Error("Sequence editor is unavailable"), { code: "UXP_SEQUENCE_EDITOR_UNAVAILABLE" });
        const time = ppro.TickTime.createWithSeconds(args.timeSeconds);
        insertDispatched = true;
        committed = context.project.executeTransaction(function (compoundAction) {
          compoundAction.addAction(editor.createInsertProjectItemAction(projectItem, time, args.videoTrackIndex, args.audioTrackIndex, args.limitShift !== false));
        }, "Premiere MCP insert project item");
      });
      if (committed === false) throw new Error("Premiere rejected the insert transaction");
      const afterItems = Array.from(await videoTrack.getTrackItems(ppro.Constants.TrackItemType.CLIP, false) || []);
      const addedVideoItems = afterItems.length - beforeItems.length;
      if (addedVideoItems <= 0) throw new Error("Target track item count did not increase");
      const after = await activeContext();
      return { beforeRevision, afterRevision: await snapshotRevision(after.project, after.sequence), verification: { outcome: "verified", method: "Project transaction and target VideoTrack item-count readback" }, result: { inserted: true, trackCountVerified: true, addedVideoItems, videoTrackIndex: args.videoTrackIndex, audioTrackIndex: args.audioTrackIndex } };
    } catch (error) {
      if (!insertDispatched && error && error.code) throw error;
      throw Object.assign(new Error(`Insert outcome could not be verified after dispatch: ${String(error && error.message || error)}`), { code: insertDispatched ? "UXP_INSERT_NOT_VERIFIED" : "UXP_INSERT_FAILED" });
    }
  }
  if (operation === "export.frame") {
    if (!context.sequence) throw Object.assign(new Error("No active sequence"), { code: "UXP_NO_ACTIVE_SEQUENCE" });
    const outputPath = args && args.outputPath;
    const timeSeconds = args && args.timeSeconds;
    if (typeof outputPath !== "string" || !/^[A-Za-z]:[\\/]/.test(outputPath) || typeof timeSeconds !== "number" || !Number.isFinite(timeSeconds) || timeSeconds < 0) throw Object.assign(new Error("A Windows outputPath and non-negative timeSeconds are required"), { code: "UXP_INVALID_FRAME_EXPORT" });
    const normalized = outputPath.replace(/\//g, "\\");
    const separator = normalized.lastIndexOf("\\");
    const filename = normalized.slice(separator + 1);
    const directory = normalized.slice(0, separator);
    if (!filename || !directory) throw Object.assign(new Error("Frame outputPath must include a directory and filename"), { code: "UXP_INVALID_FRAME_EXPORT" });
    const frameTime = ppro.TickTime.createWithSeconds(timeSeconds);
    const frameSize = await context.sequence.getFrameSize();
    const exported = await ppro.Exporter.exportSequenceFrame(context.sequence, frameTime, filename, directory, frameSize.width, frameSize.height);
    if (!exported) throw Object.assign(new Error("Premiere did not confirm frame export"), { code: "UXP_FRAME_EXPORT_NOT_CONFIRMED" });
    return { beforeRevision, afterRevision: beforeRevision, verification: { outcome: "verified", method: "Exporter.exportSequenceFrame returned true; server verifies the output file" }, createdFiles: [{ name: outputPath, verified: false }], result: { exported: true, outputPath, width: frameSize.width, height: frameSize.height } };
  }
  if (operation === "export.sequence") {
    if (!context.sequence) throw Object.assign(new Error("No active sequence"), { code: "UXP_NO_ACTIVE_SEQUENCE" });
    const outputPath = args && args.outputPath;
    const presetPath = args && args.presetPath;
    if (typeof outputPath !== "string" || !/^[A-Za-z]:[\\/]/.test(outputPath) || typeof presetPath !== "string" || !/^[A-Za-z]:[\\/]/.test(presetPath)) {
      throw Object.assign(new Error("Windows outputPath and presetPath are required"), { code: "UXP_INVALID_SEQUENCE_EXPORT" });
    }
    const encoder = ppro.EncoderManager.getManager();
    if (!encoder || typeof encoder.exportSequence !== "function") throw Object.assign(new Error("Premiere EncoderManager is unavailable"), { code: "UXP_ENCODER_UNAVAILABLE" });
    const exportPromise = encoder.exportSequence(context.sequence, ppro.Constants.ExportType.IMMEDIATELY, outputPath, presetPath, true);
    if (exportPromise === false) throw Object.assign(new Error("Premiere did not accept sequence export"), { code: "UXP_SEQUENCE_EXPORT_NOT_ACCEPTED" });
    // Premiere 26.3.2 can finish writing a valid file while this host Promise
    // remains pending. Do not block the local bridge on that Promise;
    // the Node side proves a new, stable output file before reporting success.
    Promise.resolve(exportPromise).catch(() => {});
    return { beforeRevision, afterRevision: beforeRevision, verification: { outcome: "committed_unverified", method: "EncoderManager.exportSequence dispatch accepted; server verifies a changed stable output file" }, createdFiles: [{ name: outputPath, verified: false }], result: { initiated: true, outputPath } };
  }
  throw Object.assign(new Error(`Unsupported UXP operation: ${operation}`), { code: "UXP_OPERATION_UNSUPPORTED" });
}

async function handleCommand(message) {
  const response = { type: "response", protocolVersion: 1, requestId: message.requestId, sessionId: connectedSessionId, ok: false, hostVersion: uxp.host.version };
  try {
    if (!CAPABILITIES.includes(message.operation)) throw Object.assign(new Error("Operation was not advertised"), { code: "UXP_CAPABILITY_UNAVAILABLE" });
    if (message.operation === "project.checkpoint") validateCheckpointBinding(message);
    const outcome = await execute(message.operation, message.args || {}, message.expectedRevision);
    Object.assign(response, outcome, { ok: true });
  } catch (error) {
    response.error = { code: error && error.code || "UXP_COMMAND_FAILED", message: error && error.message || "UXP command failed", retryable: false };
  }
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response));
}

function validateCheckpointBinding(message) {
  const binding = message && message.routeBinding;
  if (!message || typeof message.planHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(message.planHash)) throw Object.assign(new Error("Checkpoint requires an exact execution plan hash"), { code: "UXP_CHECKPOINT_PLAN_HASH_REQUIRED" });
  if (!binding || binding.backend !== "uxp" || binding.hostVersion !== uxp.host.version || binding.hostSessionId !== connectedSessionId || binding.capabilityFingerprint !== API_CATALOG.fingerprint) throw Object.assign(new Error("Checkpoint route binding no longer matches this UXP host session"), { code: "UXP_CHECKPOINT_ROUTE_BINDING_DRIFT" });
  const internal = message.args && message.args.checkpoint;
  if (!internal || (internal.phase !== "inspect" && internal.phase !== "save") || internal.planHash !== message.planHash || JSON.stringify(internal.routeBinding) !== JSON.stringify(binding)) throw Object.assign(new Error("Checkpoint internal route binding or phase does not match the execution request"), { code: "UXP_CHECKPOINT_BINDING_MISMATCH" });
}

async function connect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) socket.close();
  status("Connecting…");
  let identity;
  try { identity = await bridgeIdentity(); }
  catch (_) {
    status("Local authentication setup failed. Retrying…", "error");
    reconnectTimer = setTimeout(() => { reconnectTimer = null; void connect(); }, 2000);
    return;
  }
  const candidate = new WebSocket("ws://localhost:17777/uxp");
  socket = candidate;
  const clientNonce = randomHex(32);
  let serverNonce = null;
  let authenticated = false;
  candidate.addEventListener("open", () => {
    if (socket !== candidate) return;
    candidate.send(JSON.stringify({ type: "hello", protocolVersion: 3, authFilePath: identity.authFilePath, clientNonce, apiFingerprint: API_CATALOG.fingerprint }));
  });
  candidate.addEventListener("message", (event) => {
    if (socket !== candidate) return;
    let message;
    try { message = JSON.parse(event.data); } catch (_) { return; }
    if (message.type === "challenge" && message.protocolVersion === 3 && typeof message.serverNonce === "string" && typeof message.serverProof === "string") {
      const expected = hmacSha256Hex(identity.secret, authenticationTranscript("server", clientNonce, message.serverNonce, API_CATALOG.fingerprint));
      if (!constantTimeHexEqual(expected, message.serverProof)) { candidate.close(1008, "Local server authentication failed"); return; }
      serverNonce = message.serverNonce;
      liveProbe = probeCatalog();
      candidate.send(JSON.stringify({ type: "connect", protocolVersion: 3, clientProof: hmacSha256Hex(identity.secret, authenticationTranscript("client", clientNonce, serverNonce, API_CATALOG.fingerprint)), hostVersion: uxp.host.version, uxpVersion: uxp.versions && uxp.versions.uxp || "unknown", capabilities: CAPABILITIES, apiFingerprint: API_CATALOG.fingerprint, apiCounts: API_CATALOG.counts, apiProbe: liveProbe }));
    } else if (message.type === "connected" && message.protocolVersion === 3 && serverNonce) {
      connectedSessionId = typeof message.sessionId === "string" ? message.sessionId : null;
      authenticated = !!connectedSessionId;
      if (authenticated) status(`Connected\nPremiere ${uxp.host.version}\n${API_CATALOG.counts.members} generated API members`, "connected");
    } else if (message.type === "command") {
      if (!authenticated || !connectedSessionId || message.sessionId !== connectedSessionId) { candidate.close(1008, "Authenticated session required"); return; }
      void handleCommand(message);
    }
  });
  candidate.addEventListener("close", () => {
    if (socket !== candidate) return;
    connectedSessionId = null;
    for (const subscription of subscriptions.values()) {
      try {
        if (subscription.target) ppro.EventManager.removeEventListener(subscription.target, subscription.eventName, subscription.handler);
        else ppro.EventManager.removeGlobalEventListener(subscription.eventName, subscription.handler);
      } catch (_) {}
    }
    subscriptions.clear();
    managedCallbacks.clear();
    handles.clear();
    callbackEvents.splice(0, callbackEvents.length);
    status("Disconnected");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 2000);
  });
  candidate.addEventListener("error", () => {
    if (socket === candidate) status("Connection failed. Retrying the local MCP server…", "error");
  });
}

document.getElementById("connect").addEventListener("click", () => void connect());
void connect();
