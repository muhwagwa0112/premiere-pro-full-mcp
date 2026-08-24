using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace PremiereMcp.WindowsUiAgent;

internal static class McpLauncher
{
    internal const string UiTokenSecretName = "ui-bridge-token";

    internal static int Run(string entrypoint)
    {
        BrokerSecurity.AssertServerEntryIntegrity(entrypoint);
        var start = new ProcessStartInfo
        {
            FileName = BrokerSecurity.NodeExecutablePath,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        start.ArgumentList.Add(Path.GetFullPath(entrypoint));
        var automation = LauncherAutomationConfiguration.Resolve(
            start.Environment,
            profileId => TrustProfileStore.CreateDefault().Read(profileId));
        var localApplicationData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var premiereRoot = Path.Combine(localApplicationData, "PremiereMCP");
        foreach (var directory in new[] { premiereRoot, Path.Combine(premiereRoot, "approvals"), Path.Combine(premiereRoot, "cep-public-v1"), Path.Combine(premiereRoot, "workspace"), Path.Combine(premiereRoot, "secrets"), Path.Combine(premiereRoot, "trust-profiles") })
            SecretStore.EnsureCurrentUserDirectory(directory);
        HardenChildEnvironment(start.Environment, localApplicationData);
        automation.ApplyTo(start.Environment);

        var runtime = McpRuntimeConfiguration.Create(
            start.Environment,
            SecretStore.GetOrCreateToken,
            localApplicationData,
            SecretStore.EnsureCurrentUserDirectory);
        runtime.ApplyTo(start.Environment);
        UiAgentHost.StartBackground(runtime.UiToken, runtime.UiPipeName);

        using var child = Process.Start(start) ?? throw new InvalidOperationException("Node MCP process could not be started.");
        using var childLifetime = JobObjectLifetime.Attach(child);
        var input = Task.Run(async () =>
        {
            try { await Console.OpenStandardInput().CopyToAsync(child.StandardInput.BaseStream); }
            finally { child.StandardInput.Close(); }
        });
        var output = child.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
        var error = child.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
        child.WaitForExit();
        Task.WhenAll(output, error).GetAwaiter().GetResult();
        _ = input;
        return child.ExitCode;
    }

    internal static void HardenChildEnvironment(IDictionary<string, string?> environment, string localApplicationData)
    {
        ArgumentNullException.ThrowIfNull(environment);
        ArgumentException.ThrowIfNullOrWhiteSpace(localApplicationData);
        var trustedLocalAppData = Path.GetFullPath(localApplicationData);
        environment.Remove("NODE_OPTIONS");
        environment.Remove("NODE_PATH");
        environment.Remove("PREMIERE_MCP_SECRET_HELPER");
        environment.Remove("PREMIERE_MCP_UXP_TOKEN");
        RemoveInheritedAutomationBoundary(environment);
        environment["LOCALAPPDATA"] = trustedLocalAppData;
        environment["PREMIERE_MCP_CEP_DIR"] = Path.Combine(trustedLocalAppData, "PremiereMCP", "cep-public-v1");
    }

    private static void RemoveInheritedAutomationBoundary(IDictionary<string, string?> environment)
    {
        var inheritedBoundaryNames = environment.Keys.Where(name =>
            name.StartsWith("PREMIERE_MCP_", StringComparison.OrdinalIgnoreCase) &&
            (name.Contains("AUTOMATION", StringComparison.OrdinalIgnoreCase) ||
             name.Contains("PROFILE", StringComparison.OrdinalIgnoreCase) ||
             name.Contains("LEASE", StringComparison.OrdinalIgnoreCase))).ToArray();
        foreach (var name in inheritedBoundaryNames) environment.Remove(name);
    }
}

internal sealed record LauncherAutomationConfiguration(string Mode, string? TrustProfileId)
{
    internal const string AutomationModeVariable = "PREMIERE_MCP_AUTOMATION_MODE";
    internal const string TrustProfileIdVariable = "PREMIERE_MCP_TRUST_PROFILE_ID";

    internal static LauncherAutomationConfiguration Resolve(
        IDictionary<string, string?> inheritedEnvironment,
        Func<string, string> profileReader)
    {
        ArgumentNullException.ThrowIfNull(inheritedEnvironment);
        ArgumentNullException.ThrowIfNull(profileReader);

        var mode = NormalizeMode(GetValue(inheritedEnvironment, AutomationModeVariable));
        var profileId = GetValue(inheritedEnvironment, TrustProfileIdVariable)?.Trim();
        if (mode == "interactive") return new LauncherAutomationConfiguration(mode, null);
        if (string.IsNullOrWhiteSpace(profileId))
            throw new InvalidDataException($"{mode} requires a trust profile ID.");

        var profileJson = profileReader(profileId);
        using var profile = JsonDocument.Parse(profileJson, new JsonDocumentOptions { MaxDepth = 32 });
        if (!profile.RootElement.TryGetProperty("mode", out var profileModeValue) ||
            profileModeValue.ValueKind != JsonValueKind.String)
            throw new InvalidDataException("Trust profile mode is missing.");
        var profileMode = NormalizeMode(profileModeValue.GetString());
        if (!string.Equals(mode, profileMode, StringComparison.Ordinal))
            throw new InvalidDataException("Requested automation mode does not match the protected trust profile.");
        return new LauncherAutomationConfiguration(mode, profileId);
    }

    internal static string NormalizeMode(string? value)
    {
        if (value is null) return "interactive";
        if (string.IsNullOrWhiteSpace(value)) throw new InvalidDataException("PREMIERE_MCP_AUTOMATION_MODE is invalid.");
        return value.Trim().ToLowerInvariant() switch
        {
            "interactive" => "interactive",
            "trusted_unattended" or "trustedunattended" => "trusted_unattended",
            "isolated_lab" or "isolatedlab" => "isolated_lab",
            _ => throw new InvalidDataException("PREMIERE_MCP_AUTOMATION_MODE is invalid.")
        };
    }

    internal void ApplyTo(IDictionary<string, string?> environment)
    {
        ArgumentNullException.ThrowIfNull(environment);
        environment[AutomationModeVariable] = Mode;
        if (TrustProfileId is not null) environment[TrustProfileIdVariable] = TrustProfileId;
    }

    private static string? GetValue(IDictionary<string, string?> environment, string name)
    {
        if (environment.TryGetValue(name, out var value)) return value;
        var match = environment.FirstOrDefault(pair => string.Equals(pair.Key, name, StringComparison.OrdinalIgnoreCase));
        return match.Key is null ? null : match.Value;
    }
}

internal sealed class JobObjectLifetime : IDisposable
{
    private const uint JobObjectLimitKillOnJobClose = 0x00002000;
    private const int JobObjectExtendedLimitInformationClass = 9;
    private SafeJobHandle? _job;

    private JobObjectLifetime(SafeJobHandle? job)
    {
        _job = job;
    }

    internal static JobObjectLifetime Attach(Process child)
    {
        ArgumentNullException.ThrowIfNull(child);
        var job = NativeMethods.CreateJobObject(IntPtr.Zero, null);
        if (job.IsInvalid)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Could not create the MCP child-process job object.");
        }

        var limits = new JobObjectExtendedLimitInformation
        {
            BasicLimitInformation = new JobObjectBasicLimitInformation
            {
                LimitFlags = JobObjectLimitKillOnJobClose
            }
        };
        if (!NativeMethods.SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformationClass,
                ref limits,
                (uint)Marshal.SizeOf<JobObjectExtendedLimitInformation>()))
        {
            var error = Marshal.GetLastWin32Error();
            job.Dispose();
            throw new Win32Exception(error, "Could not configure the MCP child-process job object.");
        }

        if (!NativeMethods.AssignProcessToJobObject(job, child.SafeHandle))
        {
            var error = Marshal.GetLastWin32Error();
            if (child.HasExited)
            {
                job.Dispose();
                return new JobObjectLifetime(null);
            }

            try
            {
                child.Kill(entireProcessTree: true);
                child.WaitForExit(5_000);
            }
            finally
            {
                job.Dispose();
            }
            throw new Win32Exception(error, "Could not bind the MCP child process to its lifetime job object.");
        }

        return new JobObjectLifetime(job);
    }

    public void Dispose()
    {
        Interlocked.Exchange(ref _job, null)?.Dispose();
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        internal long PerProcessUserTimeLimit;
        internal long PerJobUserTimeLimit;
        internal uint LimitFlags;
        internal UIntPtr MinimumWorkingSetSize;
        internal UIntPtr MaximumWorkingSetSize;
        internal uint ActiveProcessLimit;
        internal UIntPtr Affinity;
        internal uint PriorityClass;
        internal uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        internal ulong ReadOperationCount;
        internal ulong WriteOperationCount;
        internal ulong OtherOperationCount;
        internal ulong ReadTransferCount;
        internal ulong WriteTransferCount;
        internal ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        internal JobObjectBasicLimitInformation BasicLimitInformation;
        internal IoCounters IoInfo;
        internal UIntPtr ProcessMemoryLimit;
        internal UIntPtr JobMemoryLimit;
        internal UIntPtr PeakProcessMemoryUsed;
        internal UIntPtr PeakJobMemoryUsed;
    }

    private sealed class SafeJobHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        private SafeJobHandle() : base(ownsHandle: true) { }

        protected override bool ReleaseHandle() => NativeMethods.CloseHandle(handle);
    }

    private static class NativeMethods
    {
        [DllImport("kernel32.dll", EntryPoint = "CreateJobObjectW", SetLastError = true, CharSet = CharSet.Unicode)]
        internal static extern SafeJobHandle CreateJobObject(IntPtr jobAttributes, string? name);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetInformationJobObject(
            SafeJobHandle job,
            int informationClass,
            ref JobObjectExtendedLimitInformation information,
            uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool AssignProcessToJobObject(SafeJobHandle job, SafeProcessHandle process);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool CloseHandle(IntPtr handle);
    }
}

public sealed record McpRuntimeConfiguration(
    string UiToken,
    string ApprovedRoots,
    string UiPipeName)
{
    public static McpRuntimeConfiguration Create(
        IDictionary<string, string?> inheritedEnvironment,
        Func<string, string> secretProvider,
        string localApplicationData,
        Action<string> createDirectory)
    {
        ArgumentNullException.ThrowIfNull(inheritedEnvironment);
        ArgumentNullException.ThrowIfNull(secretProvider);
        ArgumentException.ThrowIfNullOrWhiteSpace(localApplicationData);
        ArgumentNullException.ThrowIfNull(createDirectory);

        var uiToken = secretProvider(McpLauncher.UiTokenSecretName);
        ValidateToken(uiToken, "UI");

        var approvedRoots = GetValue(inheritedEnvironment, "PREMIERE_MCP_APPROVED_ROOTS");
        if (string.IsNullOrWhiteSpace(approvedRoots))
        {
            var workspace = Path.GetFullPath(Path.Combine(localApplicationData, "PremiereMCP", "workspace"));
            createDirectory(workspace);
            approvedRoots = workspace;
        }

        var pipeName = GetValue(inheritedEnvironment, "PREMIERE_MCP_UI_PIPE");
        if (string.IsNullOrWhiteSpace(pipeName)) pipeName = Program.DefaultPipeName;
        if (!PipeNameValidator.IsValid(pipeName))
        {
            throw new InvalidDataException("PREMIERE_MCP_UI_PIPE contains invalid characters or is too long.");
        }

        return new McpRuntimeConfiguration(uiToken, approvedRoots, pipeName);
    }

    public void ApplyTo(IDictionary<string, string?> environment)
    {
        ArgumentNullException.ThrowIfNull(environment);
        environment["PREMIERE_MCP_UI_TOKEN"] = UiToken;
        environment["PREMIERE_MCP_APPROVED_ROOTS"] = ApprovedRoots;
        environment["PREMIERE_MCP_UI_PIPE"] = UiPipeName;
    }

    private static string? GetValue(IDictionary<string, string?> environment, string name)
    {
        if (environment.TryGetValue(name, out var value)) return value;
        var match = environment.FirstOrDefault(pair =>
            string.Equals(pair.Key, name, StringComparison.OrdinalIgnoreCase));
        return match.Key is null ? null : match.Value;
    }

    private static void ValidateToken(string token, string label)
    {
        if (string.IsNullOrWhiteSpace(token) || token.Length < 24)
        {
            throw new CryptographicException($"{label} bridge token has an invalid length.");
        }
    }
}
