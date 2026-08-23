const { entrypoints } = require("uxp");

const PANEL_ID = "premiereMcp2026Panel";
let bridgeInitialized = false;

function panelBody(rootNode) {
  if (!rootNode) return document.body;
  if (rootNode.body) return rootNode.body;
  return rootNode;
}

function mountPanel(rootNode) {
  const target = panelBody(rootNode);
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
    require("./main.cjs");
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
      destroy() {}
    }
  }
});
