import { z } from "zod";
import type { ActionDescriptor } from "../contracts.js";

const uxpHandle = z.object({
  $ref: z.string().min(8).max(256),
  type: z.string().min(1).max(128).optional(),
  session: z.string().min(8).max(128),
  stateToken: z.string().min(16).max(512).regex(/^semantic-v1-/),
}).strict();

const projectSaveAs = z.object({ path: z.string().min(1).max(4096), overwrite: z.literal(false).default(false) }).strict();
const disposableProjectClose = z.object({
  path: z.string().min(1).max(4096),
  saveBeforeClose: z.literal(true),
}).strict();
const mediaRelink = z.object({
  clip: uxpHandle,
  path: z.string().min(1).max(4096),
  overrideCompatibilityCheck: z.boolean().default(false),
}).strict();
const mediaProxyAttach = z.object({
  clip: uxpHandle,
  path: z.string().min(1).max(4096),
  isHiRes: z.boolean().default(false),
  teamProjectAlternate: z.literal(false).default(false),
}).strict();
const trackSetMute = z.object({
  sequence: uxpHandle,
  mediaType: z.enum(["video", "audio"]),
  trackIndex: z.number().int().nonnegative(),
  muted: z.boolean(),
}).strict();
const clipInsert = z.object({
  sequence: uxpHandle,
  projectItem: uxpHandle,
  timeSeconds: z.number().finite().nonnegative().max(604_800),
  videoTrackIndex: z.number().int().nonnegative(),
  audioTrackIndex: z.number().int().nonnegative(),
  limitShift: z.boolean().default(true),
}).strict();

export interface CoreFeatureRegistryEntry {
  featureId: string;
  domain: string;
  title: string;
  status: "SUPPORTED_CONTEXTUAL" | "UNVERIFIED";
  backends: Array<"uxp" | "cep">;
  risk: "R1" | "R2";
  minimumPremiereVersion: string;
  maximumPremiereVersion: null;
  preconditions: string[];
  verification: string[];
  fixture: string;
  limitations: string[];
  action: ActionDescriptor;
}

export const coreSemanticFeatures: readonly CoreFeatureRegistryEntry[] = [
  {
    featureId: "project.checkpoint", domain: "project", title: "Create verified project checkpoint", status: "SUPPORTED_CONTEXTUAL", backends: ["uxp", "cep"], risk: "R2",
    minimumPremiereVersion: "26.3.0", maximumPremiereVersion: null,
    preconditions: ["saved active project inside an approved root", "exact route-bound two-phase project identity check"],
    verification: ["active project saved", "exclusive sibling checkpoint copy matches byte count and SHA-256"],
    fixture: "basic-edit", limitations: ["requires an approved project root", "live v0.3 evidence not yet recorded"],
    action: {
      id: "project.checkpoint", domain: "project", title: "Create verified project checkpoint", description: "Save the active project through a route-bound two-phase identity check and create a verified sibling checkpoint copy.",
      risk: "R2", authority: "edit", preferredBackends: ["uxp", "cep"], minimumPremiereVersion: "26.3.0", mutatesProject: true, undoable: false,
      verification: "saved project and exclusive checkpoint copy byte/SHA-256 verification", support: "implemented_unverified", argsSchema: z.object({}).strict(),
      verifierId: "project.checkpoint.v1",
    },
  },
  {
    featureId: "project.close_disposable", domain: "project", title: "Close OS-temporary fixture-path project", status: "SUPPORTED_CONTEXTUAL", backends: ["uxp"], risk: "R2",
    minimumPremiereVersion: "26.3.0", maximumPremiereVersion: null,
    preconditions: ["active project path inside a Premiere MCP OS-temporary fixture workspace", "expectedRevision scoped to active project identity", "typed save succeeds before close"],
    verification: ["project save returns true", "closed project identity is absent from active host readback"],
    fixture: "basic-edit", limitations: ["always saves before closing; unsaved work is never discarded", "cannot close a project outside the guarded OS-temporary fixture path", "live v0.3 evidence not yet recorded"],
    action: {
      id: "project.close_disposable", domain: "project", title: "Save and close OS-temporary fixture-path project", description: "Save, then close only an active project whose exact path satisfies the guarded OS-temporary fixture-path policy, and verify its identity is no longer active.",
      risk: "R2", authority: "filesystem", preferredBackends: ["uxp"], minimumPremiereVersion: "26.3.0", mutatesProject: true, undoable: false,
      verification: "save confirmation and closed project identity absent from active project readback", support: "implemented_unverified", argsSchema: disposableProjectClose,
      stateTokenRequired: true, stateScope: "active-project-identity", verifierId: "project.close_disposable.v1",
    },
  },
  {
    featureId: "project.save_as", domain: "project", title: "Save active project as", status: "SUPPORTED_CONTEXTUAL", backends: ["cep"], risk: "R2",
    minimumPremiereVersion: "26.3.0", maximumPremiereVersion: null,
    preconditions: ["active project", "expectedRevision scoped to active project", "approved destination path"],
    verification: ["active project path equals requested canonical path", "saved project file exists and is non-empty"],
    fixture: "basic-edit", limitations: ["CEP typed compatibility path; live v0.3 evidence not yet recorded", "Existing project files are never overwritten"],
    action: {
      id: "project.save_as", domain: "project", title: "Save active project as", description: "Save the active project to an approved new path and verify the exact active path and file.",
      risk: "R2", authority: "filesystem", preferredBackends: ["cep"], minimumPremiereVersion: "26.3.0", mutatesProject: true, undoable: false,
      verification: "exact active project path and non-empty file readback", support: "implemented_unverified", argsSchema: projectSaveAs,
      stateTokenRequired: true, stateScope: "active-project-identity", verifierId: "project.save_as.v1",
    },
  },
  {
    featureId: "media.relink", domain: "media", title: "Relink clip media", status: "SUPPORTED_CONTEXTUAL", backends: ["uxp"], risk: "R2",
    minimumPremiereVersion: "26.3.0", maximumPremiereVersion: null,
    preconditions: ["session-scoped ClipProjectItem handle", "expectedRevision scoped to active project", "approved replacement path"],
    verification: ["ClipProjectItem.getMediaFilePath equals requested path"],
    fixture: "offline-relink", limitations: ["requires a live ClipProjectItem handle from the same UXP session"],
    action: {
      id: "media.relink", domain: "media", title: "Relink clip media", description: "Relink one exact session-scoped clip project item to an approved path.",
      risk: "R2", authority: "filesystem", preferredBackends: ["uxp"], minimumPremiereVersion: "26.3.0", mutatesProject: true, undoable: false,
      verification: "exact media file path readback", support: "implemented_unverified", argsSchema: mediaRelink,
      stateTokenRequired: true, stateScope: "clip-project-item", verifierId: "media.relink.v1",
    },
  },
  {
    featureId: "media.proxy.attach", domain: "media", title: "Attach clip proxy", status: "SUPPORTED_CONTEXTUAL", backends: ["uxp"], risk: "R2",
    minimumPremiereVersion: "26.3.0", maximumPremiereVersion: null,
    preconditions: ["session-scoped ClipProjectItem handle", "expectedRevision scoped to active project", "approved proxy path"],
    verification: ["ClipProjectItem.hasProxy is true", "ClipProjectItem.getProxyPath equals requested path"],
    fixture: "proxy-attach", limitations: ["requires a live ClipProjectItem handle from the same UXP session", "Team Projects alternate-media attachment is not exposed"],
    action: {
      id: "media.proxy.attach", domain: "media", title: "Attach clip proxy", description: "Attach an approved proxy or high-resolution alternate to one exact clip project item.",
      risk: "R2", authority: "filesystem", preferredBackends: ["uxp"], minimumPremiereVersion: "26.3.0", mutatesProject: true, undoable: false,
      verification: "proxy presence and exact proxy path readback", support: "implemented_unverified", argsSchema: mediaProxyAttach,
      stateTokenRequired: true, stateScope: "clip-project-item", verifierId: "media.proxy.attach.v1",
    },
  },
  {
    featureId: "timeline.track.set_mute", domain: "timeline", title: "Set track mute state", status: "SUPPORTED_CONTEXTUAL", backends: ["uxp"], risk: "R1",
    minimumPremiereVersion: "26.3.0", maximumPremiereVersion: null,
    preconditions: ["session-scoped Sequence handle", "expectedRevision scoped to active sequence", "bounded track index"],
    verification: ["track isMuted readback equals requested state"],
    fixture: "basic-edit", limitations: ["requires a live Sequence handle from the same UXP session"],
    action: {
      id: "timeline.track.set_mute", domain: "timeline", title: "Set track mute state", description: "Set and read back the mute state of one exact video or audio track.",
      risk: "R1", authority: "edit", preferredBackends: ["uxp"], minimumPremiereVersion: "26.3.0", mutatesProject: true, undoable: false,
      verification: "exact track mute state readback", support: "implemented_unverified", argsSchema: trackSetMute,
      stateTokenRequired: true, stateScope: "sequence-track", verifierId: "timeline.track.set_mute.v1",
    },
  },
  {
    featureId: "timeline.clip.insert", domain: "timeline", title: "Insert project item", status: "SUPPORTED_CONTEXTUAL", backends: ["uxp"], risk: "R1",
    minimumPremiereVersion: "26.3.0", maximumPremiereVersion: null,
    preconditions: ["session-scoped Sequence and ProjectItem handles", "expectedRevision scoped to active sequence", "bounded target tracks and time"],
    verification: ["target video-track clip count increases", "project revision changes"],
    fixture: "basic-edit", limitations: ["requires live handles from the same UXP session", "single-item insert only", "insert time is bounded to seven days"],
    action: {
      id: "timeline.clip.insert", domain: "timeline", title: "Insert project item", description: "Insert one exact project item through a Premiere transaction and verify the target track count.",
      risk: "R1", authority: "edit", preferredBackends: ["uxp"], minimumPremiereVersion: "26.3.0", mutatesProject: true, undoable: true,
      verification: "target video-track clip count and project revision readback", support: "implemented_unverified", argsSchema: clipInsert,
      stateTokenRequired: true, stateScope: "sequence-track", verifierId: "timeline.clip.insert.v1",
    },
  },
] as const;

export const coreSemanticActions: ActionDescriptor[] = coreSemanticFeatures.map((entry) => entry.action);
