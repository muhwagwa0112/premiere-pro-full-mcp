# Codex Master Prompt

## 목표

`muhwagwa0112/premiere-pro-full-mcp`를 `v0.3.0` 기반으로 개편한다. 가장 중요한 결과는 다음 두 가지다.

1. `trusted_unattended` 모드에서 작업마다 뜨는 자체 승인 메시지를 완전히 제거한다.
2. action별 실제 backend capability를 확인한 뒤에만 dispatch하는 정확한 라우팅을 구현한다.

## 반드시 실제로 수행할 작업

### A. 현재 상태 감사

- `src/catalog.ts`, `src/operation-engine.ts`, 모든 `src/bridge/*`, `uxp-plugin/main.cjs`, `cep-plugin/host.jsx`, `windows-ui-agent/*`를 대조한다.
- 각 semantic action이 실제 어느 adapter에서 지원되는지 machine-readable matrix를 생성한다.
- action catalog와 실제 handler가 불일치하면 support를 낮추거나 handler를 구현한다.

### B. Capability-aware routing

- `BackendAdapter`에 `probe()`와 `supports(operation, context)`를 추가한다.
- UXP capability handshake, CEP heartbeat, Local operation set, UI semantic adapter registry를 통합한다.
- backend 선택은 approval/authorization 소비 이전에 완료한다.
- `not_dispatched` 실패는 다음 backend로 이동할 수 있다.
- host가 요청을 수락했거나 수락 여부가 불명확하면 절대 fallback하지 않는다.

### C. Trusted unattended authorization

- `interactive`, `trusted_unattended`, `isolated_lab` 세 모드를 정의한다.
- Trust Profile JSON schema와 DPAPI-protected store를 구현한다.
- profile은 사용자 SID, 설치 product, 최소/최대 host version, action/risk/capability, approved roots, overwrite/delete/cloud 정책에 바인딩한다.
- `trusted_unattended`에서는 개별 operation마다 `ApprovalBroker.Approve()`를 호출하지 않는다.
- 작업별 Windows MessageBox는 없어야 한다.
- profile 등록/변경/폐기는 명시적 CLI 또는 신뢰 UI에서만 수행한다.
- public release의 기본 모드는 `interactive`로 유지할 수 있지만, 사용자가 한 번 `trusted_unattended`를 등록하면 이후 편집 job 중 승인창은 0회여야 한다.

### D. PlanHash와 Session Lease

- 실행 전에 backend, host version/session, exact action, target, normalized args digest, path roots, expected state token, verifier를 포함하는 execution plan을 만든다.
- Trust Profile authorization은 이 plan에 대해 판정한다.
- 현재 integrity-pinned MCP process에만 유효한 session lease를 발급한다.
- interactive approval을 유지하는 경우에도 approval은 planHash에 바인딩한다.

### E. Checkpoint와 Recovery

- 첫 변이, 비가역 작업, 설정된 operation 간격마다 checkpoint를 만든다.
- 프로젝트 파일 backup 또는 save-copy 전략을 사용한다.
- export overwrite는 backup rename → temporary output → stable-file verification → atomic replace 순서로 처리한다.
- `OUTCOME_UNKNOWN`이면 reconciliation required 상태로 job을 멈춘다.

### F. 현재 action 불일치 수정

최소 다음을 조사하고 처리한다.

- `project.create`
- `project.open`
- `media.import`
- `timeline.sequence.create_from_media`
- `effects.catalog`
- `export.sequence`
- `captions.inspect`
- `timeline.clip.insert`
- `timeline.ripple_delete`
- `effects.apply`
- `history.undo`
- `plugin.ui.invoke`
- `cloud.status`
- `cloud.action`

구현이 없으면 `implemented_unverified`를 유지하지 않는다. `unsupported`, `ui_adapter_required`, `entitlement_blocked`, `experimental` 등 정확한 상태를 반환한다.

### G. 테스트

- connected-but-unsupported backend가 다음 adapter로 넘어가는 테스트
- approval/authorization이 route 확정 전에 소비되지 않는 테스트
- `not_dispatched`와 `accepted/unknown` 실패 구분 테스트
- trusted unattended에서 MessageBox 또는 pending approval file이 생기지 않는 테스트
- interactive mode one-shot approval 회귀 테스트
- profile tamper, SID mismatch, expired lease, path escape 테스트
- checkpoint/restore와 overwrite failure 테스트
- support matrix와 runtime handler parity 테스트

## 완료 시 보고 형식

1. 변경 파일
2. 구현 완료 task
3. 테스트 명령과 결과
4. live validation 결과 또는 미실행 사유
5. security model 변화
6. 남은 기능과 다음 phase

계획만 작성하고 멈추지 않는다. 작업 가능한 범위는 현재 세션에서 구현한다.
