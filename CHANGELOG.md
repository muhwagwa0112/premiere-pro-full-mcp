# Changelog

## 2.0.0

This release replaces the previously published 1.2.0 artifacts. It is a major
contract update and must be installed as one daemon + CEP + UXP set, followed
by a Premiere restart.

### Fixed

- Diagnostic tools now use the single public names `premiere_health_check` and
  `premiere_connection_status`.
- Premiere 26 sequence creation uses the UXP Project API with postcondition
  readback; the invalid CEP one-argument call is never dispatched.
- `media_batch_relink` accepts bounded `relinks` entries and maps them to the
  singular relink handler.
- XML import and frame export expose 120-second queue budgets; XML import has a
  five-minute execution budget and verifies its final project checkpoint path.
- Recovery exposes a read-only bounded fingerprint snapshot. Unknown outcomes
  quarantine mutations while leaving diagnostic reads available.
- Work-area units, audio dB conversion, clip enabled-state uncertainty,
  keyframe completeness metadata, and frame-export materialization/readback are
  corrected.
- Release archives are version-coherent and hash-verified; installer swaps keep
  prior CEP/UXP deployments in a recoverable quarantine.

### Breaking changes

- The two accidental `premiere_premiere_*` diagnostic names are removed.
- `media_batch_relink` now requires `relinks: [{project_item_id,new_path}]`.
- `import_fcp_xml` requires `output_directory`.
- Audio `level_db` is true UI dB; raw Premiere internal Level values are exposed
  separately as `internalLevel`.
- When enabled state cannot be read, tools return `enabled: null` with source or
  error metadata instead of guessing `true`.

### Rollback

Close Premiere, stop the scheduled daemon task, restore the prior CEP/UXP
folders from `%LOCALAPPDATA%\PremiereMCP\quarantine`, reinstall the matching
prior daemon source, then reopen Premiere. Never mix host plugins and daemon
files from different release sets.
