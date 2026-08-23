import { readFile } from "node:fs/promises";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

describe("CEP bridge vendored-code boundary", () => {
  it("uses the project-owned minimal CEP runtime adapter", async () => {
    const html = await readFile(join(process.cwd(), "cep-plugin", "index.html"), "utf8");
    const runtime = await readFile(join(process.cwd(), "cep-plugin", "cep-runtime.js"), "utf8");
    expect(html).toContain('src="cep-runtime.js"');
    expect(html).not.toContain("CSInterface.js");
    expect(runtime).toContain("function PremiereCepRuntime()");
    expect(runtime).not.toMatch(/ADOBE SYSTEMS INCORPORATED|prior written permission/i);
  });

  it("round-trips the project-owned ES3 JSON fallback without eval", async () => {
    const source = await readFile(join(process.cwd(), "cep-plugin", "json-compat.jsx"), "utf8");
    expect(source).not.toMatch(/\beval\s*\(/);
    const context = vm.createContext({ JSON: undefined });
    vm.runInContext(source, context, { filename: "json-compat.jsx" });
    const codec = context.JSON as { stringify(value: unknown): string; parse(value: string): Record<string, unknown> };
    const encoded = codec.stringify({ z: "line\n", a: [true, null, 3.5] });
    expect(encoded).toBe('{"a":[true,null,3.5],"z":"line\\n"}');
    const decoded = codec.parse(encoded) as { a: unknown[]; z: string };
    expect(decoded.a[0]).toBe(true);
    expect(decoded.a[1]).toBeNull();
    expect(decoded.a[2]).toBe(3.5);
    expect(decoded.z).toBe("line\n");
    expect(() => codec.parse('{"a":1} trailing')).toThrow(/Invalid JSON/);
    expect(() => codec.parse('{"__proto__":{"polluted":true}}')).toThrow(/Invalid JSON/);
    expect(() => codec.parse('{"constructor":{"prototype":{"polluted":true}}}')).toThrow(/Invalid JSON/);
  });
});
