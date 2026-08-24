# Post-production program

The v0.3 program registry covers effects, audio, text, captions, color, and export without treating catalog coverage as verified host support.

`post.inspect_delivery` is the only implemented compound workflow. `premiere_jobs` mode `workflow_plan` builds this exact durable DAG:

1. `effects.catalog`
2. `captions.inspect`
3. `project.checkpoint`
4. `export.sequence`
5. `project.checkpoint`

Both checkpoint steps use the route-bound two-phase host checkpoint protocol and record verified byte-count and SHA-256 evidence without returning raw project or checkpoint paths. Any failed or unknown checkpoint blocks the following step; unknown outcomes are never redispatched automatically.

The remaining post-production workflows stay `plan_only`. Their required mutations remain `not_implemented`, `ui_adapter_required`, `blocked_external`, or `blocked_host_version` until a typed handler and runtime evidence exist. Entitlement-dependent actions fail before dispatch unless their runtime entitlement probe is verified.
