const verifierIds = new Map<string, string>([
  ["project.save_as", "project.save_as.v1"],
  ["project.close_disposable", "project.close_disposable.v1"],
  ["project.checkpoint", "project.checkpoint.v1"],
  ["media.relink", "media.relink.v1"],
  ["media.proxy.attach", "media.proxy.attach.v1"],
  ["timeline.track.set_mute", "timeline.track.set_mute.v1"],
  ["timeline.clip.insert", "timeline.clip.insert.v1"],
]);

export interface SemanticVerification {
  registered: boolean;
  verified: boolean;
  method?: string;
  detail?: string;
}

function sameWindowsPath(left: unknown, right: unknown): boolean {
  return typeof left === "string" && typeof right === "string"
    && left.replace(/\//gu, "\\").replace(/\\+$/gu, "").toLowerCase() === right.replace(/\//gu, "\\").replace(/\\+$/gu, "").toLowerCase();
}

export function verifyCoreSemanticResult(actionId: string, result: unknown, args: Record<string, unknown> = {}): SemanticVerification {
  const verifierId = verifierIds.get(actionId);
  if (!verifierId) return { registered: false, verified: false };
  if (!result || typeof result !== "object") return { registered: true, verified: false, detail: "semantic result is missing" };
  const value = result as Record<string, unknown>;
  const verified = actionId === "project.checkpoint"
    ? value.checkpointCreated === true && typeof value.bytes === "number" && value.bytes > 0 && typeof value.sha256 === "string" && /^sha256:[a-f0-9]{64}$/.test(value.sha256)
    : actionId === "project.close_disposable"
    ? value.savedBeforeClose === true && value.closed === true && value.closedProjectIdentityAbsent === true && typeof value.closedProjectIdentity === "string" && value.closedProjectIdentity.length > 0
    : actionId === "project.save_as"
    ? value.saved === true && value.pathVerified === true && typeof value.bytes === "number" && value.bytes > 0 && sameWindowsPath(value.projectPath, args.path)
    : actionId === "media.relink"
      ? value.relinked === true && value.pathVerified === true && sameWindowsPath(value.mediaPath, args.path)
      : actionId === "media.proxy.attach"
        ? value.proxyAttached === true && value.pathVerified === true && sameWindowsPath(value.proxyPath, args.path)
        : actionId === "timeline.track.set_mute"
          ? value.stateVerified === true && value.muted === args.muted && value.mediaType === args.mediaType && value.trackIndex === args.trackIndex
          : value.inserted === true && value.trackCountVerified === true && typeof value.addedVideoItems === "number" && value.addedVideoItems > 0 && value.videoTrackIndex === args.videoTrackIndex && value.audioTrackIndex === args.audioTrackIndex;
  return verified
    ? { registered: true, verified: true, method: `server semantic verifier ${verifierId}` }
    : { registered: true, verified: false, detail: `postcondition did not satisfy ${verifierId}` };
}
