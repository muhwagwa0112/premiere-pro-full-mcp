# Premiere Pro Full MCP v0.3.0

[English](#english) · [한국어](#한국어)

<p align="center">
  <strong>If Premiere Pro Full MCP saved you time, please consider supporting its continued development, testing, and security maintenance.</strong>
</p>

<p align="center">
  <a href="https://ko-fi.com/muhwagwa0112">
    <img src="docs/assets/kofi-support-red.png"
         alt="Support Muhwagwa0112 on Ko-fi"
         width="420">
  </a>
</p>

Premiere Pro Full MCP is a local, capability-gated MCP server for Adobe Premiere Pro 2026 on Windows. It combines the documented Premiere UXP API, a constrained CEP/ExtendScript bridge, experimental QE discovery, and a fail-closed native Windows UI agent.

> This is an unofficial community project and is not affiliated with or endorsed by Adobe Inc. “Full” means the supported API surface is inventoried and routed; it does not mean every UI feature is scriptable in every host state.

The v0.3 release adds durable `premiere_jobs` DAG execution, route-bound project checkpoints,
typed semantic project/media/timeline actions, fixed-fingerprint UI adapters, a 150-entry feature
registry, and explicit connector/native extension boundaries. Runtime evidence remains authoritative:
catalog entries marked unverified, plan-only, entitlement-dependent, or unsupported are never
promoted merely because they are inventoried. See the [v0.3 release notes](docs/RELEASE-NOTES-v0.3.0.md).

## English

### Quick start for Windows

Requirements: Windows 10/11 x64, Premiere Pro 26.3 or later, Creative Cloud Desktop, and Codex Desktop or the Codex CLI. Node.js is not required for the packaged runtime.

1. Download `premiere-pro-full-mcp-v0.3.0-windows.zip` from the [latest release](https://github.com/muhwagwa0112/premiere-pro-full-mcp/releases/latest). Verify its adjacent `.sha256` file, then extract it.
2. Close Premiere Pro, open PowerShell in the extracted `premiere-pro-full-mcp-0.3.0` folder, and choose the automation mode explicitly. The safe default is interactive:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1 -AutomationMode Interactive
   ```

   The installer verifies every packaged file, installs only in the current user profile, registers `premiere_pro_full_mcp` with Codex, and opens the bundled CCX.
3. Approve the independent-plugin warning in Creative Cloud Desktop. Restart Premiere, then open **Window > UXP Plugins > Premiere Pro Full MCP**.
4. On first use, click **Pair with installed helper…** and select `%LOCALAPPDATA%\PremiereMCP\app\runtime-bootstrap.json`. UXP remembers only the file permission; the session token is not stored in the CCX.
5. Restart Codex and call the host/capability inspection tools. Run Doctor if the bridge is not connected:

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\PremiereMCP\app\tools\Doctor.ps1" -CheckLive
   ```

#### Trusted unattended enrollment

`trusted_unattended` removes per-operation approval dialogs only for actions already allowed by a locally enrolled Trust Profile. Enrollment is an explicit install-time act:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1 `
  -AutomationMode TrustedUnattended `
  -TrustProfilePath .\studio-profile.json
```

The native broker validates the profile, binds it to the current Windows SID, installed product/launcher hashes, host-version range, allowed actions/risks/capabilities, and canonical approved roots, then protects it with DPAPI CurrentUser. The launcher passes only the selected mode and profile ID to the pinned MCP process. A mismatched, missing, tampered, expired, or out-of-range profile fails closed; it never falls back to interactive or broadens policy. `IsolatedLab` uses the same explicit enrollment contract with a profile whose mode is `isolated_lab`.

During `trusted_unattended` and `isolated_lab` execution, the approval broker and MessageBox path are unreachable and no pending/approved approval files are created. Interactive mode retains the exact-plan, one-shot R2/R3 approval dialog. Changing modes requires rerunning the installer with the intended mode and profile.

The executables and PowerShell scripts are not Authenticode-signed. Windows may show SmartScreen warnings. The release uses a separate RSA-signed update manifest, exact asset size/SHA-256 bindings, and an in-package SHA-256 manifest. The bundled CEP compatibility bridge carries an Adobe ZXP package signature, so installation does not enable CEP developer mode. The initial download still depends on GitHub HTTPS and the published checksum; do not bypass a warning if the checksum or source is unexpected.

### Update and uninstall

```powershell
# Download and install the newest authenticated GitHub release
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\PremiereMCP\app\tools\Update.ps1"

# Recoverable removal; pairing/workspace data is preserved
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\PremiereMCP\app\tools\Uninstall.ps1"
```

Updates reject signature, repository, tag, name, size, digest, prerelease, and downgrade mismatches. Remove the CCX separately in Creative Cloud Desktop > Plugins > Manage Plugins.

### Safety and capability contract

- Documented UXP is preferred. CEP fills typed compatibility gaps, QE is experimental, and Windows UI Automation is the last resort.
- Only an explicit `not_dispatched` result may route to another supported backend. Accepted, completed, and unknown outcomes are never replayed automatically.
- The first trusted mutation, configured intervals, and non-undoable mutations require a verified project checkpoint. Unknown checkpoint or mutation outcomes persist as `reconciliation_required` and quarantine later mutations across restarts.
- An authorized sequence overwrite moves the original to a verified backup, renders to an operation-scoped temporary file, verifies a stable non-empty digest, and commits without replacing an existing path. Any unproven restore or commit keeps a durable, output-specific reconciliation journal and blocks a new operation ID from reusing that target.
- Interactive R2/R3 operations use short-lived, scope-bound, single-use exact-plan approvals and an independent trusted Windows dialog. Enrolled unattended modes use Trust Profile authorization and never invoke that dialog.
- Raw ExtendScript, arbitrary QE/object paths, raw UI selectors/clicks, shell commands, and credential extraction are not public MCP operations.
- Listeners bind to localhost, CEP envelopes are HMAC authenticated through a DPAPI CurrentUser broker, and release artifacts never contain runtime bootstrap material.
- Filesystem work is confined to explicitly approved canonical roots and rejects reparse-point escapes.
- No telemetry is collected. Logs and ledgers exclude prompts, arguments, results, tokens, project paths, media names, and personal identifiers.

The generated Adobe 26.3 inventory contains 69 roots and 761 callable members. The final live full-surface baseline matched all 761 IDs. Of 312 deterministic read-only calls attempted, 281 succeeded and 31 failed closed because the required method, root, or session handle was unavailable. Another 151 risk-bearing entries were preview-only and 298 context-dependent entries were skipped with explicit reasons. See [live validation](docs/LIVE-VALIDATION.md).

The generated capability artifacts additionally contain 51 public semantic actions across five
backend columns and 150 broader post-production/collaboration/native feature records. Compound work
is planned through `premiere_jobs`; the implemented-unverified inspection/delivery workflow places
verified durable checkpoints before and after export. See the [feature matrix](docs/FEATURE_MATRIX.md),
[semantic action contract](docs/CORE_SEMANTIC_ACTIONS.md), and
[post-production program](docs/POST_PRODUCTION_PROGRAM.md).

### Development

Requirements: Node.js 20.19+ (Node 24 preferred), .NET 8 SDK, Premiere Pro 26.3+, and Adobe UXP Developer Tool.

```powershell
npm ci
npm run inventory:adobe
npm run check
npm run test:coverage
dotnet test .\windows-ui-agent\tests\PremiereMcp.WindowsUiAgent.Tests.csproj --configuration Release
npm run validate:uxp-plan
```

Release builds require a clean Git worktree and the dedicated private signing key under `%LOCALAPPDATA%\PremiereMCP`. The private key is never committed or uploaded to GitHub Actions. See [deployment](docs/DEPLOYMENT.md), [security](SECURITY.md), and [contributing](CONTRIBUTING.md).

## 한국어

### Windows 빠른 설치

요구 사항은 Windows 10/11 x64, Premiere Pro 26.3 이상, Creative Cloud Desktop, Codex Desktop 또는 Codex CLI입니다. 배포 ZIP에는 자체 포함 네이티브 런처와 번들 MCP가 들어 있어 별도 Node.js 설치가 필요하지 않습니다.

1. [최신 릴리스](https://github.com/muhwagwa0112/premiere-pro-full-mcp/releases/latest)에서 `premiere-pro-full-mcp-v0.3.0-windows.zip`과 `.sha256`을 내려받아 해시를 확인하고 압축을 풉니다.
2. Premiere Pro를 종료하고 압축을 푼 폴더에서 자동화 모드를 명시해 실행합니다. 안전한 기본값은 Interactive입니다.

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1 -AutomationMode Interactive
   ```

3. Creative Cloud Desktop에서 독립 플러그인 설치 경고를 승인합니다. Premiere를 재시작한 뒤 **창 > UXP 플러그인 > Premiere Pro Full MCP**를 엽니다.
4. 첫 실행 때 **Pair with installed helper…**를 누르고 `%LOCALAPPDATA%\PremiereMCP\app\runtime-bootstrap.json`을 선택합니다. CCX에는 세션 토큰이 포함되지 않습니다.
5. Codex를 재시작합니다. 연결되지 않으면 다음 Doctor를 실행합니다.

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\PremiereMCP\app\tools\Doctor.ps1" -CheckLive
   ```

설치기는 패키지 전 파일의 해시를 검증하고 현재 사용자 영역만 변경하며, 기존 설치와 Codex 설정을 실패 시 복원합니다. CCX 설치를 나중에 하려면 `-SkipCcxLaunch`, Codex 등록을 생략하려면 `-SkipCodexRegistration`을 사용합니다.

`trusted_unattended`는 설치 시 명시적으로 Trust Profile을 등록한 경우에만 사용할 수 있습니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1 `
  -AutomationMode TrustedUnattended `
  -TrustProfilePath .\studio-profile.json
```

프로필은 현재 Windows SID, 설치 제품과 런처 해시, Premiere 버전 범위, action/risk/capability, canonical approved roots에 결합되고 DPAPI CurrentUser로 보호됩니다. 신뢰 실행 중에는 작업별 MessageBox와 approval 파일이 0개이며, 허용 범위 밖 요청·변조·버전 불일치는 자동으로 interactive로 낮아지지 않고 차단됩니다. Interactive의 R2/R3 exact-plan 1회 승인은 그대로 유지됩니다.

v0.3 최신본에는 durable `premiere_jobs` DAG, 전·후 프로젝트 체크포인트 증거,
프로젝트/미디어/타임라인 semantic action, 고정 fingerprint UI adapter, 150개 기능 레지스트리가
포함됩니다. 목록에 존재한다는 이유만으로 지원 상태를 올리지 않으며, 실호스트 증거가 없는 기능은
`UNVERIFIED`, `PLAN_ONLY`, `ENTITLEMENT_BLOCKED`, `UNSUPPORTED` 상태를 유지합니다.

CEP 호환 브리지는 Adobe ZXP 방식으로 별도 서명되어 있으며, 설치기는 CEP 개발자 모드를 활성화하지 않습니다. EXE와 PowerShell 스크립트에는 Authenticode 서명이 없으므로 게시된 SHA-256과 RSA 릴리스 서명을 확인해야 합니다.

### 보안 및 지원 범위

이 프로젝트는 “Premiere의 모든 기능이 모든 상황에서 무조건 성공한다”고 주장하지 않습니다. 공개 API 표면 전체를 목록화하고, 라이브 검증된 경로만 지원으로 표시하며, 프로젝트 상태·미디어·플러그인·로그인·권한이 필요한 경로는 명확하게 실패하거나 보류합니다. UXP·CEP·QE·UI 자동화의 검증 범위는 각각 분리해 보고합니다.

취약점은 공개 이슈가 아니라 저장소 **Security > Report a vulnerability**에서 비공개로 신고해 주세요. 토큰, 실제 프로젝트, 사용자 경로, 미디어 이름은 이슈나 로그에 첨부하지 마세요.

## Support

If Premiere Pro Full MCP saves you time, you can support continued development, host-version testing, and security maintenance on [Ko-fi](https://ko-fi.com/muhwagwa0112).

MIT License. Copyright (c) 2026 muhwagwa0112.
