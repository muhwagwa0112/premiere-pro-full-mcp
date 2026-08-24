# Migrating from v0.2 to v0.3

v0.3 keeps the existing MCP tool names, action request shape, and interactive approval flow. The
default automation mode remains `interactive`, but installation now records the mode explicitly.

## Interactive installations

Reinstall with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1 -AutomationMode Interactive
```

Existing R2/R3 clients still preview and approve one exact plan. Legacy v1 approval records are not
accepted; preview again to obtain the current route/session-bound approval.

## Enrolling trusted unattended execution

Create a schema-v1 Trust Profile with the exact intended mode, action/risk/capability policy,
approved canonical roots, Premiere host-version range, checkpoint settings, and operation/runtime
limits. Then enroll it during installation:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1 `
  -AutomationMode TrustedUnattended `
  -TrustProfilePath .\studio-profile.json
```

The broker validates the JSON and binds the protected profile to the current SID, product, and
launcher identity. No unattended mode can be selected with a missing or mismatched profile, and
there is no automatic fallback to interactive.

Updates preserve `automationMode` and `trustProfileId` from installed metadata. If the authenticated
update changes the native launcher, provide the original profile JSON to `Update.ps1
-TrustProfilePath ...` so it can be rebound. Without it, the update fails closed.

## Behavioral changes

- Backend selection is operation- and runtime-capability-aware before authorization.
- Only `not_dispatched` may fall back; accepted/completed/unknown operations are never replayed.
- Execution plans bind normalized input, effective bridge arguments, route/session identity,
  approved roots, state token, checkpoint requirement, and verifier under a process lease.
- The first trusted mutation and later profile-selected mutations require a verified checkpoint.
- Unknown checkpoint, dispatch, output, or ledger state becomes `reconciliation_required` and
  quarantines later mutations across restart.
- Authorized overwrite uses a durable backup/temp/verification/no-clobber commit transaction.
- Compound operations use protected `premiere_jobs` records. Resume skips only verified completed
  steps; rollback requires explicit rollback requests, verified revisions, and host undo evidence.
- Public raw UI catalog/invoke requests are replaced by fixed version/locale/fingerprint semantic
  adapters. Callers must select a registered adapter contract rather than supply selectors.
- Project/media/timeline semantic handles are bound to the current host session, project identity,
  and state token. Handles persisted before a dependent mutation are rejected instead of guessed.
- The full feature registry distinguishes contextual support, unverified handlers, UI adapters,
  entitlements, third-party dependencies, and unsupported boundaries without upgrading live claims.

There is no automatic migration that grants unattended authority. Existing installations stay
interactive until a user explicitly enrolls a Trust Profile.
