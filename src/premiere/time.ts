/** Premiere's integer clock. Wire values remain decimal strings, including beyond 2^53. */
export const TICKS_PER_SECOND = 254016000000n;
export interface FrameRate { numerator: number; denominator: number }
export function integer(value: unknown, field = "ticks"): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt(value);
  throw Object.assign(new Error(field + " must be an exact decimal integer"), { code: "INVALID_TIME" });
}
export function rationalRate(value: unknown = 24): FrameRate {
  if (value && typeof value === "object") {
    const input = value as FrameRate & { num?: number; den?: number };
    const r = { numerator: input.numerator ?? input.num!, denominator: input.denominator ?? input.den! };
    if (!Number.isSafeInteger(r.numerator) || !Number.isSafeInteger(r.denominator) || r.numerator <= 0 || r.denominator <= 0) throw new Error("Invalid rational frame rate");
    const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
    const d = gcd(r.numerator, r.denominator);
    return { numerator: r.numerator / d, denominator: r.denominator / d };
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Invalid frame rate");
  for (const rate of [24000, 30000, 60000, 120000]) {
    if (Math.abs(n - rate / 1001) < 0.0001 || n === Math.round(rate / 1001 * 100) / 100) return { numerator: rate, denominator: 1001 };
  }
  const [whole = "0", fraction = ""] = String(n).split(".");
  if (fraction.length > 6 || /e/i.test(String(n))) throw new Error("Use an explicit rational frame rate");
  return rationalRate({ numerator: Number(whole + fraction), denominator: 10 ** fraction.length });
}
function roundedDivision(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error("Invalid divisor");
  return n < 0n ? -((-n + d / 2n) / d) : (n + d / 2n) / d;
}
export function secondsToTicks(value: number | string): string {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Invalid seconds");
  let text = String(value);
  if (/e/i.test(text)) text = Number(value).toFixed(12);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error("Seconds must be a finite decimal");
  const fraction = match[3] ?? "";
  const numerator = BigInt(match[2]! + fraction) * (match[1] ? -1n : 1n);
  return roundedDivision(numerator * TICKS_PER_SECOND, 10n ** BigInt(fraction.length)).toString();
}
export function ticksToSeconds(value: unknown): number { return Number(integer(value)) / Number(TICKS_PER_SECOND); }
export function frameToTicks(frame: unknown, rate: FrameRate): string {
  const r = rationalRate(rate);
  return roundedDivision(integer(frame, "frame") * TICKS_PER_SECOND * BigInt(r.denominator), BigInt(r.numerator)).toString();
}
export function ticksToFrame(ticks: unknown, rate: FrameRate): bigint {
  const r = rationalRate(rate);
  return roundedDivision(integer(ticks) * BigInt(r.numerator), TICKS_PER_SECOND * BigInt(r.denominator));
}
function dropCount(rate: FrameRate, drop: boolean): bigint {
  if (!drop) return 0n;
  if (rate.denominator !== 1001 || ![30000, 60000].includes(rate.numerator)) throw new Error("Drop-frame requires 30000/1001 or 60000/1001");
  return BigInt(rate.numerator === 30000 ? 2 : 4);
}
export function formatTimecode(ticks: unknown, frameRate: unknown = 24, dropFrame = false): string {
  const rate = rationalRate(frameRate), nominal = BigInt(Math.round(rate.numerator / rate.denominator));
  const drop = dropCount(rate, dropFrame);
  let frames = ticksToFrame(ticks, rate);
  const sign = frames < 0n ? "-" : "";
  if (frames < 0n) frames = -frames;
  if (drop) {
    const tenMinutes = nominal * 600n - drop * 9n;
    const minute = nominal * 60n - drop;
    const remainder = frames % tenMinutes;
    frames += drop * 9n * (frames / tenMinutes) + (remainder >= drop ? drop * ((remainder - drop) / minute) : 0n);
  }
  const ff = frames % nominal, seconds = frames / nominal;
  const pad = (n: bigint) => String(n).padStart(2, "0");
  return sign + pad(seconds / 3600n) + ":" + pad(seconds / 60n % 60n) + ":" + pad(seconds % 60n) + (dropFrame ? ";" : ":") + pad(ff);
}
export function parseTimecode(timecode: string, frameRate: unknown = 24, dropFrame?: boolean): string {
  const rate = rationalRate(frameRate), nominal = BigInt(Math.round(rate.numerator / rate.denominator));
  const m = /^(-?)(\d{2,}):(\d{2}):(\d{2})([:;])(\d{2,3})$/.exec(timecode);
  if (!m) throw new Error("Timecode must be HH:MM:SS:FF or HH:MM:SS;FF");
  const drop = dropCount(rate, dropFrame ?? m[5] === ";");
  if (dropFrame === false && m[5] === ";") throw new Error("Drop-frame separator conflicts with rate policy");
  const h = BigInt(m[2]!), min = BigInt(m[3]!), sec = BigInt(m[4]!), frame = BigInt(m[6]!);
  if (min >= 60n || sec >= 60n || frame >= nominal || (drop && min % 10n !== 0n && sec === 0n && frame < drop)) throw new Error("Invalid or dropped timecode label");
  const minutes = h * 60n + min;
  let frames = ((h * 3600n + min * 60n + sec) * nominal + frame) - drop * (minutes - minutes / 10n);
  if (m[1]) frames = -frames;
  return frameToTicks(frames, rate);
}
