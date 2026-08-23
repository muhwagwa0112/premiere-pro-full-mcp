using System.Diagnostics;
using System.IO;
using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace PremiereMcp.WindowsUiAgent;

public sealed class UiaWorkerClient : IPremiereAutomation
{
    private static readonly SemaphoreSlim Gate = new(1, 1);
    private static readonly TimeSpan InspectDeadline = TimeSpan.FromSeconds(4);
    // Premiere's UI Automation provider can spend several seconds returning from a
    // single cross-process TreeWalker call even after the catalog's own 8-second
    // traversal budget has elapsed. Keep the worker isolated, but leave enough
    // process-level headroom for that bounded traversal to unwind and serialize its
    // partial result. The named-pipe caller retains a separate 50-second cap.
    private static readonly TimeSpan CatalogDeadline = TimeSpan.FromSeconds(45);
    private static readonly TimeSpan InvokeDeadline = TimeSpan.FromSeconds(4);
    private static readonly TimeSpan CapabilityLifetime = TimeSpan.FromMinutes(2);
    private static readonly ConcurrentDictionary<string, CatalogCapability> Capabilities = new(StringComparer.Ordinal);

    public object InspectWindow() => Execute("premiere.window.inspect", new { }, InspectDeadline, false);
    public object CatalogControls(ControlCatalogArgs args) => AttachCapabilities(Execute("premiere.controls.catalog", args, CatalogDeadline, false));
    public object InvokeControl(ControlInvokeArgs args)
    {
        PurgeExpiredCapabilities();
        if (!Capabilities.TryRemove(args.Capability, out var capability) || capability.ExpiresAtUtc <= DateTimeOffset.UtcNow)
            throw new RequestValidationException("The ui.catalog capability is invalid, expired, or already used.");
        if (!string.Equals(capability.AutomationId, args.AutomationId, StringComparison.Ordinal) ||
            !string.Equals(capability.ControlType, args.ControlType, StringComparison.Ordinal) ||
            !capability.Actions.Contains(args.Action, StringComparer.Ordinal))
            throw new RequestValidationException("The ui.invoke request does not match the catalogued capability.");
        var bound = args with
        {
            ExpectedName = capability.Name,
            ExpectedProcessId = capability.ProcessId,
            ExpectedWindowHandle = capability.WindowHandle
        };
        return Execute("ui.control.invoke", bound, InvokeDeadline, true);
    }

    private static object AttachCapabilities(object value)
    {
        PurgeExpiredCapabilities();
        var element = value is JsonElement json ? json : JsonSerializer.SerializeToElement(value, UiaWorkerJson.Options);
        var root = JsonNode.Parse(element.GetRawText())?.AsObject() ?? throw new AutomationOperationException("automation_error", "UI catalog returned an invalid object.", false);
        var processId = root["processId"]?.GetValue<int>() ?? throw new AutomationOperationException("automation_error", "UI catalog omitted processId.", false);
        var windowHandle = root["windowHandle"]?.GetValue<long>() ?? throw new AutomationOperationException("automation_error", "UI catalog omitted windowHandle.", false);
        if (root["controls"] is not JsonArray controls) throw new AutomationOperationException("automation_error", "UI catalog omitted controls.", false);
        foreach (var node in controls)
        {
            if (node is not JsonObject control) continue;
            var automationId = control["automationId"]?.GetValue<string>();
            var controlType = control["controlType"]?.GetValue<string>();
            var name = control["name"]?.GetValue<string>();
            var actions = control["actions"]?.AsArray().Select(item => item?.GetValue<string>()).Where(item => item is not null).Cast<string>().ToArray() ?? Array.Empty<string>();
            if (string.IsNullOrWhiteSpace(automationId) || string.IsNullOrWhiteSpace(controlType) || name is null || actions.Length == 0) continue;
            var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
            var expires = DateTimeOffset.UtcNow.Add(CapabilityLifetime);
            Capabilities[token] = new CatalogCapability(processId, windowHandle, automationId, controlType, name, actions, expires);
            control["capability"] = token;
            control["expiresAt"] = expires.ToString("O");
        }
        return root;
    }

    private static void PurgeExpiredCapabilities()
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var pair in Capabilities) if (pair.Value.ExpiresAtUtc <= now) Capabilities.TryRemove(pair.Key, out _);
    }

    private static object Execute(string operation, object args, TimeSpan deadline, bool mutating)
    {
        if (!Gate.Wait(deadline)) throw Timeout(operation, mutating);
        try
        {
            var executable = Environment.ProcessPath ?? throw new AutomationOperationException(
                "automation_error", "UI helper process path is unavailable.", false);
            var start = new ProcessStartInfo
            {
                FileName = executable,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            start.ArgumentList.Add("--uia-worker");
            ScrubWorkerEnvironment(start.Environment);

            using var process = Process.Start(start) ?? throw new AutomationOperationException(
                "automation_error", "UI Automation worker could not be started.", false);
            using var lifetime = JobObjectLifetime.Attach(process);
            var stdoutTask = ReadBoundedAsync(process.StandardOutput.BaseStream);
            var stderrTask = ReadBoundedAsync(process.StandardError.BaseStream);
            var request = new UiaWorkerRequest(1, operation, JsonSerializer.SerializeToElement(args, UiaWorkerJson.Options));
            var payload = JsonSerializer.SerializeToUtf8Bytes(request, UiaWorkerJson.Options);
            if (payload.Length > Program.MaxMessageBytes) throw new AutomationOperationException(
                "automation_error", "UI Automation worker request exceeded 1 MiB.", false);
            process.StandardInput.BaseStream.Write(payload);
            process.StandardInput.Close();

            if (!process.WaitForExit(checked((int)deadline.TotalMilliseconds)))
            {
                try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
                process.WaitForExit(2_000);
                throw Timeout(operation, mutating);
            }

            var stdout = stdoutTask.GetAwaiter().GetResult();
            _ = stderrTask.GetAwaiter().GetResult();
            UiaWorkerResponse? response;
            try { response = JsonSerializer.Deserialize<UiaWorkerResponse>(stdout, UiaWorkerJson.Options); }
            catch (JsonException) { response = null; }
            if (response is null || response.ProtocolVersion != 1)
                throw new AutomationOperationException("automation_error", "UI Automation worker returned an invalid response.", false);
            if (!response.Ok)
                throw new AutomationOperationException(
                    response.Error?.Code ?? "automation_error",
                    response.Error?.Message ?? "UI Automation worker failed.",
                    response.Error?.Retryable ?? false);
            return response.Result ?? new { };
        }
        finally
        {
            Gate.Release();
        }
    }

    private static AutomationOperationException Timeout(string operation, bool mutating) => mutating
        ? new("automation_outcome_unknown", $"{operation} exceeded its hard deadline; the action may already have occurred and must not be retried automatically.", false)
        : new("automation_timeout", $"{operation} exceeded its hard deadline and its isolated worker was terminated.", true);

    private static void ScrubWorkerEnvironment(IDictionary<string, string?> environment)
    {
        foreach (var name in new[]
        {
            "PREMIERE_MCP_UI_TOKEN", "PREMIERE_MCP_UXP_TOKEN", "PREMIERE_MCP_SECRET_HELPER",
            "PREMIERE_MCP_APPROVED_ROOTS", "NODE_OPTIONS", "NODE_PATH"
        }) environment.Remove(name);
    }

    private static async Task<string> ReadBoundedAsync(Stream stream)
    {
        using var buffer = new MemoryStream();
        var chunk = new byte[8192];
        while (true)
        {
            var count = await stream.ReadAsync(chunk);
            if (count == 0) break;
            if (buffer.Length + count > Program.MaxMessageBytes)
                throw new AutomationOperationException("automation_error", "UI Automation worker response exceeded 1 MiB.", false);
            buffer.Write(chunk, 0, count);
        }
        return new System.Text.UTF8Encoding(false, true).GetString(buffer.ToArray());
    }

    private sealed record CatalogCapability(
        int ProcessId,
        long WindowHandle,
        string AutomationId,
        string ControlType,
        string Name,
        string[] Actions,
        DateTimeOffset ExpiresAtUtc);
}
