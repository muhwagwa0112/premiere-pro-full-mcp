import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

const args = process.argv.slice(2);
const manifestIndex = args.indexOf("--manifest");
if (manifestIndex < 0 || !args[manifestIndex + 1]) throw new Error("--manifest <absolute manifest path> is required");
const manifestPath = resolve(args[manifestIndex + 1]);
if (!isAbsolute(args[manifestIndex + 1])) throw new Error("--manifest must be absolute");
const remove = args.includes("--remove");
const appData = process.env.APPDATA;
if (!appData) throw new Error("APPDATA is unavailable");
const workspacePath = join(appData, "Adobe", "Adobe UXP Developer Tool", "plugins_workspace.json");
await mkdir(dirname(workspacePath), { recursive: true });

let workspace = { version: 1, plugins: [] };
try {
  const parsed = JSON.parse(await readFile(workspacePath, "utf8"));
  if (parsed?.version !== 1 || !Array.isArray(parsed.plugins)) throw new Error("Unsupported UDT workspace schema");
  workspace = parsed;
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const key = (value) => normalize(resolve(String(value))).toLowerCase();
const targetKey = key(manifestPath);
const before = workspace.plugins.length;
workspace.plugins = workspace.plugins.filter((plugin) => !plugin?.manifestPath || key(plugin.manifestPath) !== targetKey);
if (!remove) workspace.plugins.push({ manifestPath, pluginOptions: { breakOnStart: false }, hostParam: "premierepro" });

const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
try { await copyFile(workspacePath, `${workspacePath}.backup-${stamp}`); } catch (error) { if (error?.code !== "ENOENT") throw error; }
const temporary = `${workspacePath}.${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(workspace)}\n`, "utf8");
await rename(temporary, workspacePath);
process.stdout.write(`${JSON.stringify({ ok: true, mode: remove ? "remove" : "add", workspacePath, manifestPath, previousCount: before, currentCount: workspace.plugins.length })}\n`);
