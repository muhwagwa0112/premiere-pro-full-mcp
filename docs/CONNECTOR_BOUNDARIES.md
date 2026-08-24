# Collaboration, service, plugin, and native boundaries

This repository does not currently contain typed runtime handlers for Premiere Productions, Team Projects, Frame.io, Adobe cloud services, or third-party Premiere plugins. Their public inventory therefore reports `unsupported_external` and `boundary_only`. Installing or signing in to a product does not by itself make a feature supported.

## Boundary rules

| Connector | Entitlement dependency | Plugin dependency | Current support |
|---|---|---|---|
| Productions | None declared; live Productions workspace capability still required | None | Boundary only, unsupported |
| Team Projects | Host-managed Adobe Team Projects entitlement and signed-in host state | None | Boundary only, unsupported |
| Frame.io | Frame.io subscription verified by its owning runtime | None | Boundary only, unsupported |
| Adobe services | Service-specific Creative Cloud entitlement verified by the host | None | Boundary only, unsupported |
| Third-party plugin | Plugin-defined external entitlement | Exact installed plugin and version supplied by a future connector | Boundary only, unsupported |

The MCP server has no authentication-export or secret-bearing connector request contract. Nested arguments with secret-shaped keys are rejected before dispatch. Authentication stays inside the host or service integration that owns it. A future connector reports only whether its entitlement probe succeeded; it must not return sign-in material.

Connector support requires all of the following to agree: a declared operation, a registered typed handler, a live runtime operation probe, a satisfied entitlement probe, and every required plugin/version probe. Missing or conflicting evidence fails closed before dispatch.

Mutation dispatch is attempted once. An accepted, disconnected, unknown, or completed-but-unverified mutation is not automatically retried; it must be reconciled using service- or host-owned evidence. This behavior does not add any per-operation approval dialog and therefore does not alter `trusted_unattended` approval semantics.

## Native extension boundary

Native operations use the explicit `premiere-mcp-native/1` protocol and operation IDs ending in `.v1`. `native/integrity-pins-v1.json` SHA-256-pins `native/contract-v1.json`. There is no native executable in this repository, so the current entry is deliberately `contract_only` and cannot execute.

Enabling a future native executable requires a separate exact artifact pin with `enabled` status, the matching v1 allowlist, and an exact dependent plugin declaration verified at runtime. Discovery of an executable or plugin is not authority to invoke it.

## Live validation not performed

No entitlement, cloud account, Productions workspace, Team Projects project, Frame.io account, third-party plugin, or native binary was available in the disposable Premiere fixture. Consequently, these boundaries remain unsupported rather than being promoted from static contract tests.
