# Vendored upstream handlers

This directory contains the validated tool handlers from the official
[`adobe-premiere-pro-mcp`](https://github.com/AdobeDocs/adobe-premiere-pro-mcp)
v1.2.0 package (MIT licensed). They are vendored here so the MCP server runs
against a pinned, locally-verified copy — no network fetch at runtime.

## Provenance

- Source: npm package `adobe-premiere-pro-mcp` v1.2.0 (official Adobe CEP/PPRO
  MCP bridge implementation).
- License: MIT (see the project README).
- What is reused: the 266 tool name/handler tables (`tools/*.js`), the
  ExtendScript script builder (`bridge/script-builder.js`), and the command
  normalizer (`bridge/file-bridge.js`).
- What differs: the transport. Upstream talks to a local CEP WebSocket bridge
  with its own adapter; here `transport.executeScript` is backed by our
  always-on daemon (`src/bridge/ws-client.ts`), so no auth, no approval, no
  manual host launch is needed.

The `.js` files in `tools/` and `bridge/` are the compiled ES modules from the
1.2.0 tarball; adjacent `.d.ts`/`.map` files are their type/sourcemap metadata.
