using PremiereMcp.WindowsUiAgent;
using System.Diagnostics;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Xunit;

namespace PremiereMcp.WindowsUiAgent.Tests;

public sealed class McpLauncherTests
{
    [Fact]
    public void CreatesDefaultWorkspaceAndInjectsDistinctDpapiBackedTokens()
    {
        var localAppData = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
        string? createdDirectory = null;
        var requestedSecrets = new List<string>();
        var inherited = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);

        var configuration = McpRuntimeConfiguration.Create(
            inherited,
            name =>
            {
                requestedSecrets.Add(name);
                return name.Contains("uxp", StringComparison.Ordinal) ? new string('A', 64) : new string('B', 64);
            },
            localAppData,
            path => createdDirectory = path);

        var childEnvironment = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        configuration.ApplyTo(childEnvironment);

        Assert.Equal(2, requestedSecrets.Distinct(StringComparer.Ordinal).Count());
        Assert.NotEqual(configuration.UxpToken, configuration.UiToken);
        Assert.Equal(Path.Combine(localAppData, "PremiereMCP", "workspace"), createdDirectory);
        Assert.Equal(createdDirectory, childEnvironment["PREMIERE_MCP_APPROVED_ROOTS"]);
        Assert.Equal(configuration.UxpToken, childEnvironment["PREMIERE_MCP_UXP_TOKEN"]);
        Assert.Equal(configuration.UiToken, childEnvironment["PREMIERE_MCP_UI_TOKEN"]);
        Assert.Equal("PremiereMcpUi", childEnvironment["PREMIERE_MCP_UI_PIPE"]);
    }

    [Fact]
    public void PreservesExplicitApprovedRootsAndDoesNotCreateDefaultWorkspace()
    {
        var inherited = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase)
        {
            ["premiere_mcp_approved_roots"] = @"D:\Approved;E:\Media",
            ["PREMIERE_MCP_UI_PIPE"] = "PremiereMcpUi.Test"
        };
        var createCalls = 0;

        var configuration = McpRuntimeConfiguration.Create(
            inherited,
            name => name.Contains("uxp", StringComparison.Ordinal) ? new string('C', 64) : new string('D', 64),
            Path.GetTempPath(),
            _ => createCalls++);

        Assert.Equal(@"D:\Approved;E:\Media", configuration.ApprovedRoots);
        Assert.Equal("PremiereMcpUi.Test", configuration.UiPipeName);
        Assert.Equal(0, createCalls);
    }

    [Fact]
    public void RejectsSharedBridgeToken()
    {
        var token = new string('E', 64);
        Assert.Throws<CryptographicException>(() => McpRuntimeConfiguration.Create(
            new Dictionary<string, string?>(),
            _ => token,
            Path.GetTempPath(),
            _ => { }));
    }

    [Fact]
    public void RejectsInvalidInheritedPipeName()
    {
        var inherited = new Dictionary<string, string?>
        {
            ["PREMIERE_MCP_UI_PIPE"] = @"bad\pipe"
        };

        Assert.Throws<InvalidDataException>(() => McpRuntimeConfiguration.Create(
            inherited,
            name => name.Contains("uxp", StringComparison.Ordinal) ? new string('F', 64) : new string('0', 64),
            Path.GetTempPath(),
            _ => { }));
    }

    [Fact]
    public void HardensBrokerLocatorAndNodePreloadEnvironment()
    {
        var trustedLocalAppData = Path.Combine(Path.GetTempPath(), "ppmcp-trusted-local");
        var inherited = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase)
        {
            ["NODE_OPTIONS"] = @"--require C:\attacker\preload.cjs",
            ["NODE_PATH"] = @"C:\attacker\modules",
            ["PREMIERE_MCP_SECRET_HELPER"] = @"C:\attacker\helper.exe",
            ["LOCALAPPDATA"] = @"C:\attacker\local",
            ["PREMIERE_MCP_CEP_DIR"] = @"C:\attacker\queue"
        };

        McpLauncher.HardenChildEnvironment(inherited, trustedLocalAppData);

        Assert.False(inherited.ContainsKey("NODE_OPTIONS"));
        Assert.False(inherited.ContainsKey("NODE_PATH"));
        Assert.False(inherited.ContainsKey("PREMIERE_MCP_SECRET_HELPER"));
        Assert.Equal(Path.GetFullPath(trustedLocalAppData), inherited["LOCALAPPDATA"]);
        Assert.Equal(Path.Combine(Path.GetFullPath(trustedLocalAppData), "PremiereMCP", "cep"), inherited["PREMIERE_MCP_CEP_DIR"]);
    }

    [Fact]
    public void UxpBootstrapTargetIsFixedUnderTheCurrentUserApplicationRoot()
    {
        var localBase = Path.Combine(Path.GetTempPath(), $"ppmcp-local-{Guid.NewGuid():N}");
        Assert.Equal(Path.Combine(Path.GetFullPath(localBase), "app", "runtime-bootstrap.json"), UxpBootstrapProvisioner.ResolveTarget(localBase));
        Assert.Throws<ArgumentException>(() => UxpBootstrapProvisioner.ResolveTarget(""));
    }

    [Fact]
    public void BackgroundUiHostAuthenticatesHealthRequestOverNamedPipe()
    {
        var token = new string('7', 64);
        var pipeName = $"PremiereMcpUi.Test.{Guid.NewGuid():N}";
        UiAgentHost.StartBackground(token, pipeName);

        using var client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.None);
        client.Connect(5_000);
        var request = JsonSerializer.Serialize(new
        {
            protocolVersion = 1,
            requestId = "health-1",
            token,
            operation = "health",
            args = new { }
        });
        var bytes = Encoding.UTF8.GetBytes(request + "\n");
        client.Write(bytes);
        client.Flush();

        var response = JsonLineProtocol.ReadLine(client, Program.MaxMessageBytes);
        Assert.NotNull(response);
        using var json = JsonDocument.Parse(response);
        Assert.True(json.RootElement.GetProperty("ok").GetBoolean());
        Assert.Equal("health-1", json.RootElement.GetProperty("requestId").GetString());
    }

    [Fact]
    public void ClosingJobObjectTerminatesChildProcessTree()
    {
        var testRoot = Path.Combine(Path.GetTempPath(), $"ppmcp-job-{Guid.NewGuid():N}");
        Directory.CreateDirectory(testRoot);
        var signalPath = Path.Combine(testRoot, "start.signal");
        var pidPath = Path.Combine(testRoot, "child.pid");
        var powershell = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        var childCommand = Convert.ToBase64String(Encoding.Unicode.GetBytes("Start-Sleep -Seconds 30"));
        var parentScript = "while (-not (Test-Path -LiteralPath $env:PPMCP_TEST_SIGNAL)) { Start-Sleep -Milliseconds 10 }; " +
            "$child = Start-Process -FilePath $env:PPMCP_TEST_POWERSHELL -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand',$env:PPMCP_TEST_CHILD_COMMAND) -WindowStyle Hidden -PassThru; " +
            "$pidTemp = $env:PPMCP_TEST_PID_FILE + '.tmp'; " +
            "[IO.File]::WriteAllText($pidTemp, [string]$child.Id); [IO.File]::Move($pidTemp, $env:PPMCP_TEST_PID_FILE); $child.WaitForExit()";
        var parentCommand = Convert.ToBase64String(Encoding.Unicode.GetBytes(parentScript));
        using var parent = Process.Start(new ProcessStartInfo
        {
            FileName = powershell,
            Arguments = $"-NoProfile -NonInteractive -EncodedCommand {parentCommand}",
            UseShellExecute = false,
            CreateNoWindow = true,
            Environment =
            {
                ["PPMCP_TEST_SIGNAL"] = signalPath,
                ["PPMCP_TEST_PID_FILE"] = pidPath,
                ["PPMCP_TEST_POWERSHELL"] = powershell,
                ["PPMCP_TEST_CHILD_COMMAND"] = childCommand
            }
        }) ?? throw new InvalidOperationException("Could not start job-object test parent process.");

        Process? descendant = null;
        try
        {
            using var lifetime = JobObjectLifetime.Attach(parent);
            File.WriteAllText(signalPath, string.Empty);
            Assert.True(SpinWait.SpinUntil(() => File.Exists(pidPath), TimeSpan.FromSeconds(5)), "Descendant PID was not published.");
            var descendantPid = int.Parse(File.ReadAllText(pidPath));
            descendant = Process.GetProcessById(descendantPid);

            lifetime.Dispose();

            Assert.True(parent.WaitForExit(5_000), "Job parent survived closing the job handle.");
            Assert.True(descendant.WaitForExit(5_000), "Job descendant survived closing the job handle.");
        }
        finally
        {
            if (!parent.HasExited) parent.Kill(entireProcessTree: true);
            if (descendant is not null)
            {
                if (!descendant.HasExited) descendant.Kill(entireProcessTree: true);
                descendant.Dispose();
            }
            Directory.Delete(testRoot, recursive: true);
        }
    }
}
