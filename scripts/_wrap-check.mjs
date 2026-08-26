const wrapped = "(function(){\n(function(){ return \"PONG_TRIVIAL\"; })();\n})();";
console.log("---string---");
console.log(wrapped);
try {
  // eslint-disable-next-line no-new-func
  const f = new Function(wrapped);
  const r = f();
  console.log("---result---");
  console.log("typeof:", typeof r, "value:", JSON.stringify(r));
} catch (e) {
  console.log("parse/run error:", e.message);
}

// Now test the real upstream shape: script is `return (function(){...})();` and we wrap it.
const inner = "return (function(){ return \"REAL_SHAPE\"; })();";
const wrapped2 = `(function(){\n${inner}\n})();`;
console.log("---string2---");
console.log(wrapped2);
try {
  // eslint-disable-next-line no-new-func
  const f2 = new Function(wrapped2);
  const r2 = f2();
  console.log("---result2---");
  console.log("typeof:", typeof r2, "value:", JSON.stringify(r2));
} catch (e) {
  console.log("parse/run error2:", e.message);
}

// eval() reproduces how CEP's evalScript treats the LAST expression's value.
try {
  const ev = eval("(function(){\n" + inner + "\n})();");
  console.log("---eval result2---");
  console.log("typeof:", typeof ev, "value:", JSON.stringify(ev));
} catch (e) {
  console.log("eval error2:", e.message);
}
