using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using System.IO;

namespace PremiereMcp.WindowsUiAgent;

internal static class ApprovalBroker
{
    private static readonly JsonSerializerOptions JsonOptions = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping, WriteIndented = true };

    internal static void Approve(string approvalId)
    {
        if (!Guid.TryParse(approvalId, out var parsed) || parsed.ToString() != approvalId.ToLowerInvariant()) throw new ArgumentException("Approval id is invalid.");
        var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PremiereMCP", "approvals");
        SecretStore.EnsureCurrentUserDirectory(directory);
        var pendingPath = Path.Combine(directory, $"pending-{approvalId}.json");
        var approvedPath = Path.Combine(directory, $"approved-{approvalId}.json");
        if (new FileInfo(pendingPath).Length > 256 * 1024) throw new InvalidDataException("Approval record is too large.");
        var envelope = JsonNode.Parse(File.ReadAllText(pendingPath))?.AsObject() ?? throw new InvalidDataException("Approval envelope is invalid.");
        var payloadText = envelope["payload"]?.GetValue<string>() ?? throw new InvalidDataException("Approval payload is missing.");
        var signature = envelope["signature"]?.GetValue<string>() ?? throw new InvalidDataException("Approval signature is missing.");
        if (!BrokerSecurity.Verify("approval-hmac", payloadText, signature)) throw new UnauthorizedAccessException("Approval signature is invalid.");
        var payload = JsonNode.Parse(SecretStore.UnprotectText("approval-payload", payloadText))?.AsObject() ?? throw new InvalidDataException("Approval payload is invalid.");
        if (payload["version"]?.GetValue<int>() != 1 || payload["state"]?.GetValue<string>() != "pending" || payload["approvalId"]?.GetValue<string>() != approvalId)
            throw new InvalidDataException("Approval request is not pending.");
        var expiresAt = payload["expiresAt"]?.GetValue<long>() ?? 0;
        if (expiresAt < DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) { File.Delete(pendingPath); throw new InvalidOperationException("Approval request has expired."); }

        var actionId = payload["actionId"]?.GetValue<string>() ?? "unknown";
        var summary = payload["summary"]?.ToJsonString(JsonOptions) ?? "{}";
        var request = payload["request"]?.ToJsonString(JsonOptions) ?? "{}";
        var message = $"A local MCP client requests a Premiere Pro operation.\n\nAction: {actionId}\nExpires: {DateTimeOffset.FromUnixTimeMilliseconds(expiresAt):O}\n\nSummary:\n{summary}\n\nExact request:\n{request}\n\nApprove this exact request one time?";
        if (message.Length > 16_000) throw new InvalidDataException("Approval display exceeds the safe limit.");
        var result = MessageBox.Show(message, "Premiere MCP approval", MessageBoxButton.YesNo, MessageBoxImage.Warning, MessageBoxResult.No, MessageBoxOptions.DefaultDesktopOnly);
        if (result != MessageBoxResult.Yes) { File.Delete(pendingPath); throw new OperationCanceledException("Approval was declined by the local user."); }

        payload["state"] = "approved";
        payload["approvedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var approvedPayload = SecretStore.ProtectText("approval-payload", payload.ToJsonString(JsonOptions));
        var approvedEnvelope = new JsonObject { ["payload"] = approvedPayload, ["signature"] = BrokerSecurity.Sign("approval-hmac", approvedPayload) };
        var temporary = approvedPath + "." + Environment.ProcessId + ".tmp";
        File.WriteAllText(temporary, approvedEnvelope.ToJsonString(JsonOptions));
        try { File.Move(temporary, approvedPath, false); }
        catch { File.Delete(temporary); throw; }
        File.Delete(pendingPath);
    }
}
