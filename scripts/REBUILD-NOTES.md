# Rebuild notes

This directory is intentionally kept tiny. The old project generated many
catalog/registry/authorization artifacts; the rebuild does not.

## Architecture (one sentence)

MCP server runs stdio + a loopback WebSocket; the Premiere CEP extension
connects back once and evaluates every tool call in ExtendScript via
`PPMCP.dispatch`.

## Tool count

`OFFICIAL_TOOL_NAMES` = 266 (extracted from adobe-premiere-pro-mcp v1.2.0).
`EXTRA_TOOL_NAMES` = 87 project-specific tools. Total = **353**.
