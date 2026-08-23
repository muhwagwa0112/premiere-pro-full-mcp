# Security policy

This server is local-only. Do not expose its UXP listener, CEP queue, or UI-agent pipe beyond
the current Windows user session.

- Keep UXP and UI tokens out of source, MCP configuration arguments, logs, and support bundles.
- CEP and approval HMAC keys are created and used only inside the bundled DPAPI CurrentUser
  broker. Raw keys are never exported. HMAC calls are restricted to the integrity-pinned MCP
  entrypoint or a direct Adobe Premiere Pro parent process.
- The native MCP launcher clears Node preload paths and pins the full installed-helper, Node, and
  Premiere executable paths and hashes. The server is bundled with all runtime dependencies into
  one pinned file; unexpected or extra files in the bundle directory fail closed.
- R2/R3 preview returns no executable approval token. Approval requires a separate interactive
  terminal plus a Windows warning dialog, and is bound to the exact action, arguments, target,
  revision, expiry, and one use. Do not automate or suppress this approval dialog.
- Do not add public raw-script, raw-selector, arbitrary-process, or arbitrary-path operations.
- All user-controlled strings entering CEP must be JSON encoded and validated by the bundled
  ES3 dispatcher before touching Premiere APIs.
- Logs and ledgers may contain operation IDs, action IDs, risk classes, backend names, timestamps,
  and verification state. They must not contain prompts, arguments, results, tokens, project paths,
  media names, revision values, person data, or cloud identifiers.
- Cloud purchase, publish, sharing, deletion, overwrite, and access outside approved roots are R3.

Report vulnerabilities through the repository's **Security** tab using **Report a vulnerability**
(GitHub Security Advisories) after the public remote is created. If that private channel is not
enabled, contact the repository owner privately before disclosing details; do not open a public
issue containing exploit details, real projects, paths, or tokens.

All processes running as the current Windows user, plus the integrity of the repository used to build
the release, the installed helper, Premiere, and Node, are trust anchors. DPAPI CurrentUser does not isolate mutually hostile
processes under that same account. A process that can unwrap that user's DPAPI data, replace files,
or inject code is outside this MCP protocol boundary and must be handled by Windows endpoint
security, account separation, file ACLs, WDAC/AppLocker, or a separately administered service.
