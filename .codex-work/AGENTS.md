# AGENTS.md — Codex 권위 지침

## 역할

너는 `premiere-pro-full-mcp`의 구현 책임자다. 분석 보고서만 작성하지 말고 실제 코드, 테스트, 스키마, 문서, 릴리스 메타데이터를 수정한다.

## 작업 방식

1. 먼저 현재 branch, HEAD, working tree, package version을 확인한다.
2. baseline 이후 변경이 있다면 본 문서와의 충돌을 분석한다.
3. `TASK_MANIFEST.json`의 dependency graph를 따른다.
4. 각 task는 작은 commit 단위로 구현한다.
5. 공개 API와 runtime behavior를 바꾸면 테스트와 문서를 같은 commit에 포함한다.
6. 테스트 실패를 skip, 삭제, 완화하여 통과시키지 않는다.
7. host가 없는 환경에서는 live test를 `not_run`으로 명확히 남기되, plan/unit/contract test는 완료한다.
8. 실제 Premiere가 있는 환경에서는 disposable fixture에서만 변이 live test를 수행한다.

## 구현 우선순위

1. truthful capability routing
2. trusted unattended authorization
3. dispatch-state 및 safe fallback
4. checkpoint와 outcome reconciliation
5. 동적 support matrix
6. 누락된 typed action 구현
7. job engine
8. full feature registry 및 장기 기능 확장

## 금지사항

- `MessageBox` 자동 클릭, SendInput 자동 승인, UI 좌표 기반 승인 우회
- raw ExtendScript 또는 arbitrary QE path를 공개 MCP tool로 추가
- 임의 UI selector/click API 공개
- shell command 실행 기능 추가
- `OUTCOME_UNKNOWN` 자동 retry
- 테스트를 위해 위험 등급을 임의로 R0/R1로 낮추기
- 경로 allowlist를 `C:\` 전체 또는 사용자 홈 전체로 무조건 확대
- cloud credential 추출
- live validation을 수행하지 않았는데 `verified`로 표시

## 버전 목표

Foundation 변경은 `0.3.0`으로 묶는다. breaking contract는 migration note를 작성한다.

## 필수 명령

```powershell
npm ci
npm run inventory:adobe
npm run check
npm run test:coverage
dotnet test .\windows-ui-agent\tests\PremiereMcp.WindowsUiAgent.Tests.csproj --configuration Release
npm run validate:uxp-plan
```

가능한 경우:

```powershell
npm run smoke:mcp
npm run smoke:security
npm run validate:uxp-full
npm run validate:ui-live
```

## 최종 산출물

- 수정 코드
- 신규/수정 테스트
- `docs/IMPLEMENTATION_REPORT_V0.3.md`
- support matrix
- migration note
- 실제 실행하지 못한 검증 항목과 이유
- 남은 task 목록
