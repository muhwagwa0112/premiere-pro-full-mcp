/**
 * Produce the exact top-level script sent to CEP's evalScript boundary.
 * ExtendScript rejects a top-level return, so every upstream-generated tool
 * script is enclosed in this one stable IIFE.
 */
export function wrapCepEvalScript(script: string): string {
  return `(function(){\n${script}\n})();`;
}
