using System.Diagnostics;
using System.IO;
using System.Text.Json;

namespace PremiereMcp.WindowsUiAgent;

public sealed class UiaWorkerClient : IPremiereAutomation
{
    private static readonly SemaphoreSlim Gate = new(1, 1);
    private static readonly TimeSpan InspectDeadline = TimeSpan.FromSeconds(4);
    // Premiere's UI Automation provider can spend several seconds returning from a
    // single cross-process TreeWalker call even after the catalog's own 8-second
    // traversal budget has elapsed. Keep the worker isolated, but leave enough
    // process-level headroom for that bounded traversal to unwind and serialize its
    // partial result instead of killing it at the old 10-second boundary.
    private static readonly TimeSpan CatalogDeadline = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan InvokeDeadline = TimeSpan.FromSeconds(4);

    public object InspectWindow() => Execute("premiere.window.inspect", new { }, InspectDeadline, false);
    public object CatalogControls(ControlCatalogArgs args) => Execute("premiere.controls.catalog", args, CatalogDeadline, false);
    public object InvokeControl(ControlInvokeArgs args) => Execute("ui.control.invoke", args, InvokeDeadline, true);

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
}
