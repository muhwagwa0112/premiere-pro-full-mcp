using System.Text.Json;
using System.Text.Json.Serialization;

namespace PremiereMcp.WindowsUiAgent;

internal sealed record UiaWorkerRequest(int ProtocolVersion, string Operation, JsonElement Args);

internal sealed record UiaWorkerResponse(
    int ProtocolVersion,
    bool Ok,
    object? Result,
    ProtocolError? Error)
{
    internal static UiaWorkerResponse Success(object result) => new(1, true, result, null);
    internal static UiaWorkerResponse Failure(string code, string message, bool retryable = false) =>
        new(1, false, null, new ProtocolError(code, message, retryable));
}

internal static class UiaWorkerJson
{
    internal static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };
}

public sealed class AutomationOperationException(string code, string message, bool retryable) : Exception(message)
{
    public string Code { get; } = code;
    public bool Retryable { get; } = retryable;
}
