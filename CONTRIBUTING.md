# Contributing

Use Node.js 24 when available and preserve the Node 20.19 runtime floor. Run `npm run check` and
the UI-agent tests for affected changes. UXP changes require Adobe 26.3 type checking and a live
host gate before support claims. ExtendScript must remain ECMAScript 3 compatible.

Keep public schemas, action catalog entries, bridge dispatchers, tests, and documentation aligned.
Do not silently retry mutating work through another backend.
