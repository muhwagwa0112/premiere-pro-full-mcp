# UXP bridge

Package this folder as a CCX or side-load it with Adobe UXP Developer Tools, then open **Window → UXP Plugins → Premiere Pro Full MCP**.
Set the same 24+ character token in `PREMIERE_MCP_UXP_TOKEN` and the panel. The token is session-only.

The panel advertises only operations implemented in `main.cjs`. It never receives raw JavaScript and never silently
falls back to CEP. Results describe their readback boundary; live host tests are required before compatibility claims.
