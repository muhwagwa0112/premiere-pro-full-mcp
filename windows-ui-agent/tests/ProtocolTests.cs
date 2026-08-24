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
    public void RejectsRemovedRawControlInvokeOperation()
    {
        var json = """{"protocolVersion":1,"requestId":"r1","token":"secret","operation":"ui.control.invoke","args":{"selector":"#x","action":"click"}}""";
        var response = new RequestDispatcher("secret", new FakeAutomation()).Dispatch(json);

        Assert.False(response.Ok);
        Assert.Equal("operation_not_allowed", response.Error?.Code);
    }

    [Fact]
    public void RejectsRemovedRawCatalogOperation()
    {
        var json = """{"protocolVersion":1,"requestId":"r1","token":"secret","operation":"premiere.controls.catalog","args":{}}""";
        var response = new RequestDispatcher("secret", new FakeAutomation()).Dispatch(json);

        Assert.False(response.Ok);
        Assert.Equal("operation_not_allowed", response.Error?.Code);
    }

    [Fact]
    public void RejectsSelectorFieldsOnSemanticAdapterInvocation()
    {
        var json = JsonSerializer.Serialize(new
        {
            protocolVersion = 1,
            requestId = "r1",
            token = "secret",
            operation = "premiere.adapter.invoke",
            args = new { adapterId = "premiere.workspace.editing", adapterVersion = 1, hostBuild = "26.3.2.1", locale = "ko-KR", uiFingerprint = $"sha256:{new string('d', 64)}", selector = "*" }
        });
        var response = new RequestDispatcher("secret", new FakeAutomation()).Dispatch(json);

        Assert.False(response.Ok);
        Assert.Equal("invalid_args", response.Error?.Code);
    }

    [Fact]
    public void DispatchesRegisteredSemanticAdapterInvoke()
    {
        var automation = new FakeAutomation();
        var dispatcher = new RequestDispatcher("secret", automation, "agent-session-a");
        var response = dispatcher.Dispatch(InvokeRequest("secret", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", BindingFor(dispatcher)));

        Assert.True(response.Ok);
        Assert.Equal(AdapterArgs(), automation.LastArgs);
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
        Assert.Equal(1, firstHealth.RootElement.GetProperty("semanticAdapterProtocol").GetInt32());
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
    public void DispatchesTargetedSemanticAdapterCatalog()
    {
        var automation = new FakeAutomation();
        var json = """{"protocolVersion":1,"requestId":"r1","token":"secret","operation":"premiere.adapters.catalog","args":{}}""";
        var response = new RequestDispatcher("secret", automation).Dispatch(json);

        Assert.True(response.Ok);
        Assert.NotNull(automation.LastCatalogArgs);
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
        operation = "premiere.adapter.invoke",
        args = new
        {
            adapterId = "premiere.workspace.editing",
            adapterVersion = 1,
            hostBuild = "26.3.2.1",
            locale = "ko-KR",
            uiFingerprint = $"sha256:{new string('d', 64)}"
        },
        planHash,
        routeBinding,
        boundOperation = "ui.adapter.invoke",
        effectiveRequestDigest = effectiveRequestDigest ?? ValidInvokeDigest()
    });

    private static string ValidInvokeDigest()
    {
        var material = $"{{\"args\":{{\"adapterId\":\"premiere.workspace.editing\",\"adapterVersion\":1,\"hostBuild\":\"26.3.2.1\",\"locale\":\"ko-KR\",\"uiFingerprint\":\"sha256:{new string('d', 64)}\"}},\"expectedRevision\":null,\"operation\":\"ui.adapter.invoke\"}}";
        return "sha256:" + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(material))).ToLowerInvariant();
    }

    private static SemanticAdapterInvokeArgs AdapterArgs() => new(
        "premiere.workspace.editing", 1, "26.3.2.1", "ko-KR", $"sha256:{new string('d', 64)}");

    private sealed class FakeAutomation : IPremiereAutomation
    {
        public int CallCount { get; private set; }
        public SemanticAdapterInvokeArgs? LastArgs { get; private set; }
        public SemanticAdapterCatalogArgs? LastCatalogArgs { get; private set; }

        public object InspectWindow()
        {
            CallCount++;
            return new { };
        }

        public object CatalogAdapters(SemanticAdapterCatalogArgs args)
        {
            CallCount++;
            LastCatalogArgs = args;
            return new { controls = Array.Empty<object>() };
        }

        public object InvokeAdapter(SemanticAdapterInvokeArgs args)
        {
            CallCount++;
            LastArgs = args;
            return new { invoked = true };
        }
    }

    private sealed class ThrowingAutomation : IPremiereAutomation
    {
        public object InspectWindow() => throw new AutomationOperationException("automation_timeout", "timed out", true);
        public object CatalogAdapters(SemanticAdapterCatalogArgs args) => throw new NotSupportedException();
        public object InvokeAdapter(SemanticAdapterInvokeArgs args) => throw new NotSupportedException();
    }

    private sealed class ThrowingMutationAutomation : IPremiereAutomation
    {
        public object InspectWindow() => throw new NotSupportedException();
        public object CatalogAdapters(SemanticAdapterCatalogArgs args) => throw new NotSupportedException();
        public object InvokeAdapter(SemanticAdapterInvokeArgs args) => throw new AutomationOperationException("automation_outcome_unknown", "unknown", false);
    }
}
