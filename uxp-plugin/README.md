# UXP bridge

Side-load this folder with Adobe UXP Developer Tools and open **Window → UXP Plugins → Premiere MCP 2026**.
Set the same 24+ character token in `PREMIERE_MCP_UXP_TOKEN` and the panel. The token is session-only.

The panel advertises only operations implemented in `main.cjs`. It never receives raw JavaScript and never silently
falls back to CEP. Results describe their readback boundary; live host tests are required before compatibility claims.
