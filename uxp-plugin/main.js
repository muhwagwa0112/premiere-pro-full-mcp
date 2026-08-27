const { entrypoints } = require("uxp");

const PANEL_ID = "premiereMcp2026Panel";
let bridgeInitialized = false;
const mountedRoots = new Set();

function panelBody(rootNode) {
  if (!rootNode) return document.body;
  if (rootNode.body) return rootNode.body;
  return rootNode;
}

function mountPanel(rootNode) {
  const target = panelBody(rootNode);
  if (target) mountedRoots.add(target);
  // Premiere can evaluate a deferred script before the external CCX document
  // has finished materializing its panel markup. Resolve the node at the
  // lifecycle boundary instead of permanently caching an early null value.
  const panelContent = document.getElementById("premiere-mcp-panel");
  if (!panelContent || !target || typeof target.appendChild !== "function") return;
  if (panelContent.parentNode !== target) target.appendChild(panelContent);
  panelContent.style.display = "block";
}

function initializeBridge() {
  if (bridgeInitialized) return;
  bridgeInitialized = true;
  try {
    // Requiring main.cjs wires up the WebSocket client and auto-connects. It is
    // idempotent at the module level, so re-showing the panel never creates a
    // second socket. If a previous bridge socket was closed (e.g. daemon
    // restart), ask main.cjs to reconnect without tearing down the panel.
    const bridge = require("./main.cjs");
    if (bridge && typeof bridge.reconnect === "function") {
      // Defer the reconnect until after the panel surfaced so we don't race a
      // not-yet-mounted document. It is a no-op if a healthy socket exists.
      setTimeout(() => bridge.reconnect(), 50);
    }
  } catch (_) {
    const status = document.getElementById("status");
    if (status) {
      status.textContent = "Bridge initialization failed. Restart Premiere and run Doctor.";
      status.className = "error";
    }
  }
}

// Register before the bridge imports the Premiere API catalog. Installed CCX
// panels can receive a distinct root node, so every create/show mounts the
// static panel markup into the host-provided surface instead of assuming the
// document body is already the visible panel root.
entrypoints.setup({
  panels: {
    [PANEL_ID]: {
      create(rootNode) {
        mountPanel(rootNode);
        initializeBridge();
      },
      show(rootNode) {
        mountPanel(rootNode);
        initializeBridge();
      },
      hide() {},
      // Keep the WebSocket alive across panel hide/show. Premiere may destroy
      // the panel node, but the bridge module stays loaded; we never null the
      // socket here so a later show reconnects smoothly instead of leaking a
      // half-open handshake.
      destroy() {}
    }
  }
});
