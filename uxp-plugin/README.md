# UXP bridge

Package this folder as a CCX or side-load it with Adobe UXP Developer Tool, then open **Window → UXP Plugins → Premiere Pro Full MCP**.

The panel connects automatically to the installed localhost bridge on port 17777; **Connect** retries it with one click. No token entry, file picker, or pairing bootstrap is used. A per-user key created inside Adobe UXP plug-in storage performs automatic mutual HMAC authentication.

The panel advertises only operations implemented in `main.cjs`. It never receives raw JavaScript and never silently falls back to CEP. The authenticated localhost handshake is not a boundary against a malicious process already running as the same Windows user; all mutation approvals and Trust Profile policy remain outside the panel. Results describe their readback boundary, and live host tests are required before compatibility claims.
