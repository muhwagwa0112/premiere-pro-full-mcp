# Task 실행 순서

## Phase 0 — 반드시 순서 준수

```text
P0-01
  ├─ P0-02 ─ P0-03 ─┬─ P0-06 ─ P0-07
  │                  └─ P0-08
  └─ P0-04 ─ P0-05 ─┘
                         ↓
                       P0-09
```

`P0-05`만 단독으로 수행하여 MessageBox를 삭제해서는 안 된다. 정책 엔진과 capability routing을 먼저 넣어야 한다.

## Phase 1

```text
P0-09 → P1-01 → P1-02
      ├→ P1-03 → P1-04
```

## Phase 2

```text
P1-02 + P1-03 → P2-01 → P2-02 / P2-03
```
