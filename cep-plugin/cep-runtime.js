/* Project-owned minimal adapter for the CEP-provided __adobe_cep__ runtime. */
function PremiereCepRuntime() {}

PremiereCepRuntime.prototype.evalScript = function (script, callback) {
  if (typeof __adobe_cep__ === "undefined") {
    if (callback) callback("EvalScript Error: Not in CEP environment");
    return;
  }
  __adobe_cep__.evalScript(script, callback || function () {});
};

PremiereCepRuntime.prototype.getSystemPath = function (pathType) {
  if (typeof __adobe_cep__ === "undefined") return "";
  var value = __adobe_cep__.getSystemPath(pathType);
  if (/^file:\/\/\//i.test(value)) value = value.replace(/^file:\/\/\//i, "");
  try { return decodeURI(value); } catch (_) { return value; }
};
