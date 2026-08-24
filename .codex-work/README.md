# Premiere Pro Full MCP — Codex 작업지시 패키지

## 목적

이 패키지는 `muhwagwa0112/premiere-pro-full-mcp`를 다음 목표로 개편하기 위한 **Codex 실행용 권위 문서 세트**다.

1. 작업마다 표시되는 자체 승인 메시지를 제거하고 `trusted_unattended` 모드에서 완전 무인 실행한다.
2. 연결 여부만 보는 현재 라우팅을 operation-aware capability routing으로 교체한다.
3. 선언만 존재하고 실제 실행 경로가 없는 action을 정직하게 분류하고 우선순위에 따라 구현한다.
4. 프로젝트·미디어·타임라인·효과·오디오·텍스트·자막·색·내보내기·협업·플러그인·클라우드까지 Premiere 기능 전체를 feature registry로 관리한다.
5. 변이 작업은 checkpoint, postcondition verification, outcome reconciliation을 갖춘다.

## 사용법

1. ZIP을 작업 디렉터리에 압축 해제한다.
2. 이 패키지의 내용 전체를 대상 리포지터리 루트 아래 `.codex-work/`에 복사한다.
3. Codex에게 다음 문장을 전달한다.

```text
리포지터리 루트의 .codex-work/AGENTS.md와 .codex-work/CODEX_MASTER_PROMPT.md를 먼저 읽고,
.codex-work/TASK_MANIFEST.json의 dependency 순서대로 실제 구현을 진행해.
계획만 작성하지 말고 코드·테스트·문서까지 수정하되, 각 phase의 acceptance gate를 통과시켜.
```

4. 첫 구현 브랜치 권장명:

```text
codex/v0.3-unattended-foundation
```

## 문서 우선순위

1. `SCOPE_LOCK.md`
2. `AGENTS.md`
3. `CODEX_MASTER_PROMPT.md`
4. `TASK_MANIFEST.json`
5. `tasks/*.md`
6. `docs/*.md`
7. 참고 스키마와 템플릿

충돌 시 위 순서를 따른다.

## 패키지 기준선

- Repository: `muhwagwa0112/premiere-pro-full-mcp`
- Baseline branch: `main`
- Baseline commit: `92ac689cfea1de1e5863a03cb1aecdec4c0f56d5`
- Baseline package version: `0.2.0`
- Target foundation release: `0.3.0`
- Host baseline: Windows, Adobe Premiere Pro 26.3.2
- UXP declaration baseline: `@adobe/premierepro` 26.3.0

기준선 이후 upstream 변경이 있으면 Codex는 먼저 diff를 조사하고, 본 지시의 불변조건을 유지하면서 최신 코드에 맞게 적용한다.
