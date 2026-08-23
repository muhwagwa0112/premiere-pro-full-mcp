# Local host baseline

- Windows 10 x64 build 19045, `ko-KR`, 96 DPI.
- Adobe Premiere Pro 2026 `26.3.2` is the supported live target.
- Node.js 24 and .NET 8 SDK are available.
- Existing MCP/CEP installations are treated as rollback references and are not overwritten.
- Installed third-party surfaces include Film Impact and Mocha; support is runtime-discovered and
  remains unverified until exercised against a disposable project.

Adobe's stable `@adobe/premierepro` 26.3 declarations are the build-time UXP inventory baseline.
Private built-in UXP dependencies and third-party DLL interfaces are not called directly.
