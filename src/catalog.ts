import { z } from "zod";
import type { ActionDescriptor, ActionDomain } from "./contracts.js";
import { coreSemanticActions } from "./features/core-semantic.js";
import { uiSemanticActions } from "./features/ui/semantic-adapters.js";

const emptyArgs = z.object({}).strict();
const optionalScope = z.object({ scope: z.string().min(1).max(64).optional() }).strict();
const projectPath = z.object({ path: z.string().min(1).max(4096) }).strict();
const mediaImport = z.object({ paths: z.array(z.string().min(1).max(4096)).min(1).max(128) }).strict();
const sequenceFromMedia = z.object({ name: z.string().min(1).max(256), projectItemIds: z.array(z.string().min(1).max(256)).min(1).max(128) }).strict();
const effectAction = z.object({ clipId: z.string().min(1), effectId: z.string().min(1), parameters: z.record(z.string(), z.unknown()).optional() }).strict();
const exportFrame = z.object({ outputPath: z.string().min(1).max(4096), timeSeconds: z.number().nonnegative() }).strict();
const exportSequence = z.object({ outputPath: z.string().min(1).max(4096), presetPath: z.string().min(1).max(4096), overwrite: z.boolean().default(false) }).strict();
const workspaceSet = z.object({ name: z.string().min(1).max(128) }).strict();
const pluginUi = z.object({ pluginId: z.string().min(1).max(256), command: z.string().min(1).max(128), values: z.record(z.string(), z.unknown()).optional() }).strict();
const cloudAction = z.object({ service: z.enum(["frameio", "stock", "generative"]), command: z.string().min(1).max(128), values: z.record(z.string(), z.unknown()).optional() }).strict();
const runtimeTarget = z.object({ $ref: z.string().min(8).max(256), type: z.string().min(1).max(128).optional(), session: z.string().min(8).max(128).optional(), stateToken: z.string().min(16).max(512).optional() }).strict();
const runtimeCall = z.object({ memberId: z.string().min(3).max(256), target: runtimeTarget.optional(), arguments: z.array(z.unknown()).max(64).default([]), value: z.unknown().optional(), paths: z.array(z.string().min(1).max(4096)).max(64).optional() }).strict();
const runtimeCatalog = z.object({ query: z.string().max(128).optional(), container: z.string().max(128).optional(), bucket: z.enum(["read", "edit", "sensitive", "filesystem", "destructive"]).optional(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(200).default(100) }).strict();
const handleRelease = z.object({ $ref: z.string().min(8).max(256), session: z.string().min(8).max(128).optional() }).strict();
const transactionPlan = z.object({ target: runtimeTarget, actions: z.array(runtimeCall).min(1).max(256), undoString: z.string().min(1).max(256).optional() }).strict();
const lockedBatch = z.object({ target: runtimeTarget, reads: z.array(runtimeCall).max(128) }).strict();
const pageRead = z.object({ page: runtimeTarget, limit: z.number().int().min(1).max(512).default(512) }).strict();
const eventSubscription = z.object({ target: runtimeTarget.optional(), eventName: z.string().min(1).max(256), capture: z.boolean().default(false) }).strict();
const subscriptionId = z.object({ subscriptionId: z.string().min(8).max(256) }).strict();
const eventPoll = z.object({ subscriptionId: z.string().min(8).max(256).optional(), limit: z.number().int().min(1).max(200).default(100) }).strict();
const capabilityCall = z.object({ capabilityId: z.string().min(8).max(256), arguments: z.array(z.unknown()).max(64).default([]), value: z.unknown().optional(), paths: z.array(z.string().min(1).max(4096)).max(64).optional() }).strict();
const capabilityCatalog = z.object({ root: z.string().max(128).optional(), objectRef: z.string().min(8).max(256).optional(), query: z.string().max(128).optional(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(200).default(100) }).strict();

const actions: ActionDescriptor[] = [
  {
    id: "uxp.catalog", domain: "api", title: "Search official UXP API", description: "Search the generated Adobe Premiere UXP declaration catalog with pagination.",
    risk: "R0", authority: "inspect", preferredBackends: ["local", "uxp"], minimumPremiereVersion: "26.3.0", mutatesProject: false, undoable: false,
    verification: "generated Adobe declaration fingerprint", support: "implemented_unverified", argsSchema: runtimeCatalog,
  },
  {
    id: "uxp.read", domain: "api", title: "Invoke official UXP read member", description: "Invoke one catalog member classified as read-only.",
    risk: "R0", authority: "inspect", preferredBackends: ["uxp"], minimumPremiereVersion: "26.3.0", mutatesProject: false, undoable: false,
    verification: "catalog allowlist and host response", support: "implemented_unverified", argsSchema: runtimeCall,
  },
  {
    id: "uxp.edit", domain: "api", title: "Invoke official UXP edit member", description: "Invoke one catalog member classified as an in-project edit.",
    risk: "R1", authority: "edit", preferredBackends: ["uxp"], minimumPremiereVersion: "26.3.0", mutatesProject: true, undoable: true,
    verification: "catalog allowlist and project revision", support: "implemented_unverified", argsSchema: runtimeCall,
  },
  {
    id: "uxp.sensitive", domain: "api", title: "Invoke unverified UXP mutation", description: "Invoke a writable property or mutation that is fail-closed behind R2 confirmation.",
    risk: "R2", authority: "edit", preferredBackends: ["uxp"], minimumPremiereVersion: "26.3.0", mutatesProject: true, undoable: false,
    verification: "catalog allowlist and explicit host response", support: "implemented_unverified", argsSchema: runtimeCall,
  },
  {
    id: "uxp.filesystem", domain: "api", title: "Invoke official UXP filesystem member", description: "Invoke one catalog member that reads or writes an approved local path.",
    risk: "R2", authority: "filesystem", preferredBackends: ["uxp"], minimumPremiereVersion: "26.3.0", mutatesProject: true, undoable: false,
    verification: "catalog allowlist, approved paths, and host response", support: "implemented_unverified", argsSchema: runtimeCall,
  },
  {
    id: "uxp.destructive", domain: "api", title: "Invoke official UXP destructive member", description: "Invoke one catalog member classified as destructive or externally publishing.",
    risk: "R3", authority: "experimental", preferredBackends: ["uxp"], minimumPremiereVersion: "26.3.0", mutatesProject: true, undoable: false,
    verification: "catalog allowlist and explicit postcondition", support: "experimental", argsSchema: runtimeCall,
  },
  {
    id: "uxp.handle.release", domain: "api", title: "Release UXP object handle", description: "Release a session-scoped Premiere object reference.",
    risk: "R0", authority: "inspect", preferredBackends: ["uxp"], minimumPremiereVersion: "26.3.0", mutatesProject: false, undoable: false,
    verification: "handle table response", support: "implemented_unverified", argsSchema: handleRelease,
  },
  {
    id: "uxp.page.read", domain: "api", title: "Read next UXP result page", description: "Read the next bounded page from an oversized array or object result.",
    risk: "R0", authority: "inspect", preferredBackends: ["uxp"], minimumPremiereVersion: "26.3.0", mutatesProject: false, undoable: false,
    verification: "session-scoped page handle", support: "implemented_unverified", argsSchema: pageRead,
  },
  {
    id: "uxp.transaction.execute", domain: "api", title: "Execute UXP transaction", description: "Build deferred Action objects and commit them inside Project.executeTransaction.",
    risk: "R3", authority: "experimental", preferredBackends: ["uxp"], minimumPremiereVersion: "26.3.0", mutatesProject: true, undoable: true,
    verification: "transaction return and project revision", support: "implemented_unverified", argsSchema: transactionPlan,
  },
  {
    id: "uxp.locked.batch", domain: "api", title: "Execute locked UXP read batch", description: "Run synchronous read members inside Project.lockedAccess; Promise members are rejected explicitly.",
    risk: "R0", authority: "inspect", preferredBackends: ["uxp"], minimumPremiereVersion: "26.3.0", mutatesProject: false, undoable: false,
    verification: "lockedAccess callback completion", support: "implemented_unverified", argsSchema: lockedBatch,
  },
  {
    id: "uxp.events.subscribe", domain: "api", title: "Subscribe to UXP event", description: "Create a bridge-owned bounded event listener.",
    risk: "R1", authority: "edit", preferredBackends: ["uxp"], minimumPremiereVersion: "26.3.0", mutatesProject: false, undoable: false,
    verification: "subscription registry", support: "implemented_unverified", argsSchema: eventSubscription,
  },
  {
    id: "uxp.events.poll", domain: "api", title: "Poll UXP events", description: "Read and drain bounded events captured by the UXP bridge.",
    risk: "R0", authority: "inspect", preferredBackends: ["uxp"], minimumPremiereVersion: "26.3.0", mutatesProject: false, undoable: false,
    verification: "event ring buffer", support: "implemented_unverified", argsSchema: eventPoll,
  },
  {
    id: "uxp.events.unsubscribe", domain: "api", title: "Unsubscribe UXP event", description: "Remove a bridge-owned UXP event listener.",
    risk: "R1", authority: "edit", preferredBackends: ["uxp"], minimumPremiereVersion: "26.3.0", mutatesProject: false, undoable: false,
    verification: "subscription registry", support: "implemented_unverified", argsSchema: subscriptionId,
  },
  {
    id: "cep.surface.catalog", domain: "api", title: "Search legacy DOM capabilities", description: "Discover reflected ExtendScript members as opaque session capabilities without evaluating getters.",
    risk: "R0", authority: "inspect", preferredBackends: ["cep"], minimumPremiereVersion: "26.3.0", mutatesProject: false, undoable: false,
    verification: "host reflection inventory", support: "implemented_unverified", argsSchema: capabilityCatalog,
  },
  ...(["read", "edit", "filesystem", "destructive"] as const).map((bucket): ActionDescriptor => ({
    id: `cep.${bucket}`, domain: "api", title: `Invoke legacy DOM ${bucket} capability`, description: "Invoke a host-issued opaque ExtendScript capability; raw paths and raw script are never accepted.",
    risk: bucket === "read" ? "R0" : bucket === "edit" ? "R1" : bucket === "filesystem" ? "R2" : "R3",
    authority: bucket === "read" ? "inspect" : bucket === "edit" ? "edit" : bucket === "filesystem" ? "filesystem" : "experimental",
    preferredBackends: ["cep"], minimumPremiereVersion: "26.3.0", mutatesProject: bucket !== "read", undoable: bucket === "edit",
    verification: "opaque capability and host response", support: bucket === "destructive" ? "experimental" : "implemented_unverified", argsSchema: capabilityCall,
  })),
  {
    id: "qe.catalog", domain: "api", title: "Search QE capabilities", description: "Discover experimental QE members, effects, and transitions as opaque capabilities.",
    risk: "R0", authority: "inspect", preferredBackends: ["qe"], minimumPremiereVersion: "26.3.2", mutatesProject: false, undoable: false,
    verification: "QE reflection inventory", support: "experimental", argsSchema: capabilityCatalog,
  },
  ...(["read", "edit", "destructive"] as const).map((bucket): ActionDescriptor => ({
    id: `qe.${bucket}`, domain: "api", title: `Invoke QE ${bucket} capability`, description: "Invoke a host-issued opaque QE capability in the experimental backend.",
    risk: bucket === "read" ? "R0" : bucket === "edit" ? "R2" : "R3", authority: bucket === "read" ? "inspect" : "experimental",
    preferredBackends: ["qe"], minimumPremiereVersion: "26.3.2", mutatesProject: bucket !== "read", undoable: bucket === "edit",
    verification: "opaque QE capability and host readback", support: "experimental", argsSchema: capabilityCall,
  })),
  ...uiSemanticActions,
  {
    id: "host.inspect", domain: "inspection", title: "Inspect Premiere host", description: "Read installed and connected host status without project content.",
    risk: "R0", authority: "inspect", preferredBackends: ["uxp", "cep", "local"], minimumPremiereVersion: "26.3.0", mutatesProject: false, undoable: false,
    verification: "host handshake", support: "implemented_unverified", argsSchema: emptyArgs,
  },
  {
    id: "project.inspect", domain: "inspection", title: "Inspect active project", description: "Read a bounded active-project and sequence snapshot.",
    risk: "R0", authority: "inspect", preferredBackends: ["uxp", "cep"], minimumPremiereVersion: "26.3.0", mutatesProject: false, undoable: false,
    verification: "host snapshot", support: "implemented_unverified", argsSchema: optionalScope,
  },
  {
    id: "sequence.inspect", domain: "inspection", title: "Inspect active sequence", description: "Read active-sequence tracks and playhead state.",
    risk: "R0", authority: "inspect", preferredBackends: ["uxp", "cep"], minimumPremiereVersion: "26.3.0", mutatesProject: false, undoable: false,
    verification: "host snapshot", support: "implemented_unverified", argsSchema: emptyArgs,
  },
  {
    id: "project.create", domain: "project", title: "Create project", description: "Create a new Premiere project at an approved local path.",
    risk: "R2", authority: "filesystem", preferredBackends: ["uxp", "cep"], minimumPremiereVersion: "26.3.0", mutatesProject: true, undoable: false,
    verification: "active project path and non-empty project file", support: "implemented_unverified", argsSchema: projectPath,
  },
  {
    id: "project.save", domain: "project", title: "Save active project", description: "Save the active project and require Premiere confirmation.",
    risk: "R2", authority: "edit", preferredBackends: ["uxp", "cep"], minimumPremiereVersion: "26.3.0", mutatesProject: true, undoable: false,
    verification: "host save confirmation", support: "implemented_unverified", argsSchema: emptyArgs,
  },
  {
    id: "project.open", domain: "project", title: "Open project", description: "Open an approved local Premiere project.",
    risk: "R2", authority: "filesystem", preferredBackends: ["uxp", "cep", "ui"], minimumPremiereVersion: "26.3.0", mutatesProject: false, undoable: false,
    verification: "active project path readback", support: "implemented_unverified", argsSchema: projectPath,
  },
  {
    id: "media.import", domain: "media", title: "Import media", description: "Import approved local media into the active project.",
    risk: "R2", authority: "filesystem", preferredBackends: ["uxp", "cep"], minimumPremiereVersion: "26.3.0", mutatesProject: true, undoable: false,
    verification: "project item identity readback", support: "implemented_unverified", argsSchema: mediaImport,
  },
  ...coreSemanticActions,
  {
    id: "timeline.sequence.create_from_media", domain: "timeline", title: "Create sequence from media", description: "Create a named sequence from exact imported project-item identities.",
    risk: "R1", authority: "edit", preferredBackends: ["uxp", "cep"], minimumPremiereVersion: "26.3.0", mutatesProject: true, undoable: true,
    verification: "sequence count and active sequence identity readback", support: "implemented_unverified", argsSchema: sequenceFromMedia,
  },
  {
    id: "timeline.ripple_delete", domain: "timeline", title: "Ripple delete", description: "Experimental QE-backed ripple delete with boundary verification.",
    risk: "R2", authority: "experimental", preferredBackends: ["qe"], minimumPremiereVersion: "26.3.2", mutatesProject: true, undoable: true,
    verification: "sequence structure readback", support: "experimental", argsSchema: z.object({ clipId: z.string().min(1) }).strict(),
  },
  {
    id: "effects.catalog", domain: "effects_audio", title: "List effects and transitions", description: "Discover first- and third-party effects and transitions from the host.",
    risk: "R0", authority: "inspect", preferredBackends: ["uxp", "cep", "local"], minimumPremiereVersion: "26.3.0", mutatesProject: false, undoable: false,
    verification: "runtime inventory", support: "implemented_unverified", argsSchema: emptyArgs,
  },
  {
    id: "effects.apply", domain: "effects_audio", title: "Apply effect", description: "Apply a discovered effect and read back the component chain.",
    risk: "R1", authority: "edit", preferredBackends: ["uxp", "cep"], minimumPremiereVersion: "26.3.0", mutatesProject: true, undoable: true,
    verification: "component chain readback", support: "unsupported", argsSchema: effectAction,
  },
  {
    id: "captions.inspect", domain: "text_captions", title: "Inspect captions", description: "Read caption-track structure without transcript content.",
    risk: "R0", authority: "inspect", preferredBackends: ["uxp", "cep"], minimumPremiereVersion: "26.3.0", mutatesProject: false, undoable: false,
    verification: "host snapshot", support: "implemented_unverified", argsSchema: emptyArgs,
  },
  {
    id: "export.frame", domain: "export", title: "Export frame", description: "Export one frame to an approved path and verify the file.",
    risk: "R2", authority: "filesystem", preferredBackends: ["uxp"], minimumPremiereVersion: "26.3.0", mutatesProject: false, undoable: false,
    verification: "non-empty output file", support: "implemented_unverified", argsSchema: exportFrame,
  },
  {
    id: "export.sequence", domain: "export", title: "Export sequence", description: "Export the active sequence with an approved preset and output path.",
    risk: "R3", authority: "filesystem", preferredBackends: ["uxp", "cep"], minimumPremiereVersion: "26.3.0", mutatesProject: false, undoable: false,
    verification: "output size and checksum", support: "implemented_unverified", argsSchema: exportSequence,
  },
  {
    id: "workspace.set", domain: "workspace", title: "Switch workspace", description: "Switch to a named Premiere workspace.",
    risk: "R1", authority: "edit", preferredBackends: ["cep", "ui"], minimumPremiereVersion: "26.3.0", mutatesProject: false, undoable: false,
    verification: "workspace state readback", support: "ui_fallback", argsSchema: workspaceSet,
  },
  {
    id: "history.undo", domain: "workspace", title: "Undo last action", description: "Request one Premiere undo operation and read back active state.",
    risk: "R1", authority: "edit", preferredBackends: ["cep", "ui"], minimumPremiereVersion: "26.3.0", mutatesProject: true, undoable: false,
    verification: "active state readback", support: "unsupported", argsSchema: emptyArgs,
  },
  {
    id: "plugin.catalog", domain: "plugins", title: "Inventory installed plugins", description: "List installed Premiere effects and extension manifests without exposing full paths.",
    risk: "R0", authority: "inspect", preferredBackends: ["local", "uxp", "cep"], minimumPremiereVersion: "26.3.0", mutatesProject: false, undoable: false,
    verification: "local and host inventory", support: "implemented_unverified", argsSchema: emptyArgs,
  },
  {
    id: "plugin.ui.invoke", domain: "plugins", title: "Invoke approved plugin UI adapter", description: "Run a versioned semantic adapter for a discovered plugin panel.",
    risk: "R2", authority: "experimental", preferredBackends: ["ui"], minimumPremiereVersion: "26.3.2", mutatesProject: true, undoable: false,
    verification: "semantic UI state and host readback", support: "ui_fallback", argsSchema: pluginUi,
  },
  {
    id: "cloud.status", domain: "cloud", title: "Inspect cloud readiness", description: "Inspect visible login, entitlement, and network readiness without credentials.",
    risk: "R0", authority: "cloud", preferredBackends: ["ui"], minimumPremiereVersion: "26.3.2", mutatesProject: false, undoable: false,
    verification: "visible session state", support: "ui_fallback", argsSchema: z.object({ service: z.enum(["frameio", "stock", "generative"]) }).strict(),
  },
  {
    id: "cloud.action", domain: "cloud", title: "Run approved cloud action", description: "Execute an approved signed-in cloud workflow without extracting credentials.",
    risk: "R3", authority: "cloud", preferredBackends: ["ui"], minimumPremiereVersion: "26.3.2", mutatesProject: false, undoable: false,
    verification: "visible cloud receipt", support: "entitlement_blocked", argsSchema: cloudAction,
  },
];

const actionMap = new Map(actions.map((action) => [action.id, action]));

export function listActions(domain?: ActionDomain): ActionDescriptor[] {
  return actions.filter((action) => !domain || action.domain === domain);
}

export function getAction(actionId: string): ActionDescriptor {
  const action = actionMap.get(actionId);
  if (!action) throw new Error(`Unknown actionId: ${actionId}`);
  return action;
}

export function validateActionArgs(action: ActionDescriptor, args: Record<string, unknown>): Record<string, unknown> {
  return action.argsSchema.parse(args);
}
