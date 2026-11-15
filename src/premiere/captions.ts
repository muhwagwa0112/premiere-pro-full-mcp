import { integer, TICKS_PER_SECOND } from "./time.js";
export interface CaptionCue { id: string; startTicks: string; endTicks: string; text: string }
export function validateCues(cues: CaptionCue[]): CaptionCue[] {
  const ids = new Set<string>();
  let prior = -1n;
  for (const cue of cues) {
    const start = integer(cue.startTicks), end = integer(cue.endTicks);
    if (!cue.id || ids.has(cue.id) || !cue.text.trim() || start < 0n || end <= start || start < prior) throw new Error("Invalid, duplicate or unordered caption cue");
    ids.add(cue.id); prior = start;
  }
  return cues;
}
function srtTime(ticks: string, ceil = false): string {
  const numerator = integer(ticks) * 1000n;
  const ms = (numerator + (ceil ? TICKS_PER_SECOND - 1n : TICKS_PER_SECOND / 2n)) / TICKS_PER_SECOND;
  const pad = (n: bigint, width = 2) => n.toString().padStart(width, "0");
  return pad(ms / 3600000n) + ":" + pad(ms / 60000n % 60n) + ":" + pad(ms / 1000n % 60n) + "," + pad(ms % 1000n, 3);
}
export function serializeSrt(cues: CaptionCue[], lineEnding: "\n" | "\r\n" = "\n"): string {
  return validateCues(cues).map((c, i) => [String(i + 1), srtTime(c.startTicks) + " --> " + srtTime(c.endTicks, true), c.text.replace(/\r\n?/g, "\n"), ""].join("\n")).join("\n").replace(/\n/g, lineEnding);
}
export function parseSrt(text: string): CaptionCue[] {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  const read = (v: string): string => {
    const m = /^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/.exec(v);
    if (!m || Number(m[2]) > 59 || Number(m[3]) > 59) throw new Error("Invalid SRT timestamp");
    return ((BigInt(m[1]!) * 3600000n + BigInt(m[2]!) * 60000n + BigInt(m[3]!) * 1000n + BigInt(m[4]!)) * TICKS_PER_SECOND / 1000n).toString();
  };
  const cues = normalized.split(/\n{2,}/).map((block, i) => {
    const lines = block.split("\n");
    if (/^\d+$/.test(lines[0]!)) lines.shift();
    const times = /^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(lines.shift() ?? "");
    if (!times) throw new Error("Invalid SRT cue " + (i + 1));
    return { id: "cue-" + (i + 1), startTicks: read(times[1]!), endTicks: read(times[2]!), text: lines.join("\n") };
  });
  return validateCues(cues);
}
export interface CutSegment { sourceAssetId: string; sourceInTicks: string; sourceOutTicks: string; timelineStartTicks: string; speedNumerator?: number; speedDenominator?: number; reverse?: boolean }
/** Split a source cue at cut boundaries and map each retained portion to the final timeline. */
export function mapCuesToTimeline(cues: CaptionCue[], segments: CutSegment[]): CaptionCue[] {
  const mapped: CaptionCue[] = [];
  for (const [segmentIndex, s] of segments.entries()) {
    const si = integer(s.sourceInTicks), so = integer(s.sourceOutTicks), ts = integer(s.timelineStartTicks);
    const num = BigInt(s.speedNumerator ?? 1), den = BigInt(s.speedDenominator ?? 1);
    if (num <= 0n || den <= 0n || so <= si) throw new Error("Invalid cut speed/range");
    for (const c of validateCues(cues)) {
      const start = integer(c.startTicks) > si ? integer(c.startTicks) : si;
      const end = integer(c.endTicks) < so ? integer(c.endTicks) : so;
      if (end <= start) continue;
      const a = s.reverse ? so - end : start - si, b = s.reverse ? so - start : end - si;
      mapped.push({ id: c.id + "-" + segmentIndex, startTicks: (ts + a * den / num).toString(), endTicks: (ts + b * den / num).toString(), text: c.text });
    }
  }
  return validateCues(mapped.sort((a, b) => integer(a.startTicks) < integer(b.startTicks) ? -1 : 1));
}
