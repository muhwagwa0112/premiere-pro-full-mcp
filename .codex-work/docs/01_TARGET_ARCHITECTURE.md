# 목표 아키텍처

```text
MCP Semantic Tools
        ↓
Feature Registry
        ↓
Host/Backend Capability Probe
        ↓
Execution Planner
  - normalized request
  - backend route
  - preconditions
  - state token
  - path policy
  - verifier
        ↓
Authorization Policy
  - interactive
  - trusted_unattended
  - isolated_lab
        ↓
Process-scoped Session Lease
        ↓
Checkpoint / Transaction / Dispatch
        ↓
UXP | CEP | QE | UI | Local | Native | Service
        ↓
Postcondition Verification
        ↓
Evidence Ledger / Reconciliation
```

## 권장 모듈

```text
src/
  features/
  routing/
  state/
  security/
  workflows/
  verifiers/
  evidence/
  connectors/
```

## 핵심 원칙

- feature registry가 catalog, MCP description, support matrix의 단일 원천이다.
- backend route는 authorization 이전에 결정한다.
- authorization은 exact execution plan에 바인딩한다.
- mutating operation의 정상 완료는 postcondition verifier 통과를 요구한다.
- raw API는 expert surface로 분리하고 verified semantic feature와 구분한다.
