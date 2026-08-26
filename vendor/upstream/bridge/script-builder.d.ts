/**
 * Builds ExtendScript strings with helper functions prepended.
 * All generated code must be ES3-compatible (var, no arrow functions, no let/const).
 */
/**
 * Build a complete ExtendScript by wrapping user code in an IIFE with helpers.
 */
export declare function buildScript(code: string): string;
/**
 * Escape a string for safe embedding in ExtendScript.
 */
export declare function escapeForExtendScript(value: string): string;
/**
 * Build a script that wraps code returning a value.
 * The code should use `return __result(...)` or `return __error(...)`.
 * @deprecated Use buildScript() directly. This is an alias kept for backward compatibility.
 */
export declare const buildToolScript: typeof buildScript;
//# sourceMappingURL=script-builder.d.ts.map