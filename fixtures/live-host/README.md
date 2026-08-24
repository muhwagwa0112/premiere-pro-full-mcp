# Disposable live-host fixtures

The default fixture is created empty by Premiere inside a unique OS-temporary directory. It is never derived from an active or user-supplied project. Future seeded fixtures are accepted only when their `.prproj` seed is physically stored below the repository `fixtures` directory.

`npm run validate:fixture-plan` is plan-only and does not connect to Premiere or create files. A live run additionally requires `--live --confirm-isolated-host`; it aborts before creating the fixture if Premiere reports any active project. After Premiere creates the working project, the runner seals a pristine baseline copy. Only the working copy is mutated, and restore evidence is emitted only after the pristine copy digest and restored project state are verified.

The live runner never closes, saves, or replaces a project that was active before it started. Run it in an isolated Premiere session. The evidence JSON contains hashes and host/API identifiers, never source, workspace, project, or media paths.
