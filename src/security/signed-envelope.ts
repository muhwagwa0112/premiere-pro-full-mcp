import { createHmac, timingSafeEqual } from "node:crypto";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export function signEnvelope(value: Record<string, unknown>, secret: Buffer): string {
  return createHmac("sha256", secret).update(canonicalJson(value)).digest("base64url");
}

export function verifyEnvelope(value: Record<string, unknown>, signature: unknown, secret: Buffer): boolean {
  if (typeof signature !== "string") return false;
  const expected = Buffer.from(signEnvelope(value, secret), "base64url");
  const provided = Buffer.from(signature, "base64url");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}
