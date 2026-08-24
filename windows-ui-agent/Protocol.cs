using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace PremiereMcp.WindowsUiAgent;

public sealed record ProtocolRequest(
    int ProtocolVersion,
    string? RequestId,
    string? Token,
    string? Operation,
    JsonElement Args,
    RouteBinding? RouteBinding = null,
    string? PlanHash = null,
    string? BoundOperation = null,
    string? ExpectedRevision = null,
    string? EffectiveRequestDigest = null);

public sealed record RouteBinding(
    string? Backend,
    string? HostVersion,
    string? HostSessionId,
    string? CapabilityFingerprint);

public sealed record ProtocolError(string Code, string Message, bool? Retryable = null);

public sealed record ProtocolResponse(
    int ProtocolVersion,
    string? RequestId,
    bool Ok,
    object? Result,
    ProtocolError? Error)
{
    public static ProtocolResponse Success(string? requestId, object result) =>
        new(1, requestId, true, result, null);

    public static ProtocolResponse Failure(string? requestId, string code, string message, bool? retryable = null) =>
        new(1, requestId, false, null, new ProtocolError(code, message, retryable));
}

public sealed class MessageTooLargeException : Exception;

public static class JsonLineProtocol
{
    private static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public static string? ReadLine(Stream stream, int maxBytes)
    {
        using var buffer = new MemoryStream(Math.Min(maxBytes, 4096));
        while (true)
        {
            var value = stream.ReadByte();
            if (value < 0)
            {
                return buffer.Length == 0 ? null : Decode(buffer);
            }

            if (value == '\n')
            {
                return Decode(buffer);
            }

            if (buffer.Length >= maxBytes)
            {
                throw new MessageTooLargeException();
            }

            buffer.WriteByte((byte)value);
        }
    }

    public static void WriteResponse(Stream stream, ProtocolResponse response)
    {
        var payload = JsonSerializer.SerializeToUtf8Bytes(response, SerializerOptions);
        stream.Write(payload);
        stream.WriteByte((byte)'\n');
        stream.Flush();
    }

    private static string Decode(MemoryStream buffer)
    {
        var bytes = buffer.ToArray();
        var length = bytes.Length;
        if (length > 0 && bytes[length - 1] == '\r')
        {
            length--;
        }

        return new UTF8Encoding(false, true).GetString(bytes, 0, length);
    }
}

public sealed class RequestDispatcher
{
    internal const string AgentVersion = "1.0.0";
    private const string CapabilityFingerprintMaterial = "premiere-mcp-windows-ui|protocol:1|health|premiere.window.inspect|premiere.controls.catalog|ui.control.invoke";
    private static readonly HashSet<string> AllowedOperations = new(StringComparer.Ordinal)
    {
        "health",
        "premiere.window.inspect",
        "premiere.controls.catalog",
        "ui.control.invoke"
    };

    private readonly string _token;
    private readonly IPremiereAutomation _automation;
    private readonly string _agentSessionId;
    private readonly string _capabilityFingerprint;

    public RequestDispatcher(string token, IPremiereAutomation automation, string? agentSessionId = null)
    {
        _token = token;
        _automation = automation;
        _agentSessionId = string.IsNullOrWhiteSpace(agentSessionId) ? Guid.NewGuid().ToString("D") : agentSessionId;
        _capabilityFingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(CapabilityFingerprintMaterial))).ToLowerInvariant();
    }

    public ProtocolResponse Dispatch(string json)
    {
        ProtocolRequest? request;
        try
        {
            request = JsonSerializer.Deserialize<ProtocolRequest>(json, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        }
        catch (JsonException)
        {
            return ProtocolResponse.Failure(null, "invalid_json", "Request must be valid JSON.");
        }

        if (request is null || string.IsNullOrWhiteSpace(request.RequestId))
        {
            return ProtocolResponse.Failure(request?.RequestId, "invalid_request", "requestId is required.");
        }

        if (request.ProtocolVersion != 1)
        {
            return ProtocolResponse.Failure(request.RequestId, "unsupported_protocol", "protocolVersion must be 1.");
        }

        if (!TokenComparer.EqualsFixedTime(_token, request.Token))
        {
            return ProtocolResponse.Failure(request.RequestId, "unauthorized", "Invalid session token.");
        }

        if (request.Operation is null || !AllowedOperations.Contains(request.Operation))
        {
            return ProtocolResponse.Failure(request.RequestId, "operation_not_allowed", "Operation is not allowlisted.");
        }

        if (request.Operation == "ui.control.invoke")
        {
            try
            {
                _ = ParseInvokeArgs(request.Args);
            }
            catch (RequestValidationException ex)
            {
                return ProtocolResponse.Failure(request.RequestId, "invalid_args", ex.Message);
            }
            var routeFailure = ValidateMutationRoute(request);
            if (routeFailure is not null) return routeFailure;
        }

        try
        {
            var result = request.Operation switch
            {
                "health" => new
                {
                    status = "ok",
                    agent = "premiere-mcp-windows-ui",
                    protocolVersion = 1,
                    agentVersion = AgentVersion,
                    agentSessionId = _agentSessionId,
                    capabilityFingerprint = _capabilityFingerprint,
                    mutatingOperationsRequirePremiereForeground = true
                },
                "premiere.window.inspect" => _automation.InspectWindow(),
                "premiere.controls.catalog" => _automation.CatalogControls(ParseCatalogArgs(request.Args)),
                "ui.control.invoke" => _automation.InvokeControl(ParseInvokeArgs(request.Args)),
                _ => throw new InvalidOperationException("Unreachable operation.")
            };
            return ProtocolResponse.Success(request.RequestId, result);
        }
        catch (RequestValidationException ex)
        {
            return ProtocolResponse.Failure(request.RequestId, "invalid_args", ex.Message);
        }
        catch (PremiereNotForegroundException ex)
        {
            return ProtocolResponse.Failure(request.RequestId, "premiere_not_foreground", ex.Message);
        }
        catch (ControlNotFoundException ex)
        {
            return ProtocolResponse.Failure(request.RequestId, "control_not_found", ex.Message);
        }
        catch (ControlActionException ex)
        {
            return ProtocolResponse.Failure(request.RequestId, "control_action_failed", ex.Message);
        }
        catch (AutomationOperationException ex)
        {
            return ProtocolResponse.Failure(request.RequestId, ex.Code, ex.Message, ex.Retryable);
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.Runtime.InteropServices.COMException)
        {
            return ProtocolResponse.Failure(request.RequestId, "automation_error", "Windows UI Automation could not complete the operation.");
        }
    }

    private ProtocolResponse? ValidateMutationRoute(ProtocolRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.PlanHash) || !IsPlanHash(request.PlanHash))
            return ProtocolResponse.Failure(request.RequestId, "plan_hash_required", "Mutating UI operations require a SHA-256 execution plan hash.");
        var route = request.RouteBinding;
        if (route is null ||
            !string.Equals(route.Backend, "ui", StringComparison.Ordinal) ||
            !string.Equals(route.HostVersion, AgentVersion, StringComparison.Ordinal) ||
            !string.Equals(route.HostSessionId, _agentSessionId, StringComparison.Ordinal) ||
            !string.Equals(route.CapabilityFingerprint, _capabilityFingerprint, StringComparison.Ordinal))
            return ProtocolResponse.Failure(request.RequestId, "route_binding_mismatch", "UI agent session or capability binding changed before mutation dispatch.", true);
        if (!string.Equals(request.BoundOperation, "ui.invoke", StringComparison.Ordinal) ||
            string.IsNullOrWhiteSpace(request.EffectiveRequestDigest) ||
            !IsPlanHash(request.EffectiveRequestDigest) ||
            !FixedTimeTextEquals(request.EffectiveRequestDigest, EffectiveRequestDigest(request)))
            return ProtocolResponse.Failure(request.RequestId, "effective_request_binding_mismatch", "UI mutation arguments do not match the authorized effective request digest.");
        return null;
    }

    private static bool IsPlanHash(string value) =>
        value.Length == 71 && value.StartsWith("sha256:", StringComparison.Ordinal) && value[7..].All(Uri.IsHexDigit);

    private static string EffectiveRequestDigest(ProtocolRequest request)
    {
        // ui.control.invoke has a strict four-string argument schema, so this
        // reproduces the server's sorted-key canonical JSON without accepting
        // a broader cross-process serialization surface.
        var values = request.Args.EnumerateObject().ToDictionary(property => property.Name, property => property.Value.GetString(), StringComparer.Ordinal);
        var args = "{" + string.Join(",", values.OrderBy(entry => entry.Key, StringComparer.Ordinal)
            .Select(entry => JsonSerializer.Serialize(entry.Key) + ":" + JsonSerializer.Serialize(entry.Value))) + "}";
        var expectedRevision = request.ExpectedRevision is null ? "null" : JsonSerializer.Serialize(request.ExpectedRevision);
        var material = "{\"args\":" + args + ",\"expectedRevision\":" + expectedRevision + ",\"operation\":\"ui.invoke\"}";
        return "sha256:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(material))).ToLowerInvariant();
    }

    private static bool FixedTimeTextEquals(string left, string right)
    {
        var leftBytes = Encoding.ASCII.GetBytes(left.ToLowerInvariant());
        var rightBytes = Encoding.ASCII.GetBytes(right.ToLowerInvariant());
        return leftBytes.Length == rightBytes.Length && CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
    }

    private static ControlInvokeArgs ParseInvokeArgs(JsonElement args)
    {
        if (args.ValueKind != JsonValueKind.Object)
        {
            throw new RequestValidationException("args must be an object.");
        }

        var allowedProperties = new HashSet<string>(StringComparer.Ordinal)
        {
            "capability", "automationId", "controlType", "action"
        };
        if (args.EnumerateObject().Any(property => !allowedProperties.Contains(property.Name)))
        {
            throw new RequestValidationException("args contains a property that is not allowlisted.");
        }

        var capability = RequiredString(args, "capability", 64);
        if (capability.Length != 64 || capability.Any(character => !Uri.IsHexDigit(character))) throw new RequestValidationException("capability must be a 64-character hexadecimal value issued by ui.catalog.");
        var automationId = RequiredString(args, "automationId", 256);
        var controlType = RequiredString(args, "controlType", 64);
        var action = RequiredString(args, "action", 64);
        return new ControlInvokeArgs(capability.ToLowerInvariant(), automationId, controlType, action);
    }

    private static ControlCatalogArgs ParseCatalogArgs(JsonElement args)
    {
        if (args.ValueKind != JsonValueKind.Object) throw new RequestValidationException("args must be an object.");
        var allowedProperties = new HashSet<string>(StringComparer.Ordinal) { "offset", "limit" };
        if (args.EnumerateObject().Any(property => !allowedProperties.Contains(property.Name))) throw new RequestValidationException("args contains a property that is not allowlisted.");
        var offset = args.TryGetProperty("offset", out var offsetValue) && offsetValue.TryGetInt32(out var parsedOffset) ? parsedOffset : 0;
        var limit = args.TryGetProperty("limit", out var limitValue) && limitValue.TryGetInt32(out var parsedLimit) ? parsedLimit : 200;
        if (offset < 0 || limit is < 1 or > 500) throw new RequestValidationException("offset must be non-negative and limit must be between 1 and 500.");
        return new ControlCatalogArgs(offset, limit);
    }

    private static string RequiredString(JsonElement args, string property, int maxLength)
    {
        if (!args.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.String)
        {
            throw new RequestValidationException($"{property} must be a string.");
        }

        var result = value.GetString();
        if (string.IsNullOrWhiteSpace(result) || result.Length > maxLength)
        {
            throw new RequestValidationException($"{property} must contain 1 to {maxLength} characters.");
        }

        return result;
    }
}

public sealed class RequestValidationException(string message) : Exception(message);
public sealed class PremiereNotForegroundException(string message) : Exception(message);
public sealed class ControlNotFoundException(string message) : Exception(message);
public sealed class ControlActionException(string message) : Exception(message);
