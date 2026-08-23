import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repositoryRoot, "node_modules", "@adobe", "premierepro");
const outputPath = join(repositoryRoot, "generated", "adobe-uxp-api.json");
const pluginCatalogPath = join(repositoryRoot, "uxp-plugin", "api-catalog.cjs");

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile() && path.endsWith(".d.ts")) files.push(path);
  }
  return files;
}

function text(node, sourceFile) {
  return node ? node.getText(sourceFile).replace(/\s+/g, " ").trim() : "unknown";
}

function nameOf(node, sourceFile) {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return String(node.text);
  return text(node, sourceFile);
}

function parametersOf(parameters, sourceFile) {
  return parameters.map((parameter) => ({
    name: nameOf(parameter.name, sourceFile) ?? "arg",
    type: text(parameter.type, sourceFile),
    optional: Boolean(parameter.questionToken || parameter.initializer),
    rest: Boolean(parameter.dotDotDotToken),
  }));
}

function unwrapReturnType(type) {
  return type.replace(/^Promise<(.+)>$/, "$1").replace(/\s*\|\s*(null|undefined)/g, "").trim();
}

const REVIEWED_OVERRIDES = new Map(Object.entries({
  "Project.close": ["destructive", "R3", "experimental", true],
  "Project.save": ["filesystem", "R2", "filesystem", true],
  "Project.saveAs": ["filesystem", "R2", "filesystem", true],
  "ProjectStatic.createProject": ["filesystem", "R2", "filesystem", true],
  "ProjectStatic.openProject": ["filesystem", "R2", "filesystem", true],
  "Project.executeTransaction": ["edit", "R1", "edit", true],
  "Project.lockedAccess": ["read", "R0", "inspect", false],
  "ClipProjectItem.attachProxy": ["filesystem", "R2", "filesystem", true],
  "ClipProjectItem.detachProxy": ["filesystem", "R2", "filesystem", true],
  "TextSegmentsStatic.importFromJSON": ["edit", "R1", "edit", true],
  "TrackItemSelectionStatic.createEmptySelection": ["read", "R0", "inspect", false],
  "EventManagerStatic.addEventListener": ["edit", "R1", "edit", false],
  "EventManagerStatic.removeEventListener": ["edit", "R1", "edit", false],
  "EventManagerStatic.addGlobalEventListener": ["edit", "R1", "edit", false],
  "EventManagerStatic.removeGlobalEventListener": ["edit", "R1", "edit", false],
  "CloseProjectOptions.setSaveWorkspace": ["edit", "R1", "edit", true],
  "OpenProjectOptions.setShowConvertProjectDialog": ["edit", "R1", "edit", true],
  "SourceMonitorStatic.openProjectItem": ["edit", "R1", "edit", true],
  "TranscriptStatic.createImportTextSegmentsAction": ["read", "R0", "inspect", false],
  "TranscriptStatic.exportToJSON": ["read", "R0", "inspect", false],
  "TranscriptStatic.importFromJSON": ["edit", "R1", "edit", true],
  "EncoderManager.launchEncoder": ["edit", "R1", "edit", true],
  "EncoderManager.startBatchEncode": ["destructive", "R3", "experimental", true],
}));

function classify(container, memberKind, member, readonly, parameters) {
  const name = (member ?? "").toLowerCase();
  const signature = `${name} ${parameters.map((item) => `${item.name} ${item.type}`).join(" ")}`.toLowerCase();
  const reviewed = REVIEWED_OVERRIDES.get(`${container}.${member}`);
  if (reviewed) return { bucket: reviewed[0], risk: reviewed[1], authority: reviewed[2], mutates: reviewed[3], classification: "reviewed_override" };
  if (memberKind === "constructor") return { bucket: "read", risk: "R0", authority: "inspect", mutates: false, classification: "constructor_value" };
  if (memberKind === "property") return readonly
    ? { bucket: "read", risk: "R0", authority: "inspect", mutates: false, classification: "readonly_property" }
    : { bucket: "sensitive", risk: "R2", authority: "edit", mutates: true, classification: "fail_closed_writable_property" };
  if (/(publish|share|upload|purchase|overwrite|delete|removeall|clearall)/.test(name)) return { bucket: "destructive", risk: "R3", authority: "experimental", mutates: true, classification: "destructive_name" };
  if (/(export|import|openproject|openproduction|save|convert|encode|attachproxy|relink)/.test(name) || parameters.some((item) => /(path|file|folder|directory|preset|destination|output)/i.test(`${item.name} ${item.type}`))) return { bucket: "filesystem", risk: "R2", authority: "filesystem", mutates: true, classification: "filesystem_signature" };
  if (/^(get|is|has|can|find|list|query|inspect|serialize|cast|equals|contains|to[A-Z]|create.*action)/i.test(member ?? "")) return { bucket: "read", risk: "R0", authority: "inspect", mutates: false, classification: /^create.*action/i.test(member ?? "") ? "deferred_action" : "getter_name" };
  if (/^(set|add|append|insert|move|remove|clear|update|apply|execute|create|attach|detach|mute|lock|enable|disable|start|stop)/i.test(member ?? "")) return { bucket: "edit", risk: "R1", authority: "edit", mutates: true, classification: "mutation_name" };
  return { bucket: "sensitive", risk: "R2", authority: "edit", mutates: true, classification: "fail_closed_unknown" };
}

function memberEntry(container, member, sourceFile, sourceName) {
  let memberKind;
  let memberName;
  let parameters = [];
  let returnType = "unknown";
  let readonly = false;
  if (ts.isMethodSignature(member) || ts.isMethodDeclaration(member)) {
    memberKind = "method";
    memberName = nameOf(member.name, sourceFile);
    parameters = parametersOf(member.parameters, sourceFile);
    returnType = text(member.type, sourceFile);
  } else if (ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) {
    memberName = nameOf(member.name, sourceFile);
    readonly = Boolean(member.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword));
    if (member.type && ts.isFunctionTypeNode(member.type)) {
      memberKind = "method";
      parameters = parametersOf(member.type.parameters, sourceFile);
      returnType = text(member.type.type, sourceFile);
    } else {
      memberKind = "property";
      returnType = text(member.type, sourceFile);
    }
  } else if (ts.isConstructSignatureDeclaration(member) || ts.isConstructorDeclaration(member)) {
    memberKind = "constructor";
    memberName = "$new";
    parameters = parametersOf(member.parameters, sourceFile);
    returnType = text(member.type, sourceFile) === "unknown" ? container : text(member.type, sourceFile);
  } else if (ts.isCallSignatureDeclaration(member)) {
    memberKind = "constructor";
    memberName = "$call";
    parameters = parametersOf(member.parameters, sourceFile);
    returnType = text(member.type, sourceFile);
  } else {
    return null;
  }
  if (!memberName) return null;
  const classification = classify(container, memberKind, memberName, readonly, parameters);
  return {
    id: `${container}.${memberName}`,
    container,
    member: memberName,
    memberKind,
    parameters,
    returnType,
    returnTypeHint: unwrapReturnType(returnType),
    readonly,
    source: sourceName,
    ...classification,
    callbackParameters: parameters.filter((parameter) => parameter.type.includes("=>")).map((parameter) => parameter.name),
    implementationStatus: "runtime_adaptive",
    liveHostVerification: "not_run",
  };
}

function membersFromDeclaration(statement) {
  if (ts.isTypeAliasDeclaration(statement) && ts.isTypeLiteralNode(statement.type)) return statement.type.members;
  if (ts.isInterfaceDeclaration(statement) || ts.isClassDeclaration(statement)) return statement.members;
  return [];
}

const files = await walk(packageRoot);
const entries = [];
const roots = {};
for (const file of files.sort()) {
  const source = await readFile(file, "utf8");
  const sourceName = relative(packageRoot, file).replaceAll("\\", "/");
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const statement of sourceFile.statements) {
    if (ts.isModuleDeclaration(statement) && statement.name.text === "Constants" && statement.body && ts.isModuleBlock(statement.body)) {
      for (const nested of statement.body.statements) {
        if (!ts.isEnumDeclaration(nested)) continue;
        for (const enumMember of nested.members) {
          const enumName = nested.name.text;
          const valueName = nameOf(enumMember.name, sourceFile);
          if (!valueName) continue;
          entries.push({
            id: `Constants.${enumName}.${valueName}`,
            container: "Constants",
            member: `${enumName}.${valueName}`,
            memberKind: "property",
            parameters: [],
            returnType: `Constants.${enumName}`,
            returnTypeHint: `Constants.${enumName}`,
            readonly: true,
            source: sourceName,
            bucket: "read",
            risk: "R0",
            authority: "inspect",
            mutates: false,
            implementationStatus: "runtime_adaptive",
            liveHostVerification: "not_run",
          });
        }
      }
      continue;
    }
    if (!((ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name)) continue;
    const container = statement.name.text;
    const members = membersFromDeclaration(statement);
    if (container === "premierepro") {
      for (const member of members) {
        if (ts.isPropertySignature(member)) {
          const rootName = nameOf(member.name, sourceFile);
          if (rootName) roots[rootName] = text(member.type, sourceFile);
        }
      }
      continue;
    }
    for (const member of members) {
      const entry = memberEntry(container, member, sourceFile, sourceName);
      if (entry) entries.push(entry);
    }
  }
}

const uniqueEntries = [...new Map(entries.map((entry) => [entry.id, entry])).values()].sort((a, b) => a.id.localeCompare(b.id));
const reverseRoots = Object.fromEntries(Object.entries(roots).map(([root, container]) => [container, root]));
const factoryContainers = new Set(uniqueEntries.filter((entry) => entry.memberKind === "constructor").map((entry) => entry.container));
for (const entry of uniqueEntries) {
  const declaredRoot = entry.container === "Constants" ? "Constants" : reverseRoots[entry.container] ?? null;
  entry.root = declaredRoot && (!factoryContainers.has(entry.container) || entry.memberKind === "constructor") ? declaredRoot : null;
  entry.dispatchKind = entry.container === "Constants" ? "enum_constant" : entry.memberKind === "constructor" ? (entry.member === "$new" ? "constructor_new" : "constructor_call") : entry.root ? "root_member" : entry.memberKind === "property" && !entry.readonly ? "writable_property" : "instance_member";
  if (entry.callbackParameters?.length) entry.implementationStatus = "special_callback_adapter";
  if (entry.id === "Project.executeTransaction") entry.requiredOperation = "uxp.transaction.execute";
  else if (entry.id === "Project.lockedAccess") entry.requiredOperation = "uxp.locked.batch";
  else if (entry.container === "EventManagerStatic") entry.requiredOperation = entry.member.startsWith("remove") ? "uxp.events.unsubscribe" : "uxp.events.subscribe";
  else entry.requiredOperation = `uxp.${entry.bucket}`;
}
const fingerprint = createHash("sha256").update(JSON.stringify({ roots, entries: uniqueEntries })).digest("hex");
const countBy = (property, value) => uniqueEntries.filter((entry) => entry[property] === value).length;
const output = {
  schemaVersion: 2,
  source: { package: "@adobe/premierepro", version: "26.3.0", generatedFromDeclarationFiles: files.length },
  generatedAt: new Date().toISOString(),
  fingerprint,
  counts: {
    members: uniqueEntries.length,
    containers: new Set(uniqueEntries.map((entry) => entry.container)).size,
    roots: Object.keys(roots).length,
    methods: countBy("memberKind", "method"),
    properties: countBy("memberKind", "property"),
    constructors: countBy("memberKind", "constructor"),
    read: countBy("bucket", "read"),
    edit: countBy("bucket", "edit"),
    sensitive: countBy("bucket", "sensitive"),
    filesystem: countBy("bucket", "filesystem"),
    destructive: countBy("bucket", "destructive"),
  },
  roots,
  entries: uniqueEntries,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
await writeFile(pluginCatalogPath, `/* Generated by scripts/generate-adobe-inventory.mjs. */\nmodule.exports = ${JSON.stringify({ schemaVersion: output.schemaVersion, fingerprint, counts: output.counts, roots, entries: uniqueEntries })};\n`, "utf8");
process.stdout.write(`Generated ${uniqueEntries.length} callable Adobe UXP members across ${Object.keys(roots).length} roots at ${outputPath}\n`);
