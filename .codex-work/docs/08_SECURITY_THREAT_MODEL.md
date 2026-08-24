# Security Threat Model — v0.3

## 신뢰 주체

- 현재 Windows 사용자
- integrity-pinned native launcher
- signed/verified installed bundle
- 설치된 Premiere executable
- DPAPI CurrentUser
- 등록된 Trust Profile

## 보호 대상

- 프로젝트와 미디어
- 출력 파일
- cloud publish/share 권한
- bridge tokens/HMAC keys
- feature support evidence

## 주요 위협과 통제

| 위협 | 통제 |
|---|---|
| 악성 MCP 요청 | Trust Profile action/risk/path policy |
| 승인 제거 후 무제한 변이 | plan-bound authorization + job limits |
| 경로 escape | canonical root policy + reparse rejection |
| 변이 중 disconnect | dispatch state + outcome unknown stop |
| 중복 실행 | operation ID + plan hash + ledger |
| 승인/profile 위조 | DPAPI, HMAC, SID/install binding |
| bundle 교체 | existing release integrity checks |
| cloud credential 탈취 | credential extraction 금지, service boundary |
| UI 오작동 | versioned semantic adapter + postcondition |

## 중요한 경계

같은 Windows 사용자 권한으로 실행되는 적대적 프로세스는 DPAPI CurrentUser 경계 밖의 위협이다. 필요하면 WDAC/AppLocker 또는 별도 서비스 계정으로 강화한다.
