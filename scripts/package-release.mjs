import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, "")), "..");
const ccxPath = process.env.PREMIERE_MCP_CCX_PATH?.trim();
if (!ccxPath) {
  throw new Error("PREMIERE_MCP_CCX_PATH must point to the versioned CCX produced by Adobe UXP Developer Tool.");
}
execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve(repositoryRoot, "scripts", "Build-Release.ps1"), "-CcxPath", resolve(ccxPath)], {
  cwd: repositoryRoot,
  stdio: "inherit",
  windowsHide: true,
});
