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
        var json = """{"protocolVersion":1,"requestId":"r1","token":"secret","operation":"ui.control.invoke","args":{"automationId":"exportButton","controlType":"Button","action":"invoke","selector":"#x"}}""";
        var response = new RequestDispatcher("secret", new FakeAutomation()).Dispatch(json);

        Assert.False(response.Ok);
        Assert.Equal("invalid_args", response.Error?.Code);
    }

    [Fact]
    public void DispatchesAllowlistedSemanticInvoke()
    {
        var automation = new FakeAutomation();
        var json = """{"protocolVersion":1,"requestId":"r1","token":"secret","operation":"ui.control.invoke","args":{"automationId":"exportButton","controlType":"Button","action":"invoke"}}""";
        var response = new RequestDispatcher("secret", automation).Dispatch(json);

        Assert.True(response.Ok);
        Assert.Equal(new ControlInvokeArgs("exportButton", "Button", "invoke"), automation.LastArgs);
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
        var json = """{"protocolVersion":1,"requestId":"r1","token":"secret","operation":"ui.control.invoke","args":{"automationId":"exportButton","controlType":"Button","action":"invoke"}}""";
        var response = new RequestDispatcher("secret", new ThrowingMutationAutomation()).Dispatch(json);

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
