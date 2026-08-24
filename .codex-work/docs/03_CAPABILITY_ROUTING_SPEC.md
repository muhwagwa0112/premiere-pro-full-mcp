# Capability-aware Routing Specification

## 문제

현재 adapter가 연결되어 있으면 해당 operation 지원 여부와 무관하게 우선 선택될 수 있다.

## Backend probe

```ts
interface BackendProbe {
  backend: Backend;
  available: boolean;
  hostVersion?: string;
  hostSessionId?: string;
  capabilityFingerprint?: string;
  operations: string[];
  reasons?: Record<string, string>;
}
```

## Support decision

```ts
interface SupportDecision {
  supported: boolean;
  state: "verified" | "implemented_unverified" | "contextual" | "experimental" | "unsupported";
  requiredState?: string[];
  reason?: string;
}
```

## Dispatch state

```ts
type DispatchState = "not_dispatched" | "accepted" | "completed" | "unknown";
```

## 안전한 fallback

- DNS/pipe/socket 연결 이전 failure: `not_dispatched`
- capability 미광고: `not_dispatched`
- host에 command 전송 성공: 최소 `accepted`
- response 수신 및 verifier 통과: `completed`
- host 전송 후 connection loss: `unknown`

`accepted`, `completed`, `unknown`에서는 다른 backend로 같은 변이를 보내지 않는다.

## 승인 소비 시점

1. validate input
2. resolve paths/state
3. probe adapters
4. select exact backend
5. generate planHash
6. authorize
7. checkpoint
8. dispatch

이 순서를 코드와 테스트로 고정한다.
