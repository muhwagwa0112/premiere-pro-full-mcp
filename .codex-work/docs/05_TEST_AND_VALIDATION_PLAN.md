# 테스트 및 검증 계획

## Unit/Contract

- action/handler parity
- capability probe and routing
- dispatch-state classification
- authorization mode
- plan hash canonicalization
- lease expiry and process binding
- profile tamper/SID mismatch
- path escape/reparse protection
- checkpoint and overwrite safety
- privacy-safe ledger

## Disposable live fixtures

- empty project
- basic edit
- effects/keyframes/masks
- audio/multichannel
- captions/transcript
- multicam
- SDR/Log/HDR
- offline/proxy/relink
- MOGRT/graphics
- Productions
- third-party plugins

## Failure injection

- UXP disconnect before send
- UXP disconnect after send
- CEP response loss
- modal dialog
- export process crash
- duplicate operation ID
- state drift between plan and dispatch
- path already exists
- output write denied
- UI tree reconstruction

## Evidence record

- host version/build
- API fingerprint
- feature ID
- backend
- fixture hash
- normalized plan hash
- before/after state token
- verifier outcome
- rollback outcome
- no raw project/media/path data

## Gate

`verified`는 postcondition과 evidence가 모두 있을 때만 부여한다.
