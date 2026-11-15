# Automated image and video workflows

The new workflow runtime compiles typed editing requests into host and local-worker operations. A persistent owner executes the work, records receipts, resolves exact targets, produces artifacts and evaluates the declared requirements. Photoshop-only work belongs to the Photoshop owner. Premiere and cross-application work belongs to the existing Premiere daemon; cross-application Photoshop edits are sent to its authenticated peer owner.

Implementation and live-device qualification are separate. The source changes do not certify any Photoshop/Premiere build, encoder preset, model, font or GPU. Unsupported APIs and missing profiles return an explicit setup/capability state. A successful transport reply, an encoder queue acknowledgement or an existing output path is insufficient to declare a completed edit.

## Install the matching source and plugins

Use Node **20.19 or later**. Install the repository dependencies and build the selected repository on the target machine. The build copies JSON contracts and Python worker files into the runtime. Deploy the updated UXP/CEP plugin together with the owner/daemon code; a running old plugin cannot acquire new handlers by updating the Node package alone. Existing pairing credentials, user documents, output directories and previous workflow receipts remain installation data.

The Photoshop stdio entry now connects to a persistent local owner. Closing an MCP client does not terminate an accepted job. `node dist/src/index.js --stop-runtime-owner` requests an authenticated, graceful owner stop; an active job must finish or be cancelled first. The installer uses this operation before replacing runtime files. It does not terminate Adobe applications or arbitrary Node processes. Premiere continues to use its existing daemon installation and restart commands.

No model downloads or Adobe host execution are part of source installation. Configure the optional worker as described in [workers/README.md](../workers/README.md). Actual device tests should exercise the changed operation/recipe on the intended profile; no new full-suite hook or recurrent audit is installed by this change.

## Configure roots, presets and the controller

Set `ADOBE_MCP_AUTOMATION_CONFIG` in the **owner/daemon** environment to an absolute JSON path, or use `<workflow-data-directory>/profiles/automation.json`. An explicit `roots` map replaces the legacy fallback map. Inputs and deliveries refer to stable root IDs plus relative paths. Do not use broad writable roots when a job only needs a source directory and a delivery directory.

Start with [config.windows.example.json](../examples/automation/config.windows.example.json). Change every example directory to an existing directory on the actual machine. Source roots can be read-only. The runtime creates owned working copies under its internal `assets` directory; source files are never the default edit/save destination. Register actual Premiere `.epr` encoder presets and sequence preset files, then reference their IDs in the request. Preset IDs are installation mappings, not names inferred from the user's filesystem.

The loader accepts:

```ts
interface InstallationConfiguration {
  schemaVersion: 1;
  roots: Record<string, { path: string; readOnly?: boolean }>;
  presets?: Record<string, { rootId: string; relativePath: string }>;
  sequencePresets?: Record<string, { rootId: string; relativePath: string }>;
  controller?: {
    providerId: string;
    endpoint: string;              // numeric loopback HTTP, e.g. http://127.0.0.1:11434
    modelTag: string;              // an already installed vision model
    modelDigest: string;           // the actual full installed SHA-256 digest
    templateDigest: string;        // actual /api/show template/model/vision snapshot digest
    runtimeVersion?: string;
    numCtx: number;
    maxOutputTokensPerCall: number;
    inputTokenUpperBound: number;
    inputBoundQualified: boolean;  // true only for an actually qualified bound
    inputLimits: { maxUtf8TextBytes: number; maxImages: number; maxImagePixels: string };
    maxPayloadBytes?: number;
  };
}
```

The local provider uses Ollama `/api/chat` with schema-constrained image/text output. A full model digest and qualified input bound are required before enabling unattended calls. The runtime verifies the installed model identity, persists budget reservations and accounts for unknown outcomes conservatively. An HTTP abort does not prove that backend inference stopped. A missing or incomplete provider configuration leaves `client_agent` operation available and configured-provider work waiting for setup; it never fabricates a review.

`node scripts/record-controller-profile.mjs --output <absolute-new-file>` records the already-installed local `gemma3:4b` model digest, Ollama version and `/api/show` snapshot digest. It makes no inference request and downloads nothing. Copy the generated `controller` object into `automation.json`, complete the text/image/token limits from the intended profile's measured bound and mark the bound qualified only when that evidence exists. The generated `observedSnapshot` and `qualification` are supporting records, not top-level `automation.json` fields. Installed Photoshop runtimes also include the recorder under `dist/scripts/`.

For `client_agent`, retrieve the pending controller request, inspect its fixed observations/context and submit a response with the same request ID and digest. The owner validates all target bindings, operation IDs, parameters, requirements, evidence references and budgets before applying any proposal. The client does not gain permission to introduce new file roots or paid/remote/generative operations.

## Recipes and requests

The canonical request schemas are shipped under [src/automation](../src/automation/). Recipe-specific fields use closed schemas. These recipe request types are implemented by the compiler; each job still needs the capabilities required by its chosen steps:

| Recipe | Editing goal |
|---|---|
| `ps.product_variants.v1` | Product/template/brand placement and explicitly mapped output sizes. |
| `ps.photo_composite.v1` | Source preparation, selected subject/mask, composite and preserved native master. |
| `ps.social_layout.v1` | Template/role binding, text and image replacement, layout variants. |
| `pr.interview_captioned.v1` | Media analysis, dialogue/cut mapping, timeline construction, audio/captions and delivery. |
| `pr.multicam_edit.v1` | Source synchronization and explicit camera cuts, preserving the requested representation. |
| `pr.project_revision.v1` | Reopen a checkpointed project and apply a typed revision to bound resources. |
| `cross.ps_title_to_premiere.v1` | Produce a Photoshop title asset and apply the same revision in Premiere. |

Examples in [examples/automation](../examples/automation/) contain illustrative input paths, installation IDs, request IDs and deadlines. Before submitting, replace `workflowHome` with the actual owner identity, choose a **new persisted requestId**, set a future deadline, supply real assets and match preset/root IDs to the installation. Keep the same request ID when querying/retrying the same accepted request. Any semantic change, including brief, policy, output settings or revision, requires a new request ID.

The owner hashes the complete normalized semantic request before invoking a host/model. Identical IDs and payloads join/reuse the accepted result; changed payloads return an idempotency conflict. Full results can be retained separately from request identity tombstones. A caller timeout does not imply the native edit failed or is safe to repeat.

Role binding can use an explicit sidecar or `roleManifest: "auto"`. Automatic binding uses actual inventory candidates and visual observations, then validates the controller's candidate keys and records a pinned sidecar. A missing/ambiguous role fails; there is no “first matching name/layer/clip” fallback. An observed-projection fingerprint is labelled as such and is never described as a full pixel-content fingerprint.

## Completion, cancellation and revision

The runtime keeps source and timeline clocks separate and stores times as decimal integer tick strings. Frame rates are rational numbers. Host targets include the host epoch plus document/project/sequence and resource identity. Stale targets are re-resolved through recorded observations or rejected. Cross-track movement, native multicam and effect values are not approximated by changing their meaning.

Native mutations are serialized within their materialization group. A revision starts from the recorded saved checkpoint and reconstructs effects absent from that saved boundary. The presence of an old execution receipt alone does not prove that a PSD or Premiere project contains that effect. Immutable derived artifacts may be reused only with matching input/configuration hashes.

Editable ducking replaces the qualified gain parameter's curve with the computed envelope. The host reads the complete keyframe inventory, each native value and the midpoint of each linear interval. The canonical `audio.duck_envelope` assertion records those observations together with the qualified dB encoding and source/clip/sequence clock conversion. A requested keyframe list or a transaction acknowledgement alone cannot satisfy this assertion. Scalar gain explicitly removes the old animation curve before setting and reading the static value.

Cancellation uses a control lane separate from the native command queue. A late success receipt does not revive a cancelled job. `OUTCOME_UNKNOWN` requires receipt/postcondition/checkpoint reconciliation; automatic replay of a potentially applied mutation is forbidden. Workers kill only their owned subprocess group, preserve a durable claim and do not publish partial output as a successful result.

Exports go through a job-owned staging path, host completion observation, actual artifact checks and publication. Default collision policy creates a new version. Explicit overwrite requires the expected current hash and still cannot replace an original input. Premiere validation compares the requested dimensions, frame rate, pixel aspect, codecs, pixel format, field order and specified audio/color constraints against the generated file. Full decode is selected only when the request explicitly requires it. Image evidence records actual bounds, scaling, alpha and color information; a source video frame is never passed off as an edited-sequence preview.

Requirements remain fixed for the request. Required assertion/semantic conditions must pass; missing, stale, partial or uncertain evidence cannot become a pass. Semantic repair is bounded by the declared repair count, elapsed time and model budget. A model cannot erase a failing requirement or invent a host readback. Native caption text/style, complex cross-track preservation and native multicam require an actual implementing provider; a worker-rendered alternative is usable only when the delivery policy explicitly permits it.

## Premiere parameter and time-map profiles

`premiere_workflow_describe` returns the persistent `workflowHome`, root/preset IDs and current host/provider capabilities. The Premiere owner stores its installation ID in `<automation-data-directory>/installation-id.json`; credential rotation does not change it. `PREMIERE_MCP_AUTOMATION_DATA_DIR` overrides the owner data directory. `PREMIERE_AUTOMATION_ROOT` overrides its default workspace/output directory. For cross-application work, `PHOTOSHOP_MCP_DATA_DIR` selects the existing Photoshop owner. The peer maps each owner's internal staging root and the default workspace/output roots explicitly; custom roots shared by both applications must use the same ID and actual directory in both installations.

Set `PREMIERE_PARAMETER_PROFILE_FILE` in the daemon environment to a JSON **array** of observed native parameter profiles. There are no built-in guesses for effect names, parameter indices, Point coordinates or MOGRT payloads. A profile is selected by exact `hostVersion` and semantic key, then the native component and parameter identity are checked before writing. Read `premiere_effects_chain_inventory` for the exact bound clip; a display name or array position from another build/template is insufficient.

The following is a structural example for a native Point parameter whose coordinates were confirmed to use sequence pixels. Its placeholder names, version and digest deliberately prevent it from acting as a qualified installation profile:

```json
[
  {
    "id": "installed-motion-x",
    "hostVersion": "EXACT_INSTALLED_HOST_VERSION",
    "semantic": "motion.positionXNormalized",
    "componentMatchName": "EXACT_OBSERVED_COMPONENT_MATCH_NAME",
    "parameterIndex": 0,
    "expectedDisplayName": "EXACT_OBSERVED_PARAMETER_NAME",
    "encoding": "native",
    "valueShape": "point_x",
    "scaleBy": "sequence_width",
    "multiplier": 1,
    "offset": 0,
    "keyframeClock": "sequence",
    "qualificationDigest": "REPLACE_WITH_ACTUAL_64_HEX_EVIDENCE_DIGEST"
  }
]
```

`parameterIndex` is an observed index within the exact component. Replace every placeholder, including that index, from the installation's recorded observation. `multiplier` and `offset` convert a requested numeric value into native units. `scaleBy` optionally multiplies by the **actual target sequence** width or height before that conversion. It must be omitted when the native parameter already uses normalized coordinates. `valueShape: "point_x" | "point_y"` preserves the other coordinate and creates a native `PointF`. An already animated compound Point cannot be safely treated as two independent scalar curves and is rejected with `COMPOSITE_ANIMATION_PRESERVATION_UNAVAILABLE`.

Supported semantic keys are `motion.positionXNormalized`, `motion.positionYNormalized`, `motion.scalePercent`, `motion.rotationDegrees`, `motion.opacityPercent`, `title.text`, and `effect.<declared-effect-name>.<declared-field>`. Every requested effect field needs its own profile; all fields must resolve to the same exact component. A missing/unknown effect never becomes Gaussian Blur or another default effect. Static mode removes that parameter's existing keyframes explicitly; `replace_keyframes` replaces its key list with the requested values and qualified clock positions.

For a MOGRT string that contains JSON, use `valueShape: "json_text"` and `jsonTextPath`, for example `["observedContainer", "observedTextProperty"]`, with the **actual** nested string property names. The adapter parses the existing payload, replaces only that exact string and preserves the remaining JSON values. The qualified profile must match that template's text/style representation. An unqualified JSON payload is rejected instead of overwriting the whole payload with plain text. Animated text with `preserveAnimation: true` requires a complete curve-preserving provider and is explicitly blocked by the current adapter.

Workflow keyframe `ticks` always describe **sequence timeline time**. `keyframeClock` declares the observed native parameter clock: `sequence`, `clip_relative` or `source`. Source-clock conversion uses exact source/timeline ranges and reverse state, and also requires `sourceTimeMap: "constant_speed"`. The latter does not, by itself, qualify an arbitrary existing clip. Newly placed native segments carry this runtime's non-retimed provenance. Existing clips require a separate `time_remap.video` or `time_remap.audio` profile selecting the actual intrinsic retime parameter; `isTimeVarying()` must be false and its actual keyframe list must be empty. Source/timeline average duration ratios alone are never accepted as evidence that a variable speed curve is linear. Trim and linked trim reject an unqualified or variable time map before applying actions.

Set `PREMIERE_AUDIO_ENCODING_FILE` to a JSON array of gain profiles. A profile contains `id`, exact `hostVersion`, `route` (`uxp` or `cep`), `componentMatchName`, `parameterIdentity`, `encoding`, `minDb`, `maxDb`, and `qualification: { hostBuild, evidenceDigest }`. The encoding is one of `decibels`, `linear_amplitude` or `db_plus_offset`; `offset` is required for the last. `linear_amplitude` uses `10 ** (db / 20)`, and every applied value is read back. `db_plus_offset` is enabled only by an actually qualified profile; `db + 15` is not a universal rule.

For UXP audio, `parameterIdentity` is the observed parameter index rendered as a string or its exact display name, unique within the matching component. CEP uses the observed match name, or display name when the host exposes no match name. Keyframes additionally need the clock fields above. CEP source-clock keyframes require `retimeParameter: { componentMatchName, parameterIdentity }` and a direct static/no-keyframe readback of that intrinsic parameter. Legacy `time_seconds` inputs remain relative to the target clip's timeline start; they are converted to the configured native clock.

These profile contracts and native handlers are implemented. This change supplies no invented host-build/template qualification digest, does not install an example as an active profile, and has not executed the native parameter/encoder routes on the user's device. Missing profiles remain `requires_setup`. Native caption cue/style and transition readback, exact cross-track moves, selected-instance source replacement, and native multicam operations remain explicit capability limits; a permitted rendered artifact is a distinct delivery choice.

## Legacy effect batches and native reads

`effects_batch_apply` and `effects_batch_remove` now require a persisted UUID `batch_id`, the observed `expected_host_epoch`, and unique `itemKey` plus explicit `sequence_id` for each item. The daemon assigns a separate native operation ID and durable receipt to every item. Repeat the same batch ID and payload after a lost reply: succeeded items are reused, an unknown item stops the batch, and no parent mutation lease can deadlock its child operations. `resume_failed: true` explicitly retries only a proven no-effect failure under a new attempt ID, at most three attempts per item. A semantic change requires a new batch ID and intentionally selected remaining items.

Native result bodies retain at most 256 terminal receipts and 64 MiB in the owner store. Expired bodies leave permanent identity/digest tombstones and return `RESULT_EXPIRED`; they do not permit another execution. Pending and unknown outcomes are preserved. Batch identity records retain item attempt identities independently of result bodies.

`project_close_inactive` requires `project_guid`, `expected_host_epoch` and `save_policy`. A missing/stale epoch is rejected before closing a project. `captions_cue_count`, `captions_cue_snapshot` and `captions_export_srt` require actual native cue/revision observation. The currently connected public API cannot supply that observation, so these native reads report `CAPTION_SOURCE_UNAVAILABLE`; an unrelated SRT or caller-provided cue list cannot certify the sequence. Use `transcript_export_srt` for an explicit transcript, or the workflow's permitted rendered-caption path for delivery.

## Device verification

The implementation review covers source correctness, integration, failure semantics and available focused tests. Later verification on the real installation must record its exact host/plugin/model/preset versions and the actual assertions/artifacts for the affected capability. Use owned temporary projects and representative input assets. Capture the concrete export, cancellation/reconnect or editing case relevant to the feature being qualified. The status remains `not_run` for operations that have not been executed on that profile.
