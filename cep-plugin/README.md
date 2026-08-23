# Typed CEP fallback

This is a local compatibility bridge for Premiere Pro 26.3. It accepts only JSON operation envelopes and dispatches
an explicit ES3 switch in `host.jsx`; it cannot execute caller-provided scripts. QE availability is reported separately
and does not make any QE mutation supported by itself.

The queue is fail-closed unless `%LOCALAPPDATA%\PremiereMCP\bin\PremiereMcp.WindowsUiAgent.exe`
accepts the direct Premiere or integrity-pinned MCP caller. The broker never exports the per-user
DPAPI HMAC key. Every heartbeat, request, and response is authenticated; requests also carry a
one-use nonce, a short expiry, a CEP-session binding, and a backend-specific operation allowlist.

Install under the per-user CEP extensions directory only for local development. Keep the existing production connector
untouched until this bridge passes a live-host test. The command directory must match `PREMIERE_MCP_CEP_DIR` when set.
