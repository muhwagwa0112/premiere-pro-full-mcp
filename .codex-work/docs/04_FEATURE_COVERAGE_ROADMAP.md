# Premiere 전체 기능 커버리지 로드맵

## 지원 상태

- VERIFIED_AUTOMATED
- VERIFIED_READ_ONLY
- SUPPORTED_CONTEXTUAL
- PREVIEW_ONLY
- UI_ADAPTER_REQUIRED
- EXTERNAL_SERVICE_REQUIRED
- ENTITLEMENT_BLOCKED
- THIRD_PARTY_DEPENDENT
- MANUAL_ONLY
- BLOCKED_BY_HOST_VERSION
- UNVERIFIED
- UNSUPPORTED

## 기능 도메인

### Project / Productions

프로젝트 생성·열기·저장·닫기·save-as, bin/item CRUD, settings, Productions, Team Projects.

### Media / Ingest / Proxy

import, folder import, relink, replace, offline, proxy, ingest, interpret footage, metadata, subclip.

### Sequence / Track / Clip

sequence CRUD/settings, track CRUD/state, insert/overwrite/move/copy/delete, ripple/lift/extract, link/group/nest, markers, in/out, playhead.

### Trim / Sync / Multicam

ripple, roll, slip, slide, rate stretch, audio/timecode sync, multicam source/angle/flatten.

### Effects / Transitions / Motion / Masks

effect inventory/apply/remove/reorder, parameters, keyframes, transitions, Motion, Opacity, Time Remapping, masks, object masks.

### Audio

clip gain, volume, pan, keyframes, channel mapping, track mixer, submix/send, Essential Sound, Enhance Speech, Remix, loudness.

### Text / Transcript / Captions / Graphics

transcript status/create/search/edit, text-based editing, caption track/cue CRUD, import/export, MOGRT, graphic properties.

### Color / HDR

Lumetri, LUT, input/working/output color space, tone mapping, HDR metadata, curves/HSL/wheels.

### Export / AME / Interchange

frame, sequence, range, batch, AME queue/status, AAF/XML/EDL/OMF, captions, project manager.

### Workspace / Playback / Preferences

playback, monitors, workspace, panels, history, preferences, scratch disk, media cache.

### Collaboration / Cloud / AI

Productions, Team Projects, Frame.io, Stock, cloud media, speech/caption services, generative functions.

### Third-party / Native / Hybrid

plugin inventory and adapters, codec/importer/exporter, hardware SDK, high-performance video/audio/ML.

## 완료 원칙

기능을 단순히 registry에 등록했다고 자동화 지원으로 계산하지 않는다. backend implementation과 verifier evidence를 별도 지표로 보고한다.
