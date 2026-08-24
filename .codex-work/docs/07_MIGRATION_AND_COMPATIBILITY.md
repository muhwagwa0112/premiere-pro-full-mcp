# Migration and Compatibility

## v0.2 → v0.3

### 유지

- 기존 `interactive` approval flow
- 기존 MCP tool names
- 기존 action request의 `approvalId` 필드

### 추가

- `PREMIERE_MCP_AUTOMATION_MODE`
- Trust Profile store
- planHash/session lease
- action별 runtime support
- dispatch state
- checkpoint/reconciliation

### deprecated

- unattended 환경에서 직접 `ApprovalBroker.Approve()` 호출
- 정적 `implemented_unverified`만으로 지원을 주장하는 방식
- availability-only backend selection

## Installer UX

권장:

```powershell
.\Install.ps1 -AutomationMode Interactive
.\Install.ps1 -AutomationMode TrustedUnattended -TrustProfilePath .\studio-profile.json
```

TrustedUnattended 설치 후에는 Premiere 편집 job 중 추가 승인 메시지가 뜨지 않는다.

## Host version

각 feature는 `minimumPremiereVersion`, 선택적 `maximumPremiereVersion`, capability fingerprint를 가진다. API 계약 변경이 감지되면 verified 상태를 자동으로 `UNVERIFIED_HOST_VERSION`으로 낮춘다.
