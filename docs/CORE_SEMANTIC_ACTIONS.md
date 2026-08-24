# Core semantic actions

The v0.3 semantic layer exposes bounded project, media, track, and clip operations instead of asking callers to compose raw host members.

| Action | Backend | Required scope token | Exact target | Postcondition |
| --- | --- | --- | --- | --- |
| `project.checkpoint` | UXP/CEP | route-bound two-phase identity check | saved active project in an approved root | exclusive sibling copy matches byte count and SHA-256 |
| `project.close_disposable` | UXP | active-project-identity `expectedRevision` | exact active path satisfying the guarded OS-temporary fixture-path policy | save succeeds, then closed project identity is absent from active host readback |
| `project.save_as` | CEP | active-project `expectedRevision` | approved destination path | active project path matches and the project file is non-empty |
| `media.relink` | UXP | active-project `expectedRevision` | same-session `ClipProjectItem` handle | media path equals the requested canonical path |
| `media.proxy.attach` | UXP | active-project `expectedRevision` | same-session `ClipProjectItem` handle | proxy is present and its path matches |
| `timeline.track.set_mute` | UXP | active-sequence `expectedRevision` | same-session active `Sequence` handle and bounded track index | `isMuted()` equals the requested state |
| `timeline.clip.insert` | UXP | active-sequence `expectedRevision` | same-session active `Sequence` and `ProjectItem` handles | transaction succeeds and the target video-track item count increases |

All argument schemas reject unknown fields. Save As never overwrites an existing file, Team Projects alternate-media attachment is not exposed, and clip insertion is bounded to seven days. A missing state token is blocked before backend probing. A malformed or missing postcondition after dispatch is recorded as `reconciliation_required`; it is never automatically retried or routed to another backend.

`project.close_disposable` uses a deliberately narrow path classification (canonical regular file, non-link, approved root, OS temporary directory, and `premiere-mcp-live-fixture-*` parent) plus exact UXP active-path readback. It always saves successfully before closing and never exposes a discard-unsaved-work path.

These handlers are `implemented_unverified` until an isolated v0.3 live fixture records host-build and API-fingerprint evidence. The plan-only fixture runner is safe by default and live execution requires `--live`, `--confirm-isolated-host`, and an enrolled `trusted_unattended` or `isolated_lab` trust profile.
