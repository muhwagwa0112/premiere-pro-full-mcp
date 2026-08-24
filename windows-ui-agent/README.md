# Premiere MCP Windows UI Agent

Local Windows-only fallback agent for Premiere Pro workflows that are not exposed by UXP or ExtendScript. It intentionally exposes only four operations over a current-user-only named pipe:

- `health`
- `premiere.window.inspect`
- `premiere.adapters.catalog`
- `premiere.adapter.invoke`

The agent does not accept arbitrary selectors, automation IDs, coordinates, clicks, scripts, or shell commands. Mutations name only a fixed adapter ID and version returned by `premiere.adapters.catalog`. Each adapter is compiled into the agent with an exact ancestor/target chain, allowed host build and locale, and a postcondition verifier. A mutation is rejected if the foreground window, host build, locale, targeted UI fingerprint, or postcondition differs.

## Build and run

```powershell
$env:PREMIERE_MCP_UI_TOKEN = '<random session token>'
dotnet build .\PremiereMcp.WindowsUiAgent.csproj
dotnet run --project .\PremiereMcp.WindowsUiAgent.csproj
```

The pipe name defaults to `PremiereMcpUi`. Set `PREMIERE_MCP_UI_PIPE` to an alphanumeric name (also `-`, `_`, and `.`) to override it. The pipe uses `PipeOptions.CurrentUserOnly`, which limits clients to the Windows user that launched the agent. Each JSON-line request must also authenticate with the session token. Four bounded listeners prevent a single idle connection from monopolizing the service; the first authenticated request has a 5-second deadline and subsequent reads have a 30-second deadline. Requests are limited to 1 MiB.

## Protocol

Request:

```json
{"protocolVersion":1,"requestId":"r1","token":"...","operation":"health","args":{}}
```

Response:

```json
{"protocolVersion":1,"requestId":"r1","ok":true,"result":{"status":"ok"}}
```

Semantic adapter discovery and invocation:

```json
{"protocolVersion":1,"requestId":"r2","token":"...","operation":"premiere.adapters.catalog","args":{}}
{"protocolVersion":1,"requestId":"r3","token":"...","operation":"premiere.adapter.invoke","args":{"adapterId":"premiere.workspace.editing","adapterVersion":1,"hostBuild":"26.3.2.1","locale":"ko-KR","uiFingerprint":"sha256:..."}}
```

There is no raw UI Automation catalog or generic invoke operation. The current registry uses targeted `FindFirst` lookups along a compiled ancestor chain and exposes only adapters that match the live foreground UI.

Run tests with:

```powershell
dotnet test .\tests\PremiereMcp.WindowsUiAgent.Tests.csproj
```
