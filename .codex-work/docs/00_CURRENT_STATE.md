# 현재 상태 요약

## 강점

- UXP, CEP, QE, UI, Local 다중 backend
- UXP 선언 761개 inventory
- HMAC, DPAPI, localhost binding
- release signing과 package integrity
- path allowlist
- one-shot approval과 duplicate operation 방지
- export stable-file 검증
- outcome unknown에서 자동 재시도 금지

## 핵심 결함

1. backend 연결 여부만 보고 action 지원 여부는 늦게 확인한다.
2. UXP가 연결됐지만 action을 광고하지 않는 경우 실제 CEP/Local handler로 가지 못할 수 있다.
3. 정적 support label과 실제 handler가 불일치한다.
4. 일부 semantic action은 선언만 있고 직접 처리 경로가 없다.
5. project/sequence revision token이 clip/effect/keyframe 변화를 충분히 반영하지 못한다.
6. `committed_unverified`가 성공으로 노출된다.
7. UI adapter는 범용 Premiere 기능 지원 수준이 아니며 live UI probe도 timeout 기록이 있다.
8. R2/R3마다 별도 승인창이 나타나 unattended automation을 방해한다.

## 즉시 수정 대상 action

- project.create
- project.open
- media.import
- timeline.sequence.create_from_media
- effects.catalog
- export.sequence
- captions.inspect
- timeline.clip.insert
- timeline.ripple_delete
- effects.apply
- history.undo
- plugin.ui.invoke
- cloud.status
- cloud.action
