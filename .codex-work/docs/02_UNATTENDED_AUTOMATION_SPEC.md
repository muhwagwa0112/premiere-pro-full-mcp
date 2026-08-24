# Trusted Unattended Automation Specification

## 모드

### interactive

현재 one-shot approval 모델의 하위 호환 모드다.

### trusted_unattended

등록된 Trust Profile 범위에서 개별 작업 승인 없이 실행한다. 작업 중 MessageBox 또는 approval command는 없다.

### isolated_lab

지정된 disposable project와 workspace 안에서 더 넓은 실험 기능을 허용한다.

## Trust Profile 저장

- Windows DPAPI CurrentUser 보호
- ACL은 현재 사용자 전용
- 사용자 SID, product ID, install root digest, launcher digest에 바인딩
- schema version과 migration 지원
- profile 변경은 감사 이벤트 기록

## 정책 요소

- action allow/deny
- risk ceiling
- approved filesystem roots
- overwrite/delete 허용
- cloud publish/share/purchase 허용
- third-party plugin UI 허용
- host version 범위
- operation/runtime limits
- checkpoint policy
- unexpected modal policy

## 승인창 제거 구현

`trusted_unattended`에서 `ConfirmationService.issue()`와 `consume()`를 사용하지 않는다. 대신 `AuthorizationService.authorize(plan, lease)`가 `allow`, `allow_with_checkpoint`, `deny`, `interactive_required`를 반환한다.

`ApprovalBroker.cs`는 작업별 승인기가 아니라 profile enrollment/maintenance 도구로 축소한다.

## 완료 검증

- 100개의 연속 R2/R3 fixture operation을 실행해도 MessageBox 0회
- approvals directory에 pending/approved file 0개
- policy 범위 밖 요청은 popup 없이 `POLICY_DENIED`
- interactive mode는 기존 one-shot 보안 테스트 통과
