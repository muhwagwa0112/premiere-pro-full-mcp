const ppro = require("premierepro");
const uxp = require("uxp");
const API_CATALOG = require("./api-catalog.cjs");

const CAPABILITIES = [
  "host.inspect", "project.inspect", "sequence.inspect", "project.save", "captions.inspect",
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
let reconnectTimer = null;
let liveProbe = { status: "not_run", availableRoots: 0, unavailableRoots: [], probedRootMembers: 0, unavailableRootMembers: [] };

function status(message, kind) {
  const element = document.getElementById("status");
  element.textContent = message;
  element.className = kind || "";
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

function registerHandle(value, typeHint) {
  expireHandles();
  if (handles.size >= 1024) handles.delete(handles.keys().next().value);
  const id = `${sessionPrefix}-${(++handleCounter).toString(36)}`;
  handles.set(id, { value, typeHint: String(typeHint || "unknown"), createdAt: Date.now(), expiresAt: Date.now() + 30 * 60 * 1000 });
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

function decode(value, depth = 0) {
  if (depth > 8) throw Object.assign(new Error("Argument nesting exceeds the safe limit"), { code: "UXP_ARGUMENT_DEPTH" });
  if (Array.isArray(value)) return value.map((item) => decode(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  if (typeof value.$ref === "string") {
    const keys = Object.keys(value);
    if (keys.some((key) => !["$ref", "type", "session"].includes(key))) throw Object.assign(new Error("Handle reference contains unsupported properties"), { code: "UXP_HANDLE_SHAPE" });
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

function encode(value, typeHint, depth = 0, seen = new Set()) {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value ?? null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return registerHandle(value, typeHint || "Function");
  if (depth >= 6 || seen.has(value)) return registerHandle(value, typeHint);
  seen.add(value);
  if (Array.isArray(value)) {
    const itemType = elementType(typeHint);
    const result = value.slice(0, 512).map((item) => encode(item, itemType, depth + 1, seen));
    seen.delete(value);
    return value.length <= 512 ? result : { items: result, truncated: true, totalKnown: value.length, continuation: registerHandle({ kind: "page", items: value, itemType, offset: 512 }, "PagedResult") };
  }
  let prototype;
  try { prototype = Object.getPrototypeOf(value); } catch (_) { prototype = null; }
  if (prototype === Object.prototype || prototype === null) {
    const output = {};
    const allKeys = Object.keys(value);
    if (allKeys.length > 256) {
      seen.delete(value);
      return { properties: Object.fromEntries(allKeys.slice(0, 256).map((key) => {
        try { return [key, encode(value[key], "unknown", depth + 1, seen)]; } catch (_) { return [key, { unavailable: true }]; }
      })), truncated: true, totalKnown: allKeys.length, continuation: registerHandle({ kind: "objectPage", value, keys: allKeys, offset: 256 }, "PagedResult") };
    }
    const keys = allKeys;
    for (const key of keys) {
      try { output[key] = encode(value[key], "unknown", depth + 1, seen); } catch (_) { output[key] = { unavailable: true }; }
    }
    seen.delete(value);
    return output;
  }
  seen.delete(value);
  return registerHandle(value, typeHint || (value.constructor && value.constructor.name) || "PremiereObject");
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

async function executeRuntime(operation, args) {
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
  return { memberId: outcome.entry.id, bucket: outcome.entry.bucket, result: encode(outcome.result, outcome.entry.returnTypeHint), activeHandles: handles.size, callbackEventsPending: callbackEvents.length };
}

async function execute(operation, args, expectedRevision) {
  if (operation.startsWith("uxp.")) {
    const context = await activeContext();
    const beforeRevision = await snapshotRevision(context.project, context.sequence);
    if (expectedRevision && expectedRevision !== beforeRevision) throw Object.assign(new Error("Project state changed after the request was prepared"), { code: "UXP_STALE_REVISION" });
    const runtimeResult = await executeRuntime(operation, args || {});
    const after = await activeContext();
    const afterRevision = await snapshotRevision(after.project, after.sequence);
    return { beforeRevision, afterRevision, verification: { outcome: operation === "uxp.read" || operation === "uxp.catalog" ? "verified" : "committed_unverified", method: "generated Adobe UXP allowlist and host response" }, result: runtimeResult };
  }
  const context = await activeContext();
  const beforeRevision = await snapshotRevision(context.project, context.sequence);
  if (expectedRevision && expectedRevision !== beforeRevision) throw Object.assign(new Error("Project state changed after the request was prepared"), { code: "UXP_STALE_REVISION" });
  if (operation === "host.inspect") return { beforeRevision, afterRevision: beforeRevision, verification: { outcome: "verified", method: "authenticated UXP handshake" }, result: { hostName: uxp.host.name, hostVersion: uxp.host.version, uxpVersion: uxp.versions && uxp.versions.uxp || null, projectOpen: !!context.project, sequenceOpen: !!context.sequence } };
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
    // remains pending. Do not block the authenticated bridge on that Promise;
    // the Node side proves a new, stable output file before reporting success.
    Promise.resolve(exportPromise).catch(() => {});
    return { beforeRevision, afterRevision: beforeRevision, verification: { outcome: "committed_unverified", method: "EncoderManager.exportSequence dispatch accepted; server verifies a changed stable output file" }, createdFiles: [{ name: outputPath, verified: false }], result: { initiated: true, outputPath } };
  }
  throw Object.assign(new Error(`Unsupported UXP operation: ${operation}`), { code: "UXP_OPERATION_UNSUPPORTED" });
}

async function handleCommand(message) {
  const response = { type: "response", protocolVersion: 1, requestId: message.requestId, ok: false, hostVersion: uxp.host.version };
  try {
    if (!CAPABILITIES.includes(message.operation)) throw Object.assign(new Error("Operation was not advertised"), { code: "UXP_CAPABILITY_UNAVAILABLE" });
    const outcome = await execute(message.operation, message.args || {}, message.expectedRevision);
    Object.assign(response, outcome, { ok: true });
  } catch (error) {
    response.error = { code: error && error.code || "UXP_COMMAND_FAILED", message: error && error.message || "UXP command failed", retryable: false };
  }
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(response));
}

function connect() {
  const port = Number(document.getElementById("port").value);
  const token = document.getElementById("token").value;
  if (!Number.isInteger(port) || port < 1025 || port > 65535) return status("Port must be between 1025 and 65535", "error");
  if (token.length < 24) return status("Token must contain at least 24 characters", "error");
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) socket.close();
  status("Connecting…");
  const candidate = new WebSocket(`ws://localhost:${port}/uxp`);
  socket = candidate;
  candidate.addEventListener("open", () => {
    if (socket !== candidate) return;
    liveProbe = probeCatalog();
    candidate.send(JSON.stringify({ type: "auth", protocolVersion: 1, token, hostVersion: uxp.host.version, uxpVersion: uxp.versions && uxp.versions.uxp || "unknown", capabilities: CAPABILITIES, apiFingerprint: API_CATALOG.fingerprint, apiCounts: API_CATALOG.counts, apiProbe: liveProbe }));
  });
  candidate.addEventListener("message", (event) => {
    if (socket !== candidate) return;
    let message;
    try { message = JSON.parse(event.data); } catch (_) { return; }
    if (message.type === "authenticated") status(`Connected\nPremiere ${uxp.host.version}\n${API_CATALOG.counts.members} generated API members`, "connected");
    else if (message.type === "command") void handleCommand(message);
  });
  candidate.addEventListener("close", () => {
    if (socket !== candidate) return;
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
    if (socket === candidate) status("Connection failed. Retrying the authenticated local MCP server…", "error");
  });
}

document.getElementById("connect").addEventListener("click", connect);

const BOOTSTRAP_PERMISSION_KEY = "premiere-mcp-bootstrap-file-v1";

function validateBootstrap(bootstrap) {
  if (bootstrap.version !== 1 || !Number.isInteger(bootstrap.port) || bootstrap.port < 1025 || bootstrap.port > 65535 || typeof bootstrap.token !== "string" || bootstrap.token.length < 24) {
    throw new Error("Provisioned bootstrap is invalid");
  }
  return bootstrap;
}

async function applyBootstrapFile(file) {
  if (!file || file.name !== "runtime-bootstrap.json") throw new Error("Select the installed runtime-bootstrap.json file");
  const bootstrap = validateBootstrap(JSON.parse(await file.read()));
  const permission = await uxp.storage.localFileSystem.createPersistentToken(file);
  localStorage.setItem(BOOTSTRAP_PERMISSION_KEY, permission);
  document.getElementById("port").value = String(bootstrap.port);
  document.getElementById("token").value = bootstrap.token;
  connect();
}

document.getElementById("pair").addEventListener("click", async () => {
  try {
    const file = await uxp.storage.localFileSystem.getFileForOpening({ types: ["json"], allowMultiple: false });
    if (!file) return;
    await applyBootstrapFile(file);
  } catch (error) {
    status(error && error.message || "Pairing failed", "error");
  }
});

async function connectFromBootstrap() {
  try {
    const permission = localStorage.getItem(BOOTSTRAP_PERMISSION_KEY);
    if (!permission) throw new Error("Not paired");
    const bootstrapFile = await uxp.storage.localFileSystem.getEntryForPersistentToken(permission);
    const bootstrap = validateBootstrap(JSON.parse(await bootstrapFile.read()));
    document.getElementById("port").value = String(bootstrap.port);
    document.getElementById("token").value = bootstrap.token;
    connect();
  } catch (_) {
    localStorage.removeItem(BOOTSTRAP_PERMISSION_KEY);
    status("Disconnected — select Pair to connect.");
  }
}

void connectFromBootstrap();
