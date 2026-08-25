import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("release packaging contract", () => {
  test("publishes the package version consistently across package and Adobe manifests", () => {
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as { version: string };
    const packageLock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8")) as { version: string; packages: Record<string, { version?: string }> };
    const uxpManifest = JSON.parse(readFileSync(resolve(root, "uxp-plugin", "manifest.json"), "utf8")) as { version: string };
    const cepManifest = readFileSync(resolve(root, "cep-plugin", "CSXS", "manifest.xml"), "utf8");
    // package.json is the single version source; every artifact must match it.
    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages[""]?.version).toBe(packageJson.version);
    expect(uxpManifest.version).toBe(packageJson.version);
    expect(cepManifest).toContain(`ExtensionBundleVersion="${packageJson.version}"`);
    expect(cepManifest).toContain(`Version="${packageJson.version}"/>`);
  });

  test("requires an explicit Adobe UDT CCX before checking the worktree", () => {
    const script = readFileSync(resolve(root, "scripts", "Build-Release.ps1"), "utf8");
    const requiredCheck = script.indexOf("A CCX packaged by Adobe UXP Developer Tool is required");
    const dirtyCheck = script.indexOf("status --porcelain");
    expect(requiredCheck).toBeGreaterThan(0);
    expect(requiredCheck).toBeLessThan(dirtyCheck);
    expect(script).not.toContain("scripts\\Build-Ccx.ps1");
  });

  test("creates and verifies the CEP signature during the clean release build", () => {
    const script = readFileSync(resolve(root, "scripts", "Build-Release.ps1"), "utf8");
    expect(script).toContain("ZXPSignCmd 4.1.103 is required");
    expect(script).toContain("$expectedZxpSignCmdSha256");
    expect(script).toContain("-sign $cepSigningSource $cepZxpPath");
    expect(script).toContain("-verify $signedCepRoot");
    expect(existsSync(resolve(root, "cep-plugin", "META-INF", "signatures.xml"))).toBe(false);
    expect(existsSync(resolve(root, "cep-plugin", "mimetype"))).toBe(false);
  });

  test("development archive cannot be emitted as a CCX", () => {
    const script = readFileSync(resolve(root, "scripts", "Build-Ccx.ps1"), "utf8");
    expect(script).toContain("uxp-dev-archive.zip");
    expect(script).toContain("Only Adobe UXP Developer Tool may produce a release .ccx");
    expect(script).not.toContain("Move-Item -LiteralPath $zipPath");
  });

  test("npm exposes the archive only as a development command", () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    expect(pkg.scripts["uxp:dev-archive"]).toBeTruthy();
    expect(pkg.scripts["uxp:package"]).toBeUndefined();
    expect(pkg.private).toBe(true);
  });

  test("hash verification works in Windows PowerShell without Get-FileHash autoloading", () => {
    const common = resolve(root, "scripts", "install", "Common.ps1");
    const target = resolve(root, "LICENSE");
    const expected = createHash("sha256").update(readFileSync(target)).digest("hex");
    const command = [
      "$PSModuleAutoLoadingPreference = 'None'",
      `. '${common.replaceAll("'", "''")}'`,
      `Get-PpMcpSha256 -Path '${target.replaceAll("'", "''")}'`,
    ].join("; ");
    const actual = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      { encoding: "utf8" },
    ).trim();
    expect(actual).toBe(expected);
  }, 15_000);

  test("installer exposes and persists the explicit automation boundary", () => {
    const install = readFileSync(resolve(root, "scripts", "install", "Install.ps1"), "utf8");
    expect(install).toContain("[ValidateSet('interactive', 'trusted_unattended', 'TrustedUnattended', 'isolated_lab', 'IsolatedLab')][string]$AutomationMode = 'interactive'");
    expect(install).toContain("$AutomationMode = Resolve-PpMcpAutomationMode");
    expect(install).toContain("automationMode = $AutomationMode");
    expect(install).toContain("trustProfileId = $(if ($TrustProfileId)");
    expect(install).toContain("@('--trust-profile', 'enroll', $trustEnrollment.path)");
    expect(install).toContain("The launcher identity changed; unattended mode requires -TrustProfilePath");
    expect(install).toContain("secrets\\uxp-bridge-token.dpapi");
    expect(install).toContain("app\\runtime-bootstrap.json");
    expect(install).toContain("@('--uxp-auth', 'provision')");
  });

  test("Doctor diagnoses the token-free UXP listener and panel session", () => {
    const doctor = readFileSync(resolve(root, "scripts", "install", "Doctor.ps1"), "utf8");
    expect(doctor).toContain("Add-Check 'uxp-listener'");
    expect(doctor).toContain("Add-Check 'uxp-panel-session'");
    expect(doctor).toContain("Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort $uxpPort");
    expect(doctor).toContain("$env:PREMIERE_MCP_UXP_PORT");
  });

  test("Doctor accepts the plugin-marketplace registration name as well as the installer name", () => {
    const doctor = readFileSync(resolve(root, "scripts", "install", "Doctor.ps1"), "utf8");
    // Both the underscore installer registration and the hyphen plugin-marketplace
    // registration must be probed, and a failed probe must not surface as output.
    expect(doctor).toContain('$acceptedNames = @($script:PpMcpRegistration, $script:PpMcpProduct)');
    expect(doctor).toContain('Read-PpMcpCodexRegistration $candidate');
    expect(doctor).toContain("Add-Check 'codex-registration'");
    expect(doctor).toContain("return $null");
  });

  test("multiple MCP instances share the single UXP listener instead of dying at boot", () => {
    const entry = readFileSync(resolve(root, "src", "index.ts"), "utf8");
    const bridge = readFileSync(resolve(root, "src", "bridge", "uxp-websocket.ts"), "utf8");
    // A second instance must not crash when the UXP bridge port is already owned
    // by another instance. Instead of degrading to a local-only backend, the new
    // instance joins the leader as a relay and shares its live panel session.
    expect(entry).toContain("await uxp.start()");
    expect(entry).toContain("that leader as a relay and shares its live panel session");
    expect(bridge).toContain("connectAsFollower");
    expect(bridge).toContain('role: "relay"');
    expect(bridge).toContain('"peer-accepted"');
    expect(bridge).toContain("broadcastPeerUpdate");
  });

  test("plugin-marketplace MCP server name matches the installer registration", () => {
    // The Codex connector (.mcp.json) and the installer (Common.ps1) must both
    // register the bridge under the same server name so a fresh Codex thread
    // discovers the exact same tools as the installed Doctor path.
    const mcpJson = JSON.parse(readFileSync(resolve(root, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command: string }>;
    };
    const common = readFileSync(resolve(root, "scripts", "install", "Common.ps1"), "utf8");
    const registration = common.match(/\$script:PpMcpRegistration = '([^']+)'/)?.[1];
    expect(registration).toBeTruthy();
    if (!registration) throw new Error("Common.ps1 lacks a PpMcpRegistration constant");
    expect(Object.keys(mcpJson.mcpServers)).toEqual([registration]);
    const entry = mcpJson.mcpServers[registration];
    if (!entry) throw new Error(`MCP server ${registration} is missing from .mcp.json`);
    expect(entry.command).toContain("PremiereMcp.WindowsUiAgent.exe");
    expect(JSON.stringify(entry)).toContain("--launch-mcp");
  });

  test("trust profile enrollment validates exact mode and profile ID before installation", () => {
    const directory = mkdtempSync(join(tmpdir(), "ppmcp-installer-profile-"));
    const profilePath = join(directory, "profile.json");
    writeFileSync(profilePath, JSON.stringify({ schemaVersion: 1, profileId: "studio-profile", mode: "trusted_unattended" }));
    const common = resolve(root, "scripts", "install", "Common.ps1");
    const command = [
      `. '${common.replaceAll("'", "''")}'`,
      `$profile = Read-PpMcpTrustProfileEnrollment -TrustProfilePath '${profilePath.replaceAll("'", "''")}' -AutomationMode trusted_unattended`,
      `if ($profile.profileId -cne 'studio-profile') { throw 'profile ID mismatch' }`,
      `try { Read-PpMcpTrustProfileEnrollment -TrustProfilePath '${profilePath.replaceAll("'", "''")}' -AutomationMode isolated_lab | Out-Null; exit 7 } catch { exit 0 }`,
    ].join("; ");
    expect(() => execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command])).not.toThrow();
  });

  test("Codex registration propagates mode and profile without changing the broker CLI", () => {
    const common = readFileSync(resolve(root, "scripts", "install", "Common.ps1"), "utf8");
    expect(common).toContain('"PREMIERE_MCP_AUTOMATION_MODE=$AutomationMode"');
    expect(common).toContain('"PREMIERE_MCP_TRUST_PROFILE_ID=$TrustProfileId"');
    expect(common).toContain("$arguments += @($script:PpMcpRegistration, '--', $Launcher, '--launch-mcp', $Bundle)");
  });

  test("Codex registration emits the unattended environment and exact launcher command", () => {
    const directory = mkdtempSync(join(tmpdir(), "ppmcp-codex-registration-"));
    const shim = join(directory, "codex.cmd");
    const log = join(directory, "codex.log");
    writeFileSync(shim, '@echo off\r\nif "%2"=="get" exit /b 1\r\necho %*>> "%PPMCP_CODEX_LOG%"\r\nexit /b 0\r\n');
    const common = resolve(root, "scripts", "install", "Common.ps1");
    const command = [
      `$env:PATH = '${directory.replaceAll("'", "''")};' + $env:PATH`,
      `$env:CODEX_HOME = '${directory.replaceAll("'", "''")}'`,
      `$env:PPMCP_CODEX_LOG = '${log.replaceAll("'", "''")}'`,
      `. '${common.replaceAll("'", "''")}'`,
      `Set-PpMcpCodexRegistration -Launcher 'C:\\PremiereMCP\\bin\\agent.exe' -Bundle 'C:\\PremiereMCP\\bundle\\server.mjs' -InstallRoot 'C:\\PremiereMCP' -AutomationMode trusted_unattended -TrustProfileId studio-profile`,
    ].join("; ");
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command]);
    const invocation = readFileSync(log, "utf8");
    expect(invocation).toContain("--env PREMIERE_MCP_AUTOMATION_MODE=trusted_unattended");
    expect(invocation).toContain("--env PREMIERE_MCP_TRUST_PROFILE_ID=studio-profile");
    expect(invocation).toContain("premiere_pro_full_mcp -- C:\\PremiereMCP\\bin\\agent.exe --launch-mcp C:\\PremiereMCP\\bundle\\server.mjs");
  });

  test("updater preserves installed automation mode and profile by default", () => {
    const update = readFileSync(resolve(root, "scripts", "install", "Update.ps1"), "utf8");
    expect(update).toContain("$current.automationMode");
    expect(update).toContain("$current.trustProfileId");
    expect(update).toContain("'-AutomationMode', $selectedMode");
    expect(update).toContain("@('-TrustProfileId', $selectedProfileId)");
  });
});
