import { readFile } from "node:fs/promises";
import type { ScriptTransport } from "../server.js";
import { secondsToTicks } from "./time.js";
import type { VerificationResult } from "../automation/contracts.js";
export interface AudioEncodingProfile {
  id: string; hostVersion: string; route: "cep" | "uxp"; componentMatchName: string; parameterIdentity: string;
  encoding: "decibels" | "linear_amplitude" | "db_plus_offset"; offset?: number;
  minDb: number; maxDb: number;
  /** Clock is installation-qualified; public keyframe times remain relative to the clip on the timeline. */
  keyframeClock?: "sequence" | "clip_relative" | "source";
  sourceTimeMap?: "constant_speed";
  retimeParameter?: { componentMatchName: string; parameterIdentity: string };
  qualification: { hostBuild: string; evidenceDigest: string };
}
export async function audioProfiles(): Promise<AudioEncodingProfile[]> {
  const file = process.env.PREMIERE_AUDIO_ENCODING_FILE;
  if (!file) return [];
  const value: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(value)) throw new Error("Audio encoding configuration must be an array");
  for (const p of value as AudioEncodingProfile[]) {
    if (!p.id || !p.hostVersion || !["cep", "uxp"].includes(p.route) || !p.componentMatchName || !p.parameterIdentity ||
      !["decibels", "linear_amplitude", "db_plus_offset"].includes(p.encoding) || !Number.isFinite(p.minDb) || !Number.isFinite(p.maxDb) ||
      p.minDb > p.maxDb || p.encoding === "db_plus_offset" && !Number.isFinite(p.offset) ||
      !p.qualification?.hostBuild || !/^[a-f0-9]{64}$/.test(p.qualification.evidenceDigest) ||
      p.keyframeClock !== undefined && !["sequence", "clip_relative", "source"].includes(p.keyframeClock) ||
      p.sourceTimeMap !== undefined && p.sourceTimeMap !== "constant_speed" ||
      p.retimeParameter !== undefined && (!p.retimeParameter.componentMatchName || !p.retimeParameter.parameterIdentity)) throw new Error("Audio encoding profile lacks parameter identity or qualification");
  }
  return value as AudioEncodingProfile[];
}
export function encodeDb(db: number, profile: AudioEncodingProfile): number {
  if (!Number.isFinite(db) || db < profile.minDb || db > profile.maxDb) throw new Error("Audio level is outside the qualified parameter range");
  if (profile.encoding === "linear_amplitude") return 10 ** (db / 20);
  return db + (profile.encoding === "db_plus_offset" ? profile.offset! : 0);
}
export function decodeDb(raw: number, profile: AudioEncodingProfile): number {
  return profile.encoding === "linear_amplitude" ? 20 * Math.log10(raw) : raw - (profile.encoding === "db_plus_offset" ? profile.offset! : 0);
}
export function parameterTick(timelineTick: string, state: { startTicks: string; endTicks: string; inTicks: string; outTicks: string; reverse: boolean }, profile: Pick<AudioEncodingProfile, "keyframeClock" | "sourceTimeMap">): string {
  const start = BigInt(state.startTicks), end = BigInt(state.endTicks), at = BigInt(timelineTick);
  if (at < start || at > end) throw new Error("Audio keyframe lies outside the target clip");
  if (profile.keyframeClock === "sequence") return at.toString();
  if (profile.keyframeClock === "clip_relative") return (at - start).toString();
  if (profile.keyframeClock !== "source" || profile.sourceTimeMap !== "constant_speed") throw Object.assign(new Error("A qualified keyframe clock and constant source time map are required"), { code: "KEYFRAME_CLOCK_UNQUALIFIED" });
  const span = end - start, sourceIn = BigInt(state.inTicks), sourceOut = BigInt(state.outTicks), numerator = (at - start) * (sourceOut - sourceIn);
  if (span <= 0n || numerator % span) throw new Error("Keyframe cannot be represented exactly in the source time map");
  return (state.reverse ? sourceOut - numerator / span : sourceIn + numerator / span).toString();
}
export function observedGainEnvelope(requested: { ticks: string; db: number }[], profile: AudioEncodingProfile, state: Parameters<typeof parameterTick>[1], result: Record<string, unknown>): VerificationResult {
  const expected = requested.map(point => ({ timelineTicks: point.ticks, nativeTicks: parameterTick(point.ticks, state, profile), db: point.db, value: encodeDb(point.db, profile) }));
  const values = result.values as { ticks?: unknown; value?: unknown }[] | undefined;
  const keys = result.keyframeTicks as unknown[] | undefined;
  const fail = () => { throw Object.assign(new Error("The gain envelope lacks matching native keyframe/value observations"), { code: "AUDIO_ENVELOPE_UNVERIFIED", outcomeUnknown: true }); };
  if (!values || values.length !== expected.length || !keys || keys.length !== expected.length || new Set(keys).size !== keys.length) fail();
  const actual = expected.map(point => {
    const matches = values!.filter(value => value.ticks === point.nativeTicks);
    if (matches.length !== 1 || typeof matches[0]!.value !== "number" || !Number.isFinite(matches[0]!.value) || Math.abs(matches[0]!.value - point.value) > 1e-7 || !keys!.includes(point.nativeTicks)) fail();
    const value = matches[0]!.value as number;
    const db = decodeDb(value, profile);
    if (!Number.isFinite(db) || Math.abs(db - point.db) > 0.001) fail();
    return { timelineTicks: point.timelineTicks, nativeTicks: point.nativeTicks, value, db };
  });
  const samples = result.interpolationSamples as { ticks: string; value: number }[] | undefined;
  const sorted = [...expected].sort((a, b) => BigInt(a.nativeTicks) < BigInt(b.nativeTicks) ? -1 : 1);
  const intervals = sorted.slice(1).flatMap((end, index) => { const start = sorted[index]!, delta = BigInt(end.nativeTicks) - BigInt(start.nativeTicks); return delta > 1n ? [{ start, end, at: BigInt(start.nativeTicks) + delta / 2n, delta }] : []; });
  if (!Array.isArray(samples) || samples.length !== intervals.length) fail();
  for (const { start, end, at, delta } of intervals) {
    const matches = samples!.filter(sample => sample.ticks === String(at));
    const wanted = start.value + (end.value - start.value) * Number(at - BigInt(start.nativeTicks)) / Number(delta);
    if (matches.length !== 1 || !Number.isFinite(matches[0]!.value) || Math.abs(matches[0]!.value - wanted) > 1e-7) fail();
  }
  return { assertionId: "audio.duck_envelope", status: "pass", method: "Exact native keyframe inventory, getValueAtTime at every requested knot and linear interval midpoint, mapped with the installation-qualified parameter clock", expected: expected.map(point => ({ ticks: point.timelineTicks, db: point.db })), actual: { points: actual, interpolationSamples: samples!, encodingProfile: profile.id, encoding: profile.encoding, keyframeClock: profile.keyframeClock!, sourceTimeMap: profile.sourceTimeMap ?? null, qualificationDigest: profile.qualification.evidenceDigest, clipState: { ...state } } };
}
function unwrap(value: unknown): Record<string, unknown> {
  if (typeof value === "string") return unwrap(JSON.parse(value));
  const r = value as Record<string, unknown>;
  if (!r || r.success === false) throw Object.assign(new Error(String(r?.error ?? "Audio host request failed")), { code: String(r?.code ?? "AUDIO_HOST_FAILED"), outcomeUnknown: r?.outcomeUnknown === true, ...(r?.dispatchState !== undefined ? { dispatchState: r.dispatchState } : {}), ...(r?.effect !== undefined ? { effect: r.effect } : {}) });
  return r.data && typeof r.data === "object" ? r.data as Record<string, unknown> : r;
}
/** Read parameter identity first; no universal dB offset is assumed. */
export async function editAudio(bridge: ScriptTransport, args: Record<string, unknown>, mode: "scalar" | "keyframes"): Promise<unknown> {
  const id = JSON.stringify(String(args.node_id ?? ""));
  const sequence = (sequenceId: string) => "var seq=null,sequenceId=" + JSON.stringify(sequenceId) + ";if(sequenceId){for(var s=0;s<app.project.sequences.numSequences;s++)if(String(app.project.sequences[s].sequenceID)===sequenceId){if(seq)throw Error('SEQUENCE_NOT_UNIQUE');seq=app.project.sequences[s];}}else seq=app.project.activeSequence;if(!seq)throw Error('NO_SEQUENCE');";
  const locate = "var matches=[]; for(var t=0;t<seq.audioTracks.numTracks;t++)for(var c=0;c<seq.audioTracks[t].clips.numItems;c++){var x=seq.audioTracks[t].clips[c];if(String(x.nodeId)===" + id + ")matches.push(x);} if(matches.length!==1)throw Error('TARGET_NOT_UNIQUE');var clip=matches[0];";
  const discover = "(function(){try{" + sequence(String(args.sequence_id ?? "")) + locate +
    "var params=[];for(var c=0;c<clip.components.numItems;c++){var comp=clip.components[c];for(var p=0;p<comp.properties.numItems;p++){var prop=comp.properties[p];var keys=typeof prop.getKeys==='function'?prop.getKeys():null;params.push({componentIndex:c,parameterIndex:p,componentMatchName:String(comp.matchName),parameterIdentity:String(prop.matchName||prop.displayName),raw:prop.getValue(),timeVarying:typeof prop.isTimeVarying==='function'?prop.isTimeVarying():null,keyCount:keys&&typeof keys.length==='number'?keys.length:null});}}var reversed=clip.isSpeedReversed();return JSON.stringify({success:true,data:{hostVersion:String(app.version),sequenceId:String(seq.sequenceID),projectPath:String(app.project.path),parameters:params,startTicks:String(clip.start.ticks),endTicks:String(clip.end.ticks),inTicks:String(clip.inPoint.ticks),outTicks:String(clip.outPoint.ticks),reverse:reversed===1||reversed===true}});}catch(e){return JSON.stringify({success:false,error:String(e)});}})();";
  const metadata = unwrap(await bridge.executeScript(discover));
  const profiles = await audioProfiles(), parameters = metadata.parameters as Record<string, unknown>[];
  const candidates = profiles.flatMap(profile => parameters.filter(parameter => profile.route === "cep" && profile.hostVersion === metadata.hostVersion &&
    profile.componentMatchName === parameter.componentMatchName && profile.parameterIdentity === parameter.parameterIdentity &&
    (args.encoding_profile_id === undefined || args.encoding_profile_id === profile.id)).map(parameter => ({ profile, parameter })));
  if (candidates.length !== 1) throw Object.assign(new Error("No unique qualified audio valueEncoding matches this host and parameter"), { code: "AUDIO_PARAMETER_ENCODING_UNKNOWN" });
  const { profile, parameter } = candidates[0]!;
  if (mode === "keyframes" && profile.keyframeClock === "source") {
    const retime = parameters.filter(p => p.componentMatchName === profile.retimeParameter?.componentMatchName && p.parameterIdentity === profile.retimeParameter?.parameterIdentity);
    if (retime.length !== 1 || retime[0]!.timeVarying !== false || retime[0]!.keyCount !== 0) throw Object.assign(new Error("Existing source-clock audio requires a static intrinsic retime parameter readback"), { code: "TIME_MAP_UNQUALIFIED" });
  }
  const points = mode === "keyframes" ? (args.keyframes as { time_seconds: number; level_db: number }[]).map(point => ({
    ticks: parameterTick((BigInt(String(metadata.startTicks)) + BigInt(secondsToTicks(point.time_seconds))).toString(), metadata as unknown as Parameters<typeof parameterTick>[1], profile),
    raw: encodeDb(point.level_db, profile), db: point.level_db,
  })) : [{ ticks: "", raw: encodeDb(Number(args.level_db), profile), db: Number(args.level_db) }];
  const body = "(function(){try{" + sequence(String(metadata.sequenceId)) + "if(String(app.project.path)!==" + JSON.stringify(metadata.projectPath) + ")throw Error('PROJECT_CHANGED');" + locate +
    "if(String(clip.start.ticks)!==" + JSON.stringify(metadata.startTicks) + "||String(clip.end.ticks)!==" + JSON.stringify(metadata.endTicks) + "||String(clip.inPoint.ticks)!==" + JSON.stringify(metadata.inTicks) + "||String(clip.outPoint.ticks)!==" + JSON.stringify(metadata.outTicks) + ")throw Error('CLIP_CHANGED');" +
    "var comp=clip.components[" + parameter.componentIndex + "],prop=comp.properties[" + parameter.parameterIndex + "];" +
    "if(String(comp.matchName)!==" + JSON.stringify(profile.componentMatchName) + "||String(prop.matchName||prop.displayName)!==" + JSON.stringify(profile.parameterIdentity) + ")throw Error('PARAMETER_IDENTITY_CHANGED');" +
    "var points=" + JSON.stringify(points) + ",readback=[];" + (mode === "keyframes" ? "prop.setTimeVarying(true);" : "") +
    "for(var k=0;k<points.length;k++){var x=points[k];" + (mode === "keyframes" ? "prop.addKey(x.ticks);prop.setValueAtKey(x.ticks,x.raw,true);var value=Number(prop.getValueAtKey(x.ticks));" : "prop.setValue(x.raw,true);var value=Number(prop.getValue());") +
    "if(!isFinite(value)||Math.abs(value-x.raw)>0.000001)return JSON.stringify({success:false,code:'AUDIO_READBACK_NOT_VERIFIED',outcomeUnknown:true,error:'Audio parameter readback mismatch'});readback.push({ticks:x.ticks,value:value});}" +
    "return JSON.stringify({success:true,data:{readback:readback}});}catch(e){return JSON.stringify({success:false,code:'AUDIO_WRITE_NOT_VERIFIED',outcomeUnknown:true,error:String(e)});}})();";
  const applied = unwrap(await bridge.executeScript(body));
  return { success: true, data: { encodingProfile: profile.id, valueEncoding: profile.encoding, requested: points.map(p => p.db),
    readback: (applied.readback as { ticks: string; value: number }[]).map(p => ({ ...p, db: decodeDb(p.value, profile) })) } };
}
