# UXP bridge

Package this folder as a CCX or side-load it with Adobe UXP Developer Tool, then open **Window → UXP Plugins → Premiere Pro Full MCP**.

On first use, choose **Pair with installed helper…** and select `%LOCALAPPDATA%\PremiereMCP\app\runtime-bootstrap.json`. UXP stores only its persistent file permission token. The bootstrap secret is generated during local installation, remains protected by the current user's ACL, and is never included in this folder or the CCX.

The panel advertises only operations implemented in `main.cjs`. It never receives raw JavaScript, never embeds a session token, and never silently falls back to CEP. Results describe their readback boundary; live host tests are required before compatibility claims.
