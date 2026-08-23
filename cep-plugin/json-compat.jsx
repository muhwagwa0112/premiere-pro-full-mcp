/* Project-owned ES3 JSON fallback for Adobe ExtendScript hosts without native JSON. */
if (typeof JSON !== "object") JSON = {};

(function () {
  function escapeString(value) {
    var result = '"';
    var index;
    for (index = 0; index < value.length; index += 1) {
      var character = value.charAt(index);
      var code = value.charCodeAt(index);
      if (character === '"') result += '\\"';
      else if (character === "\\") result += "\\\\";
      else if (character === "\b") result += "\\b";
      else if (character === "\f") result += "\\f";
      else if (character === "\n") result += "\\n";
      else if (character === "\r") result += "\\r";
      else if (character === "\t") result += "\\t";
      else if (code < 32) result += "\\u" + ("0000" + code.toString(16)).slice(-4);
      else result += character;
    }
    return result + '"';
  }

  function contains(stack, value) {
    var index;
    for (index = 0; index < stack.length; index += 1) if (stack[index] === value) return true;
    return false;
  }

  function encode(value, stack) {
    if (value && typeof value.toJSON === "function") value = value.toJSON();
    if (value === null) return "null";
    if (typeof value === "string") return escapeString(value);
    if (typeof value === "number") return isFinite(value) ? String(value) : "null";
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value !== "object") return undefined;
    if (contains(stack, value)) throw new TypeError("Circular JSON value");
    stack.push(value);
    var result;
    var index;
    if (Object.prototype.toString.call(value) === "[object Array]") {
      var items = [];
      for (index = 0; index < value.length; index += 1) {
        var item = encode(value[index], stack);
        items.push(item === undefined ? "null" : item);
      }
      result = "[" + items.join(",") + "]";
    } else {
      var keys = [];
      var key;
      for (key in value) if (Object.prototype.hasOwnProperty.call(value, key)) keys.push(key);
      keys.sort();
      var members = [];
      for (index = 0; index < keys.length; index += 1) {
        var member = encode(value[keys[index]], stack);
        if (member !== undefined) members.push(escapeString(keys[index]) + ":" + member);
      }
      result = "{" + members.join(",") + "}";
    }
    stack.pop();
    return result;
  }

  function Parser(text) {
    this.text = String(text);
    this.index = 0;
  }

  Parser.prototype.fail = function () { throw new SyntaxError("Invalid JSON"); };
  Parser.prototype.skip = function () {
    while (this.index < this.text.length && /[ \t\n\r]/.test(this.text.charAt(this.index))) this.index += 1;
  };
  Parser.prototype.string = function () {
    var result = "";
    this.index += 1;
    while (this.index < this.text.length) {
      var character = this.text.charAt(this.index++);
      if (character === '"') return result;
      if (character === "\\") {
        if (this.index >= this.text.length) this.fail();
        var escape = this.text.charAt(this.index++);
        if (escape === '"' || escape === "\\" || escape === "/") result += escape;
        else if (escape === "b") result += "\b";
        else if (escape === "f") result += "\f";
        else if (escape === "n") result += "\n";
        else if (escape === "r") result += "\r";
        else if (escape === "t") result += "\t";
        else if (escape === "u") {
          var hex = this.text.substr(this.index, 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail();
          result += String.fromCharCode(parseInt(hex, 16));
          this.index += 4;
        } else this.fail();
      } else {
        if (character.charCodeAt(0) < 32) this.fail();
        result += character;
      }
    }
    this.fail();
  };
  Parser.prototype.number = function () {
    var match = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(this.text.substring(this.index));
    if (!match) this.fail();
    this.index += match[0].length;
    return Number(match[0]);
  };
  Parser.prototype.array = function () {
    var result = [];
    this.index += 1;
    this.skip();
    if (this.text.charAt(this.index) === "]") { this.index += 1; return result; }
    while (true) {
      result.push(this.value());
      this.skip();
      var separator = this.text.charAt(this.index++);
      if (separator === "]") return result;
      if (separator !== ",") this.fail();
    }
  };
  Parser.prototype.object = function () {
    var result = {};
    this.index += 1;
    this.skip();
    if (this.text.charAt(this.index) === "}") { this.index += 1; return result; }
    while (true) {
      this.skip();
      if (this.text.charAt(this.index) !== '"') this.fail();
      var key = this.string();
      this.skip();
      if (this.text.charAt(this.index++) !== ":") this.fail();
      result[key] = this.value();
      this.skip();
      var separator = this.text.charAt(this.index++);
      if (separator === "}") return result;
      if (separator !== ",") this.fail();
    }
  };
  Parser.prototype.value = function () {
    this.skip();
    var character = this.text.charAt(this.index);
    if (character === '"') return this.string();
    if (character === "{") return this.object();
    if (character === "[") return this.array();
    if (character === "-" || /[0-9]/.test(character)) return this.number();
    if (this.text.substr(this.index, 4) === "true") { this.index += 4; return true; }
    if (this.text.substr(this.index, 5) === "false") { this.index += 5; return false; }
    if (this.text.substr(this.index, 4) === "null") { this.index += 4; return null; }
    this.fail();
  };

  if (typeof JSON.stringify !== "function") JSON.stringify = function (value) { return encode(value, []); };
  if (typeof JSON.parse !== "function") JSON.parse = function (text) {
    var parser = new Parser(text);
    var result = parser.value();
    parser.skip();
    if (parser.index !== parser.text.length) parser.fail();
    return result;
  };
}());
