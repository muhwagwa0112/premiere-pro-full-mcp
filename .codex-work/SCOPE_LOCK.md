# Scope Lock — 절대 요구사항

## 1. 사용자 요구의 핵심

`trusted_unattended` 모드에서는 Premiere 작업을 수행할 때마다 나타나는 **Premiere MCP 자체 승인 메시지 또는 Windows MessageBox가 0회**여야 한다.

이는 MessageBox를 자동 클릭하는 방식으로 달성하지 않는다. 반복 승인 경로 자체를 정책 기반 authorization으로 대체한다.

## 2. 제거 대상과 유지 대상

### 제거 대상

- `ApprovalBroker.cs`의 작업별 `MessageBox.Show(...)`
- R2/R3마다 preview → 별도 approve command → apply를 요구하는 반복 흐름
- 동일 job 안에서 작업마다 새 `approvalId`를 요구하는 구조

### 유지 대상

- 공개 배포용 `interactive` 호환 모드
- 설치·Trust Profile 등록·정책 변경 시의 명시적 사용자 동의
- Adobe Creative Cloud/Windows가 자체적으로 요구하는 설치·서명·권한 프롬프트
- 경로 정책, 릴리스 서명, HMAC, DPAPI, 번들 무결성, localhost 바인딩
- raw script, raw selector, arbitrary process, arbitrary shell 금지
- 결과 미확정 변이의 자동 재시도 금지

## 3. 비협상 보안 불변조건

1. `trusted_unattended`는 서명·DPAPI 보호된 Trust Profile과 현재 사용자 SID에 바인딩한다.
2. 허용 경로 밖 파일 작업은 자동 거부한다.
3. 삭제·덮어쓰기·외부 공유·클라우드 게시·구매는 profile capability로 별도 제어한다.
4. 변이 dispatch 후 연결이 끊기면 `OUTCOME_UNKNOWN`으로 중단한다.
5. `not_dispatched` 실패만 다른 backend로 fallback할 수 있다.
6. approval 제거를 이유로 path-policy, release verification, HMAC, process integrity를 약화하지 않는다.
7. 로그에는 prompt, raw args, token, project path, media name, 개인 식별정보를 남기지 않는다.

## 4. 구현 완료의 최소 조건

- `trusted_unattended`에서 작업별 승인창 0회
- `interactive` 모드는 기존 동작을 유지
- capability-aware routing
- planHash 및 session lease
- checkpoint/recovery
- 현재 action/backend 불일치 수정
- unit, .NET, static, package, live-plan test 통과
- README/SECURITY/LIVE-VALIDATION의 표현이 실제 지원 범위와 일치
