# Premiere MCP Windows UI Agent

Local Windows-only fallback agent for Premiere Pro controls that are not exposed by UXP or ExtendScript. It intentionally exposes only three operations over a current-user-only named pipe:

- `health`
- `premiere.window.inspect`
- `ui.control.invoke`

The agent does not accept arbitrary selectors, coordinates, clicks, scripts, or shell commands. Mutating control actions require Adobe Premiere Pro to be the foreground process. Targets must use an exact UI Automation `automationId` and allowlisted `controlType`; ambiguous matches are rejected.

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

Semantic invocation example:

```json
{"protocolVersion":1,"requestId":"r2","token":"...","operation":"ui.control.invoke","args":{"automationId":"knownButtonId","controlType":"Button","action":"invoke"}}
```

Allowed control types are `Button`, `MenuItem`, `CheckBox`, `RadioButton`, `ListItem`, and `TabItem`. Allowed actions are `invoke`, `toggle`, and `select`; the target must support the matching UI Automation pattern.

Run tests with:

```powershell
dotnet test .\tests\PremiereMcp.WindowsUiAgent.Tests.csproj
```
