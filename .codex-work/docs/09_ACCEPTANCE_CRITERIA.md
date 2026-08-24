# 전체 Acceptance Criteria

## Foundation release v0.3

- [ ] trusted_unattended 작업 중 per-operation MessageBox 0회
- [ ] approvals pending/approved file 0개
- [ ] interactive approval 회귀 통과
- [ ] capability-aware routing 적용
- [ ] unsupported backend는 authorization 이전에 skip
- [ ] only not_dispatched fallback
- [ ] outcome unknown 자동 retry 없음
- [ ] Trust Profile DPAPI 보호 및 사용자/설치 binding
- [ ] execution plan hash와 process lease
- [ ] 첫 변이 전 checkpoint
- [ ] 안전한 export overwrite
- [ ] semantic action/backend parity
- [ ] 정직한 runtime support matrix
- [ ] version 0.3.0 일관성
- [ ] npm/.NET/plan/release tests 통과

## 장기 Full Coverage

- [ ] 모든 사용자 기능이 feature registry에 존재
- [ ] 각 feature에 backend, state, version, preconditions, verifier 존재
- [ ] verified는 evidence가 있는 기능에만 사용
- [ ] UI/entitlement/third-party/manual-only 상태가 명확
- [ ] project/media/timeline/effects/audio/text/color/export fixture 확보
- [ ] host-version compatibility matrix 생성
