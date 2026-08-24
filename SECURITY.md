# Security policy

Supported security fixes are published for the latest `v0.3.x` release. Report vulnerabilities privately through [GitHub Security Advisories](https://github.com/muhwagwa0112/premiere-pro-full-mcp/security/advisories/new). Do not open a public issue for an exploitable finding.

This server is local-only. Do not expose its UXP listener, CEP queue, or UI-agent pipe beyond
the current Windows user session.

- Keep UI named-pipe tokens out of source, MCP configuration arguments, logs, and support bundles.
- The UXP panel uses a one-click, protocol-v3 handshake on `127.0.0.1:17777` with no user-managed
  token or pairing UI. The panel creates a 256-bit key inside its Adobe UXP per-user data folder; the
  bridge accepts only the canonical current-user plug-in-storage path and both peers prove the key by
  HMAC over fresh nonces, catalog fingerprint, and session ID before commands are enabled. Exact Origin,
  capability/fingerprint, session/route, payload, and operation-authorization checks also remain enforced.
  This does not isolate mutually hostile processes already running as the same Windows user.
- CEP, approval, lease, and Trust Profile material is DPAPI CurrentUser-protected at rest. After full executable,
  signature, ancestry, and command-line verification, the broker releases each required key once
  into the memory of the integrity-pinned MCP entrypoint or authorized Premiere CEP renderer.
  Keys are never written to disk, configuration, logs, or support bundles; those processes already
  had authority to request arbitrary HMACs for the same key scopes.
- The native MCP launcher clears Node preload paths and pins the full installed-helper, Node, and
  Premiere executable paths and hashes. The server is bundled with all runtime dependencies into
  one pinned file; unexpected or extra files in the bundle directory fail closed.
- In `interactive` mode, an R2/R3 preview returns no executable approval token. Approval requires
  a separate interactive terminal plus a Windows warning dialog and is bound to the exact execution
  plan, route/session fingerprint, normalized request, revision, expiry, and one use. Do not automate
  or suppress this approval dialog.
- `trusted_unattended` and `isolated_lab` never call the per-operation approval broker or
  MessageBox path. They require an explicitly enrolled Trust Profile whose mode exactly matches the
  launcher mode. Missing, mismatched, tampered, expired, or out-of-host-range profiles fail closed;
  unattended launch never falls back to interactive.
- Trust Profiles bind the current Windows SID, product and native-launcher hashes, host version
  range, risk ceiling, action allow/deny lists, capability permissions, canonical approved roots,
  checkpoint policy, and operation/runtime limits. DPAPI protects the profile at rest but does not
  turn policy into a boundary against another malicious process running as the same Windows user.
- Every authorization reserves a canonical execution-plan hash under a process-scoped, signed lease.
  The bridge receives and validates the exact route/session binding, plan hash, and effective request
  digest after any safe output-path transformation. Lease expiry, process drift, route drift, or
  request drift blocks dispatch.
- The first trusted mutation and later policy-selected mutations are fenced by a checkpoint barrier.
  Only `not_dispatched` releases a reservation for safe fallback. Accepted or unknown host outcomes
  are never replayed and are persisted as reconciliation-required.
- Authorized overwrite uses a durable output-specific journal, verified original backup, temporary
  output, stable digest verification, and a no-clobber final commit. Unknown host, restore, or cleanup
  state retains quarantine across operation IDs and process restarts.
- Do not add public raw-script, raw-selector, arbitrary-process, or arbitrary-path operations.
- All user-controlled strings entering CEP must be JSON encoded and validated by the bundled
  ES3 dispatcher before touching Premiere APIs.
- Logs and ledgers may contain operation IDs, action IDs, risk classes, backend names, timestamps,
  and verification state. They must not contain prompts, arguments, results, tokens, project paths,
  media names, revision values, person data, or cloud identifiers.
- Cloud purchase, publish, sharing, deletion, overwrite, and access outside approved roots are R3.

Release updates are authenticated by a Premiere-specific RSA public key committed in the repository.
The matching private key is held only under `%LOCALAPPDATA%\PremiereMCP` with a current-user-only ACL;
it is not shared with the Photoshop project or uploaded to GitHub Actions. The signed manifest binds
the repository, tag, version, commit, asset names, sizes, SHA-256 values, platform, and architecture.
The CEP compatibility bridge is separately signed as an Adobe ZXP extension. Its signing certificate
and password remain in the same current-user-only local key store; only public signature metadata is
packaged. The installer never enables Adobe CEP developer mode.
The Windows executable and PowerShell scripts are not Authenticode-signed in v0.3.0.

The local user who explicitly enrolls a profile, the integrity of the repository used to build the
release, the authenticated release/install chain, the pinned native helper, pinned Node bundle,
Premiere, and the current Windows account are trust anchors. The MCP client is a request source, not
an authority to broaden the enrolled profile. Backend availability is not authorization, and a static
support claim is not runtime proof.

DPAPI CurrentUser does not isolate mutually hostile processes under the same account. A process that
can unwrap that user's DPAPI data, replace or inject into trusted binaries, control Premiere, or alter
the current user's files is outside this protocol boundary. Use Windows endpoint security, account
separation, ACLs, WDAC/AppLocker, or a separately administered service when that adversary is in
scope.
