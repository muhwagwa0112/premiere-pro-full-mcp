using System.IO;
using System.Text;
using System.Text.Json;
using PremiereMcp.WindowsUiAgent;
using Xunit;

namespace PremiereMcp.WindowsUiAgent.Tests;

public sealed class ProtocolTests
{
    [Fact]
    public void RejectsInvalidTokenBeforeDispatch()
    {
        var automation = new FakeAutomation();
        var response = new RequestDispatcher("secret", automation).Dispatch(Request("wrong", "health"));

        Assert.False(response.Ok);
        Assert.Equal("unauthorized", response.Error?.Code);
        Assert.Equal(0, automation.CallCount);
    }

    [Fact]
    public void RejectsUnknownOperation()
    {
        var response = new RequestDispatcher("secret", new FakeAutomation()).Dispatch(Request("secret", "shell.exec"));

        Assert.False(response.Ok);
        Assert.Equal("operation_not_allowed", response.Error?.Code);
    }

    [Fact]
    public void RejectsNonSemanticInvokeArgs()
    {
        var json = """{"protocolVersion":1,"requestId":"r1","token":"secret","operation":"ui.control.invoke","args":{"selector":"#x","action":"click"}}""";
        var response = new RequestDispatcher("secret", new FakeAutomation()).Dispatch(json);

        Assert.False(response.Ok);
        Assert.Equal("invalid_args", response.Error?.Code);
    }

    [Fact]
    public void RejectsExtraInvokeProperties()
    {
        var json = """{"protocolVersion":1,"requestId":"r1","token":"secret","operation":"ui.control.invoke","args":{"capability":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","automationId":"exportButton","controlType":"Button","action":"invoke","selector":"#x"}}""";
        var response = new RequestDispatcher("secret", new FakeAutomation()).Dispatch(json);

        Assert.False(response.Ok);
        Assert.Equal("invalid_args", response.Error?.Code);
    }

    [Fact]
    public void DispatchesAllowlistedSemanticInvoke()
    {
        var automation = new FakeAutomation();
        var dispatcher = new RequestDispatcher("secret", automation, "agent-session-a");
        var response = dispatcher.Dispatch(InvokeRequest("secret", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", BindingFor(dispatcher)));

        Assert.True(response.Ok);
        Assert.Equal(new ControlInvokeArgs(new string('a', 64), "exportButton", "Button", "invoke"), automation.LastArgs);
    }

    [Fact]
    public void HealthPublishesStableSessionVersionAndCapabilityBinding()
    {
        var dispatcher = new RequestDispatcher("secret", new FakeAutomation(), "agent-session-a");

        var first = dispatcher.Dispatch(Request("secret", "health"));
        var second = dispatcher.Dispatch(Request("secret", "health"));

        Assert.True(first.Ok);
        Assert.True(second.Ok);
        using var firstHealth = JsonDocument.Parse(JsonSerializer.Serialize(first.Result));
        using var secondHealth = JsonDocument.Parse(JsonSerializer.Serialize(second.Result));
        Assert.Equal(RequestDispatcher.AgentVersion, firstHealth.RootElement.GetProperty("agentVersion").GetString());
        Assert.Equal("agent-session-a", firstHealth.RootElement.GetProperty("agentSessionId").GetString());
        Assert.Equal(firstHealth.RootElement.GetProperty("capabilityFingerprint").GetString(), secondHealth.RootElement.GetProperty("capabilityFingerprint").GetString());
    }

    [Fact]
    public void RejectsMutationWithoutPlanHashAndExactAgentRouteBinding()
    {
        var automation = new FakeAutomation();
        var dispatcher = new RequestDispatcher("secret", automation, "agent-session-a");
        var missing = dispatcher.Dispatch(InvokeRequest("secret", null, null));
        var stale = dispatcher.Dispatch(InvokeRequest("secret", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", BindingFor(new RequestDispatcher("secret", new FakeAutomation(), "agent-session-b"))));

        Assert.Equal("plan_hash_required", missing.Error?.Code);
        Assert.Equal("route_binding_mismatch", stale.Error?.Code);
        Assert.Equal(0, automation.CallCount);
    }

    [Fact]
    public void RejectsMutationWhoseEffectiveArgumentsDoNotMatchTheAuthorizedDigest()
    {
        var automation = new FakeAutomation();
        var dispatcher = new RequestDispatcher("secret", automation, "agent-session-a");
        var response = dispatcher.Dispatch(InvokeRequest(
            "secret",
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            BindingFor(dispatcher),
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"));

        Assert.False(response.Ok);
        Assert.Equal("effective_request_binding_mismatch", response.Error?.Code);
        Assert.Equal(0, automation.CallCount);
    }

    [Fact]
    public void RejectsRouteBindingFromRestartedAgentBeforeMutation()
    {
        var original = new RequestDispatcher("secret", new FakeAutomation(), "agent-session-a");
        var restartedAutomation = new FakeAutomation();
        var restarted = new RequestDispatcher("secret", restartedAutomation, "agent-session-b");
        var staleRoute = BindingFor(original);

        var response = restarted.Dispatch(InvokeRequest("secret", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", staleRoute));

        Assert.False(response.Ok);
        Assert.Equal("route_binding_mismatch", response.Error?.Code);
        Assert.Equal(0, restartedAutomation.CallCount);
    }

    [Fact]
    public void DispatchesBoundedSemanticCatalog()
    {
        var automation = new FakeAutomation();
        var json = """{"protocolVersion":1,"requestId":"r1","token":"secret","operation":"premiere.controls.catalog","args":{"offset":10,"limit":50}}""";
        var response = new RequestDispatcher("secret", automation).Dispatch(json);

        Assert.True(response.Ok);
        Assert.Equal(new ControlCatalogArgs(10, 50), automation.LastCatalogArgs);
    }

    [Fact]
    public void PreservesAutomationTimeoutRetryability()
    {
        var response = new RequestDispatcher("secret", new ThrowingAutomation()).Dispatch(Request("secret", "premiere.window.inspect"));

        Assert.False(response.Ok);
        Assert.Equal("automation_timeout", response.Error?.Code);
        Assert.True(response.Error?.Retryable);
    }

    [Fact]
    public void PreservesUnknownMutationOutcomeAsNonRetryable()
    {
        var dispatcher = new RequestDispatcher("secret", new ThrowingMutationAutomation(), "agent-session-a");
        var response = dispatcher.Dispatch(InvokeRequest("secret", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", BindingFor(dispatcher)));

        Assert.False(response.Ok);
        Assert.Equal("automation_outcome_unknown", response.Error?.Code);
        Assert.False(response.Error?.Retryable);
    }

    [Fact]
    public void EnforcesMessageLimit()
    {
        using var stream = new MemoryStream("12345\n"u8.ToArray());
        Assert.Throws<MessageTooLargeException>(() => JsonLineProtocol.ReadLine(stream, 4));
    }

    [Fact]
    public void HmacBrokerReadsRedirectedInputAsStrictUtf8()
    {
        const string value = "복원 비디오 트랙";
        using var stream = new MemoryStream(Encoding.UTF8.GetBytes(value));

        Assert.Equal(value, Program.ReadBoundedUtf8(stream));
    }

    [Fact]
    public void HmacBrokerRejectsInvalidUtf8()
    {
        using var stream = new MemoryStream(new byte[] { 0xc3, 0x28 });
        Assert.Throws<DecoderFallbackException>(() => Program.ReadBoundedUtf8(stream));
    }

    private static string Request(string token, string operation) => JsonSerializer.Serialize(new
    {
        protocolVersion = 1,
        requestId = "r1",
        token,
        operation,
        args = new { }
    });

    private static JsonElement BindingFor(RequestDispatcher dispatcher)
    {
        var health = dispatcher.Dispatch(Request("secret", "health"));
        Assert.True(health.Ok);
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(health.Result));
        return JsonSerializer.SerializeToElement(new
        {
            backend = "ui",
            hostVersion = document.RootElement.GetProperty("agentVersion").GetString(),
            hostSessionId = document.RootElement.GetProperty("agentSessionId").GetString(),
            capabilityFingerprint = document.RootElement.GetProperty("capabilityFingerprint").GetString()
        });
    }

    private static string InvokeRequest(string token, string? planHash, object? routeBinding, string? effectiveRequestDigest = null) => JsonSerializer.Serialize(new
    {
        protocolVersion = 1,
        requestId = "r1",
        token,
        operation = "ui.control.invoke",
        args = new { capability = new string('a', 64), automationId = "exportButton", controlType = "Button", action = "invoke" },
        planHash,
        routeBinding,
        boundOperation = "ui.invoke",
        effectiveRequestDigest = effectiveRequestDigest ?? ValidInvokeDigest()
    });

    private static string ValidInvokeDigest()
    {
        var material = $"{{\"args\":{{\"action\":\"invoke\",\"automationId\":\"exportButton\",\"capability\":\"{new string('a', 64)}\",\"controlType\":\"Button\"}},\"expectedRevision\":null,\"operation\":\"ui.invoke\"}}";
        return "sha256:" + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(material))).ToLowerInvariant();
    }

    private sealed class FakeAutomation : IPremiereAutomation
    {
        public int CallCount { get; private set; }
        public ControlInvokeArgs? LastArgs { get; private set; }
        public ControlCatalogArgs? LastCatalogArgs { get; private set; }

        public object InspectWindow()
        {
            CallCount++;
            return new { };
        }

        public object CatalogControls(ControlCatalogArgs args)
        {
            CallCount++;
            LastCatalogArgs = args;
            return new { controls = Array.Empty<object>() };
        }

        public object InvokeControl(ControlInvokeArgs args)
        {
            CallCount++;
            LastArgs = args;
            return new { invoked = true };
        }
    }

    private sealed class ThrowingAutomation : IPremiereAutomation
    {
        public object InspectWindow() => throw new AutomationOperationException("automation_timeout", "timed out", true);
        public object CatalogControls(ControlCatalogArgs args) => throw new NotSupportedException();
        public object InvokeControl(ControlInvokeArgs args) => throw new NotSupportedException();
    }

    private sealed class ThrowingMutationAutomation : IPremiereAutomation
    {
        public object InspectWindow() => throw new NotSupportedException();
        public object CatalogControls(ControlCatalogArgs args) => throw new NotSupportedException();
        public object InvokeControl(ControlInvokeArgs args) => throw new AutomationOperationException("automation_outcome_unknown", "unknown", false);
    }
}
