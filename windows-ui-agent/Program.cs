using System.IO;
using System.IO.Pipes;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;

[assembly: InternalsVisibleTo("PremiereMcp.WindowsUiAgent.Tests")]

namespace PremiereMcp.WindowsUiAgent;

internal static class Program
{
    internal const string DefaultPipeName = "PremiereMcpUi";
    internal const int MaxMessageBytes = 1024 * 1024;
    internal const int ListenerCount = 4;
    internal static readonly TimeSpan AuthenticationDeadline = TimeSpan.FromSeconds(5);
    internal static readonly TimeSpan RequestDeadline = TimeSpan.FromSeconds(30);

    [STAThread]
    private static int Main(string[] args)
    {
        if (args is ["--uia-worker"])
        {
            try
            {
                BrokerSecurity.AssertUiWorkerParent();
                return UiaWorkerEntry.Run(Console.OpenStandardInput(), Console.OpenStandardOutput());
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"UI Automation worker failed: {ex.Message}");
                return 8;
            }
        }
        if (args is ["--launch-mcp", _])
        {
            try { return McpLauncher.Run(args[1]); }
            catch (Exception ex) { Console.Error.WriteLine($"MCP launcher failed: {ex.Message}"); return 6; }
        }
        if (args is ["--verify-install"])
        {
            try
            {
                BrokerSecurity.AssertServerEntryIntegrity(BrokerSecurity.AuthorizedServerEntry);
                Console.Out.WriteLine("Signed installed runtime verification passed.");
                return 0;
            }
            catch (Exception ex) { Console.Error.WriteLine($"Installed runtime verification failed: {ex.Message}"); return 9; }
        }
        if (args is ["--hmac", "cep-hmac" or "approval-hmac", "sign", "node-server" or "premiere"])
        {
            try
            {
                BrokerSecurity.AssertCaller(args[3]);
                var message = ReadBoundedStandardInput();
                Console.Out.Write(BrokerSecurity.Sign(args[1], message));
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"Secret store failed: {ex.Message}");
                return 3;
            }
        }
        if (args is ["--hmac", "cep-hmac", "session-key", "premiere"])
        {
            try
            {
                BrokerSecurity.AssertCaller("premiere");
                Console.Out.Write(BrokerSecurity.ExportSessionKey("cep-hmac"));
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"CEP session key broker failed: {ex.Message}");
                return 3;
            }
        }
        if (args is ["--hmac", "cep-hmac" or "approval-hmac", "session-key", "node-server"])
        {
            try
            {
                BrokerSecurity.AssertCaller("node-server");
                Console.Out.Write(BrokerSecurity.ExportSessionKey(args[1]));
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"MCP session key broker failed: {ex.Message}");
                return 3;
            }
        }
        if (args is ["--hmac", "cep-hmac" or "approval-hmac", "verify", "node-server" or "premiere", _])
        {
            try
            {
                BrokerSecurity.AssertCaller(args[3]);
                var message = ReadBoundedStandardInput();
                return BrokerSecurity.Verify(args[1], message, args[4]) ? 0 : 4;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"HMAC broker failed: {ex.Message}");
                return 3;
            }
        }
        if (args is ["--protect", "approval-payload", "protect", "node-server"])
        {
            try
            {
                BrokerSecurity.AssertCaller(args[3]);
                Console.Out.Write(SecretStore.ProtectText(args[1], ReadBoundedStandardInput()));
                return 0;
            }
            catch (Exception ex) { Console.Error.WriteLine($"Protection broker failed: {ex.Message}"); return 3; }
        }
        if (args is ["--protect", "approval-payload", "unprotect", "node-server"])
        {
            try
            {
                BrokerSecurity.AssertCaller(args[3]);
                Console.Out.Write(SecretStore.UnprotectText(args[1], ReadBoundedStandardInput()));
                return 0;
            }
            catch (Exception ex) { Console.Error.WriteLine($"Protection broker failed: {ex.Message}"); return 3; }
        }
        if (args is ["--trust-profile", "read", "node-server", _])
        {
            try
            {
                BrokerSecurity.AssertCaller("node-server");
                Console.Out.Write(TrustProfileStore.CreateDefault().Read(args[3]));
                return 0;
            }
            catch
            {
                Console.Error.WriteLine("Trust profile broker failed closed.");
                return 3;
            }
        }
        if (args is ["--trust-profile", "enroll", _])
        {
            try
            {
                BrokerSecurity.AssertTrustedInstalledSelf();
                TrustProfileStore.CreateDefault().EnrollFile(args[2]);
                Console.Out.WriteLine("Trust profile enrollment completed.");
                return 0;
            }
            catch { Console.Error.WriteLine("Trust profile enrollment failed."); return 10; }
        }
        if (args is ["--trust-profile", "revoke", _])
        {
            try
            {
                BrokerSecurity.AssertTrustedInstalledSelf();
                TrustProfileStore.CreateDefault().Revoke(args[2]);
                Console.Out.WriteLine("Trust profile revocation completed.");
                return 0;
            }
            catch { Console.Error.WriteLine("Trust profile revocation failed."); return 10; }
        }
        if (args is ["--approval", "approve", _])
        {
            try
            {
                BrokerSecurity.AssertTrustedInstalledSelf();
                ApprovalBroker.Approve(args[2]);
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"Approval broker failed: {ex.Message}");
                return 5;
            }
        }
        if (args is ["--provision-uxp"])
        {
            try
            {
                BrokerSecurity.AssertServerEntryIntegrity(BrokerSecurity.AuthorizedServerEntry);
                var path = UxpBootstrapProvisioner.Provision();
                Console.Out.WriteLine($"Provisioned authenticated UXP bootstrap: {path}");
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"UXP bootstrap provisioning failed: {ex.Message}");
                return 7;
            }
        }

        var token = Environment.GetEnvironmentVariable("PREMIERE_MCP_UI_TOKEN");
        if (string.IsNullOrWhiteSpace(token) || token.Length < 24)
        {
            Console.Error.WriteLine("PREMIERE_MCP_UI_TOKEN must contain at least 24 characters.");
            return 2;
        }

        var pipeName = Environment.GetEnvironmentVariable("PREMIERE_MCP_UI_PIPE");
        if (string.IsNullOrWhiteSpace(pipeName))
        {
            pipeName = DefaultPipeName;
        }

        if (!PipeNameValidator.IsValid(pipeName))
        {
            Console.Error.WriteLine("PREMIERE_MCP_UI_PIPE contains invalid characters or is too long.");
            return 2;
        }

        var dispatcher = new RequestDispatcher(token, new UiaWorkerClient());
        Console.Error.WriteLine($"Premiere MCP Windows UI Agent listening on pipe '{pipeName}' with {ListenerCount} bounded listeners.");
        UiAgentHost.RunForeground(pipeName, dispatcher);
        return 0;
    }

    private static string ReadBoundedStandardInput()
    {
        return ReadBoundedUtf8(Console.OpenStandardInput());
    }

    internal static string ReadBoundedUtf8(Stream stream)
    {
        ArgumentNullException.ThrowIfNull(stream);
        using var buffer = new MemoryStream();
        var chunk = new byte[8192];
        while (true)
        {
            var count = stream.Read(chunk, 0, chunk.Length);
            if (count == 0) break;
            if (buffer.Length + count > MaxMessageBytes) throw new InvalidDataException("Broker input exceeds 1 MiB.");
            buffer.Write(chunk, 0, count);
        }
        return new UTF8Encoding(false, true).GetString(buffer.GetBuffer(), 0, checked((int)buffer.Length));
    }

    internal static void Listen(string pipeName, RequestDispatcher dispatcher)
    {
        while (true)
        {
            NamedPipeServerStream? pipe = null;
            try
            {
                pipe = new NamedPipeServerStream(
                    pipeName,
                    PipeDirection.InOut,
                    ListenerCount,
                    PipeTransmissionMode.Byte,
                    PipeOptions.CurrentUserOnly | PipeOptions.Asynchronous);
                pipe.WaitForConnection();
                ServeConnection(pipe, dispatcher);
            }
            catch (IOException ex)
            {
                if (pipe?.IsConnected == true)
                {
                    Console.Error.WriteLine($"Pipe connection ended: {ex.Message}");
                }
                else
                {
                    // Another launcher may currently own all bounded instances. Retry so this
                    // launcher takes over if that process exits while our Node child is alive.
                    Thread.Sleep(250);
                }
            }
            catch (UnauthorizedAccessException ex)
            {
                Console.Error.WriteLine($"Pipe access denied: {ex.Message}");
            }
            catch (ObjectDisposedException)
            {
                Console.Error.WriteLine("Pipe connection exceeded its read deadline.");
            }
            finally
            {
                pipe?.Dispose();
            }
        }
    }

    internal static void ServeConnection(Stream stream, RequestDispatcher dispatcher)
    {
        var firstRequest = true;
        while (stream.CanRead && stream.CanWrite)
        {
            string? line;
            try
            {
                var deadline = firstRequest ? AuthenticationDeadline : RequestDeadline;
                using var timer = new Timer(_ => stream.Dispose(), null, deadline, Timeout.InfiniteTimeSpan);
                line = JsonLineProtocol.ReadLine(stream, MaxMessageBytes);
            }
            catch (MessageTooLargeException)
            {
                JsonLineProtocol.WriteResponse(stream, ProtocolResponse.Failure(
                    null,
                    "message_too_large",
                    $"Request exceeds the {MaxMessageBytes} byte limit."));
                return;
            }
            catch (DecoderFallbackException)
            {
                JsonLineProtocol.WriteResponse(stream, ProtocolResponse.Failure(
                    null,
                    "invalid_encoding",
                    "Request must be valid UTF-8."));
                return;
            }

            if (line is null)
            {
                return;
            }

            var response = dispatcher.Dispatch(line);
            JsonLineProtocol.WriteResponse(stream, response);
            firstRequest = false;
        }
    }
}

internal static class UiAgentHost
{
    internal static void StartBackground(string token, string pipeName)
    {
        Validate(token, pipeName);
        StartListeners(pipeName, new RequestDispatcher(token, new UiaWorkerClient()), true);
    }

    internal static void RunForeground(string pipeName, RequestDispatcher dispatcher)
    {
        ArgumentNullException.ThrowIfNull(dispatcher);
        var listeners = StartListeners(pipeName, dispatcher, false);
        foreach (var listener in listeners) listener.Join();
    }

    private static Thread[] StartListeners(string pipeName, RequestDispatcher dispatcher, bool background)
    {
        var listeners = new Thread[Program.ListenerCount];
        for (var index = 0; index < listeners.Length; index++)
        {
            listeners[index] = new Thread(() => Program.Listen(pipeName, dispatcher))
            {
                IsBackground = background,
                Name = $"PremiereMcpPipeListener-{index}"
            };
            listeners[index].SetApartmentState(ApartmentState.STA);
            listeners[index].Start();
        }
        return listeners;
    }

    private static void Validate(string token, string pipeName)
    {
        if (string.IsNullOrWhiteSpace(token) || token.Length < 24)
        {
            throw new ArgumentException("UI bridge token must contain at least 24 characters.", nameof(token));
        }
        if (!PipeNameValidator.IsValid(pipeName))
        {
            throw new ArgumentException("UI pipe name is invalid.", nameof(pipeName));
        }
    }
}

internal static class PipeNameValidator
{
    internal static bool IsValid(string name) =>
        name.Length is > 0 and <= 128 &&
        name.All(c => char.IsLetterOrDigit(c) || c is '-' or '_' or '.');
}

internal static class TokenComparer
{
    internal static bool EqualsFixedTime(string expected, string? actual)
    {
        if (actual is null)
        {
            return false;
        }

        var expectedBytes = Encoding.UTF8.GetBytes(expected);
        var actualBytes = Encoding.UTF8.GetBytes(actual);
        return expectedBytes.Length == actualBytes.Length &&
               CryptographicOperations.FixedTimeEquals(expectedBytes, actualBytes);
    }
}
