# 파일 변경 지도

| 영역 | 변경 목적 |
|---|---|
| `src/contracts.ts` | probe/support/dispatch/auth/job 계약 |
| `src/operation-engine.ts` | route 확정 → authorize → checkpoint → dispatch 순서 |
| `src/catalog.ts` | registry 기반 generated catalog로 전환 |
| `src/security/confirmation.ts` | interactive compatibility 전용 |
| `src/security/authorization-*` | policy evaluator와 plan authorization |
| `src/security/trust-profile-*` | profile store/schema/migration |
| `src/security/session-lease-*` | process-scoped lease |
| `src/routing/*` | capability resolver와 route policy |
| `src/state/*` | project/sequence/track/clip/component token |
| `src/workflows/*` | job/checkpoint/reconciliation |
| `src/verifiers/*` | feature별 postcondition |
| `src/evidence/*` | privacy-safe evidence ledger |
| `src/bridge/uxp-websocket.ts` | capability probe, dispatch state, progress |
| `src/bridge/cep-file.ts` | operation capabilities와 dispatch receipt |
| `src/bridge/local-adapter.ts` | 명시 operation set |
| `src/bridge/ui-named-pipe.ts` | versioned semantic adapters |
| `uxp-plugin/main.cjs` | typed semantic handlers와 receipts |
| `cep-plugin/host.jsx` | legacy/QE typed wrappers |
| `windows-ui-agent/ApprovalBroker.cs` | per-operation MessageBox 제거 |
| `windows-ui-agent/McpLauncher.cs` | profile/lease 전달 |
| `windows-ui-agent/PremiereAutomation.cs` | targeted UI adapter |
| `scripts/install/*` | automation mode enrollment |
| `tests/*` | 모든 신규 invariant |
| `docs/*` | 정확한 지원/보안/검증 경계 |
