using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Windows;
using System.IO;

namespace PremiereMcp.WindowsUiAgent;

internal static class ApprovalBroker
{
    private static readonly JsonSerializerOptions JsonOptions = new() { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping, WriteIndented = true };
    private static readonly Regex PlanHashPattern = new("^sha256:[a-f0-9]{64}$", RegexOptions.CultureInvariant);
    private static readonly Regex DigestPattern = new("^[A-Za-z0-9_-]{43}$", RegexOptions.CultureInvariant);

    internal static void Approve(string approvalId, string automationMode)
    {
        if (!string.Equals(automationMode, "interactive", StringComparison.Ordinal))
            throw new InvalidOperationException("Per-operation approval is available only in interactive mode.");
        if (!Guid.TryParse(approvalId, out var parsed) || parsed.ToString() != approvalId.ToLowerInvariant()) throw new ArgumentException("Approval id is invalid.");
        var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PremiereMCP", "approvals");
        SecretStore.EnsureCurrentUserDirectory(directory);
        var pendingPath = Path.Combine(directory, $"pending-{approvalId}.json");
        var approvedPath = Path.Combine(directory, $"approved-{approvalId}.json");
        if (new FileInfo(pendingPath).Length > 256 * 1024) throw new InvalidDataException("Approval record is too large.");
        var envelope = JsonNode.Parse(File.ReadAllText(pendingPath))?.AsObject() ?? throw new InvalidDataException("Approval envelope is invalid.");
        RejectUnknown(envelope, "approval envelope", "payload", "signature");
        var payloadText = envelope["payload"]?.GetValue<string>() ?? throw new InvalidDataException("Approval payload is missing.");
        var signature = envelope["signature"]?.GetValue<string>() ?? throw new InvalidDataException("Approval signature is missing.");
        if (!BrokerSecurity.Verify("approval-hmac", payloadText, signature)) throw new UnauthorizedAccessException("Approval signature is invalid.");
        var payload = JsonNode.Parse(SecretStore.UnprotectText("approval-payload", payloadText))?.AsObject() ?? throw new InvalidDataException("Approval payload is invalid.");
        if (payload["version"]?.GetValue<int>() != 2)
        {
            File.Delete(pendingPath);
            throw new InvalidDataException("Legacy approval records cannot be approved.");
        }
        ValidateVersionTwoPayload(payload, approvalId);
        var expiresAt = RequiredLong(payload, "expiresAt");
        if (expiresAt < DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) { File.Delete(pendingPath); throw new InvalidOperationException("Approval request has expired."); }

        var actionId = RequiredString(payload, "actionId");
        var operationId = RequiredString(payload, "operationId");
        var planHash = RequiredString(payload, "planHash");
        var route = payload["route"]!.AsObject();
        var summaryObject = payload["summary"]!.AsObject();
        var backend = RequiredString(route, "backend");
        var risk = RequiredString(summaryObject, "risk");
        var request = payload["request"]?.ToJsonString(JsonOptions) ?? "{}";
        var message = $"A local MCP client requests a Premiere Pro operation.\n\nOperation: {operationId}\nAction: {actionId}\nBackend: {backend}\nRisk: {risk}\nExpires: {DateTimeOffset.FromUnixTimeMilliseconds(expiresAt):O}\nPlan: {planHash[..19]}...\n\nExact request:\n{request}\n\nApprove this exact plan and route one time?";
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

    internal static void ValidateVersionTwoPayload(JsonObject payload, string approvalId)
    {
        RejectUnknown(payload, "approval payload",
            "version", "approvalId", "state", "operationId", "actionId", "planHash", "route", "requestDigest",
            "request", "summary", "issuedAt", "expiresAt", "approvedAt", "nonce");
        if (payload["version"]?.GetValue<int>() != 2) throw new InvalidDataException("Legacy approval records cannot be approved.");
        if (RequiredString(payload, "state") != "pending" || RequiredString(payload, "approvalId") != approvalId)
            throw new InvalidDataException("Approval request is not pending.");
        _ = RequiredNonEmptyString(payload, "operationId", 256);
        var actionId = RequiredNonEmptyString(payload, "actionId", 256);
        var planHash = RequiredString(payload, "planHash");
        if (!PlanHashPattern.IsMatch(planHash)) throw new InvalidDataException("Approval planHash is invalid.");
        if (!DigestPattern.IsMatch(RequiredString(payload, "requestDigest"))) throw new InvalidDataException("Approval request digest is invalid.");
        _ = RequiredNonEmptyString(payload, "nonce", 256);

        var route = RequiredObject(payload, "route");
        RejectUnknown(route, "approval route", "backend", "hostVersion", "hostSessionId", "capabilityFingerprint");
        var backend = RequiredString(route, "backend");
        if (backend is not ("local" or "uxp" or "cep" or "qe" or "ui")) throw new InvalidDataException("Approval backend is invalid.");
        RequireNullableString(route, "hostVersion");
        RequireNullableString(route, "hostSessionId");
        RequireNullableString(route, "capabilityFingerprint");

        var request = RequiredObject(payload, "request");
        RejectUnknown(request, "approval request", "actionId", "target", "args", "expectedRevision");
        if (RequiredString(request, "actionId") != actionId) throw new InvalidDataException("Approval request action does not match.");
        if (!request.ContainsKey("target") || request["target"] is not null and not JsonObject) throw new InvalidDataException("Approval target is invalid.");
        _ = RequiredObject(request, "args");
        RequireNullableString(request, "expectedRevision");

        var summary = RequiredObject(payload, "summary");
        RejectUnknown(summary, "approval summary", "title", "risk", "mutatesProject", "undoable", "backend");
        _ = RequiredNonEmptyString(summary, "title", 1024);
        _ = RequiredNonEmptyString(summary, "risk", 16);
        _ = RequiredBoolean(summary, "mutatesProject");
        _ = RequiredBoolean(summary, "undoable");
        if (RequiredString(summary, "backend") != backend) throw new InvalidDataException("Approval summary backend does not match the exact route.");

        var issuedAt = RequiredLong(payload, "issuedAt");
        var expiresAt = RequiredLong(payload, "expiresAt");
        if (issuedAt <= 0 || expiresAt <= issuedAt) throw new InvalidDataException("Approval validity window is invalid.");
        if (!payload.ContainsKey("approvedAt") || payload["approvedAt"] is not null) throw new InvalidDataException("Pending approval already has an approval timestamp.");
    }

    private static JsonObject RequiredObject(JsonObject value, string name) =>
        value[name] as JsonObject ?? throw new InvalidDataException($"{name} must be an object.");

    private static string RequiredString(JsonObject value, string name) =>
        value[name]?.GetValue<string>() ?? throw new InvalidDataException($"{name} must be a string.");

    private static string RequiredNonEmptyString(JsonObject value, string name, int maxLength)
    {
        var result = RequiredString(value, name);
        if (string.IsNullOrWhiteSpace(result) || result.Length > maxLength) throw new InvalidDataException($"{name} is invalid.");
        return result;
    }

    private static long RequiredLong(JsonObject value, string name) =>
        value[name]?.GetValue<long>() ?? throw new InvalidDataException($"{name} must be an integer.");

    private static bool RequiredBoolean(JsonObject value, string name) =>
        value[name]?.GetValue<bool>() ?? throw new InvalidDataException($"{name} must be boolean.");

    private static void RequireNullableString(JsonObject value, string name)
    {
        if (!value.ContainsKey(name)) throw new InvalidDataException($"{name} is required.");
        if (value[name] is not null) _ = value[name]!.GetValue<string>();
    }

    private static void RejectUnknown(JsonObject value, string label, params string[] allowedNames)
    {
        var allowed = allowedNames.ToHashSet(StringComparer.Ordinal);
        if (value.Any(property => !allowed.Contains(property.Key))) throw new InvalidDataException($"{label} contains an unknown field.");
    }
}
