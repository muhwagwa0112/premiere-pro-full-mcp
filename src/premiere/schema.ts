import { z } from "zod";
type Schema = Record<string, unknown>;
/** Recursive JSON-schema subset used by the upstream catalog. Unknown constraints fail closed. */
export function schemaToZod(input: unknown): z.ZodTypeAny {
  const s = input && typeof input === "object" ? input as Schema : {};
  let out: z.ZodTypeAny;
  if (Array.isArray(s.type)) {
    const options = s.type.map(type => schemaToZod({ ...s, type }));
    out = options.length === 0 ? z.never() : options.length === 1 ? options[0]! : z.union([options[0]!, options[1]!, ...options.slice(2)]);
  } else if (s.const !== undefined) out = z.literal(s.const as string | number | boolean | null);
  else if (Array.isArray(s.enum) && s.enum.length) {
    const options = s.enum.map(v => z.literal(v as string | number | boolean | null));
    out = options.length === 1 ? options[0]! : z.union([options[0]!, options[1]!, ...options.slice(2)]);
  } else if (Array.isArray(s.anyOf) || Array.isArray(s.oneOf)) {
    const options = (s.anyOf ?? s.oneOf) as unknown[];
    if (options.length < 2) out = schemaToZod(options[0]);
    else out = z.union(options.map(schemaToZod) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  } else if (s.type === "string") {
    let v = z.string();
    if (typeof s.minLength === "number") v = v.min(s.minLength);
    if (typeof s.maxLength === "number") v = v.max(s.maxLength);
    if (typeof s.pattern === "string") v = v.regex(new RegExp(s.pattern));
    out = v;
  } else if (s.type === "number" || s.type === "integer") {
    let v = s.type === "integer" ? z.number().int() : z.number().finite();
    if (typeof s.minimum === "number") v = v.min(s.minimum);
    if (typeof s.maximum === "number") v = v.max(s.maximum);
    out = v;
  } else if (s.type === "boolean") out = z.boolean();
  else if (s.type === "null") out = z.null();
  else if (s.type === "array") {
    let v = z.array(schemaToZod(s.items));
    if (typeof s.minItems === "number") v = v.min(s.minItems);
    if (typeof s.maxItems === "number") v = v.max(s.maxItems);
    out = v;
  } else if (s.type === "object" || s.properties) out = objectSchema(s);
  else out = z.unknown();
  if (typeof s.description === "string") out = out.describe(s.description);
  return out;
}
export function objectSchema(s: Schema = {}): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const required = new Set(Array.isArray(s.required) ? s.required as string[] : []);
  const properties = (s.properties ?? {}) as Record<string, unknown>;
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, value] of Object.entries(properties)) {
    const type = schemaToZod(value);
    shape[key] = required.has(key) ? type : type.optional();
  }
  const result = z.object(shape).strict();
  if (s.additionalProperties && typeof s.additionalProperties === "object") return result.catchall(schemaToZod(s.additionalProperties));
  if (s.additionalProperties === true || !s.properties && s.additionalProperties !== false) return result.catchall(z.unknown());
  return result;
}
