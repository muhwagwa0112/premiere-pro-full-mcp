import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, "")), "..");
execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve(repositoryRoot, "scripts", "Build-Release.ps1")], {
  cwd: repositoryRoot,
  stdio: "inherit",
  windowsHide: true,
});
