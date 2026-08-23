using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.IO;

namespace PremiereMcp.WindowsUiAgent;

internal static class BrokerSecurity
{
    private static readonly string InstallationRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PremiereMCP");
    private static readonly string AuthorizedServerEntry = Path.Combine(InstallationRoot, "bundle", "premiere-mcp.bundle.mjs");
    private static readonly string TrustedHelperPath = Path.Combine(InstallationRoot, "bin", "PremiereMcp.WindowsUiAgent.exe");
    internal const string NodeExecutablePath = @"C:\Program Files\nodejs\node.exe";
    private const string NodeExecutableSha256 = "63c259c81e5d472b5f11c8d506070130cb04a1ecf84b80377a34ed6ec9048088";
    private const string PremiereExecutablePath = @"C:\Program Files\Adobe\Adobe Premiere Pro 2026\Adobe Premiere Pro.exe";
    private const string PremiereExecutableSha256 = "5014182d789e62e5d7fbef69e933b12273e0d99707ff72ca86212685aacd002b";
    private const string CepExecutablePath = @"C:\Program Files\Adobe\Adobe Premiere Pro 2026\CEPHtmlEngine\CEPHtmlEngine.exe";
    private const string CepExecutableSha256 = "dacd9a11030b8979d687f1af34750552c80123366174caac339651ddb1239c2d";
    private const string AuthorizedCepExtensionId = "com.local.ppmcp.cep.2026.headless";
    private static readonly string AuthorizedCepExtensionRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Adobe", "CEP", "extensions", "com.local.ppmcp.cep.2026");
    private static readonly IReadOnlyDictionary<string, string> AuthorizedRuntime = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        ["premiere-mcp.bundle.mjs"] = "2c4c4c8d5d5c2f376207decc6e2de163788b2bc153c4762b6e8d5f7cfb9c8d72",
    };
    private const uint SnapshotProcesses = 0x00000002;
    private const uint QueryLimitedInformation = 0x1000;
    private const int ProcessCommandLineInformation = 60;

    internal static void AssertServerEntryIntegrity(string path)
    {
        AssertSelfIntegrity();
        if (!Path.GetFullPath(path).Equals(AuthorizedServerEntry, StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException("MCP entrypoint path is not authorized.");
        var root = Path.GetDirectoryName(AuthorizedServerEntry) ?? throw new InvalidOperationException("MCP runtime root is unavailable.");
        var files = Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories).ToArray();
        if (files.Length != AuthorizedRuntime.Count) throw new UnauthorizedAccessException("MCP bundled runtime file set changed.");
        foreach (var file in files)
        {
            var relative = Path.GetRelativePath(root, file).Replace('\\', '/');
            if (!AuthorizedRuntime.TryGetValue(relative, out var expected) || !HashMatches(file, expected))
                throw new UnauthorizedAccessException($"MCP bundled runtime integrity check failed for {relative}.");
        }
        AssertExecutable(NodeExecutablePath, NodeExecutableSha256, "Node runtime");
    }

    internal static void AssertTrustedInstalledSelf()
    {
        AssertSelfIntegrity();
        var self = Environment.ProcessPath ?? throw new UnauthorizedAccessException("Helper process path is unavailable.");
        if (!Path.GetFullPath(self).Equals(Path.GetFullPath(TrustedHelperPath), StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException("Operation must run from the trusted installed helper path.");
    }

    internal static void AssertUiWorkerParent()
    {
        AssertTrustedInstalledSelf();
        var parentId = GetParentProcessId(Environment.ProcessId);
        using var parent = Process.GetProcessById(parentId);
        var parentImage = parent.MainModule?.FileName ?? throw new UnauthorizedAccessException("UI worker parent image is unavailable.");
        if (!Path.GetFullPath(parentImage).Equals(Path.GetFullPath(TrustedHelperPath), StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException("UI worker must be started by the trusted installed helper.");

        var self = Environment.ProcessPath ?? throw new UnauthorizedAccessException("UI worker process path is unavailable.");
        var selfHash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(self))).ToLowerInvariant();
        if (!HashMatches(parentImage, selfHash))
            throw new UnauthorizedAccessException("UI worker parent binary does not match the worker binary.");

        var parentArguments = ParseCommandLine(GetCommandLine(parent));
        var validStandalone = parentArguments.Length == 1;
        var validLauncher = parentArguments.Length == 3 &&
                            parentArguments[1] == "--launch-mcp" &&
                            Path.GetFullPath(parentArguments[2]).Equals(AuthorizedServerEntry, StringComparison.OrdinalIgnoreCase);
        if (!validStandalone && !validLauncher)
            throw new UnauthorizedAccessException("UI worker parent command line is not authorized.");
    }

    internal static void AssertCaller(string role)
    {
        AssertSelfIntegrity();
        var parentId = GetParentProcessId(Environment.ProcessId);
        using var parent = Process.GetProcessById(parentId);
        var image = parent.MainModule?.FileName ?? throw new UnauthorizedAccessException("Caller image is unavailable.");
        if (role == "premiere")
        {
            AssertCepCaller(parent, image);
            return;
        }
        if (role == "node-server")
        {
            AssertExecutable(image, NodeExecutableSha256, "Node runtime");
            if (!Path.GetFullPath(image).Equals(NodeExecutablePath, StringComparison.OrdinalIgnoreCase))
                throw new UnauthorizedAccessException("Node broker calls require the pinned Node runtime path.");
            var arguments = ParseCommandLine(GetCommandLine(parent));
            if (arguments.Length != 2 || !Path.GetFullPath(arguments[1]).Equals(AuthorizedServerEntry, StringComparison.OrdinalIgnoreCase))
                throw new UnauthorizedAccessException("Node broker caller command line is not the registered MCP entrypoint.");
            AssertServerEntryIntegrity(arguments[1]);
            var launcherId = GetParentProcessId(parent.Id);
            using var launcher = Process.GetProcessById(launcherId);
            var launcherImage = launcher.MainModule?.FileName ?? throw new UnauthorizedAccessException("Trusted launcher image is unavailable.");
            if (!Path.GetFullPath(launcherImage).Equals(TrustedHelperPath, StringComparison.OrdinalIgnoreCase))
                throw new UnauthorizedAccessException("Node MCP was not started by the trusted launcher.");
            var self = Environment.ProcessPath ?? throw new UnauthorizedAccessException("Broker process path is unavailable.");
            var selfHash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(self))).ToLowerInvariant();
            if (!HashMatches(launcherImage, selfHash)) throw new UnauthorizedAccessException("Trusted launcher binary does not match the broker binary.");
            var launcherArguments = ParseCommandLine(GetCommandLine(launcher));
            if (launcherArguments.Length != 3 || launcherArguments[1] != "--launch-mcp" || !Path.GetFullPath(launcherArguments[2]).Equals(AuthorizedServerEntry, StringComparison.OrdinalIgnoreCase))
                throw new UnauthorizedAccessException("Trusted launcher command line is invalid.");
            return;
        }
        throw new UnauthorizedAccessException("Unknown broker caller role.");
    }

    private static void AssertCepCaller(Process immediateParent, string image)
    {
        AssertExecutable(image, CepExecutableSha256, "Adobe CEP runtime");
        if (!Path.GetFullPath(image).Equals(CepExecutablePath, StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException("CEP broker calls require the pinned Premiere CEP runtime path.");

        var commandLine = GetCommandLine(immediateParent);
        var extensionMarker = $"--params_extensionid={AuthorizedCepExtensionId}";
        if (!commandLine.Contains(extensionMarker, StringComparison.Ordinal) ||
            !commandLine.Contains("--type=renderer", StringComparison.Ordinal))
            throw new UnauthorizedAccessException("CEP broker caller is not the authorized extension renderer.");

        var processId = immediateParent.Id;
        for (var depth = 0; depth < 4; depth++)
        {
            var ancestorId = GetParentProcessId(processId);
            using var ancestor = Process.GetProcessById(ancestorId);
            var ancestorImage = ancestor.MainModule?.FileName ?? throw new UnauthorizedAccessException("CEP ancestor image is unavailable.");
            var fullAncestorImage = Path.GetFullPath(ancestorImage);
            if (fullAncestorImage.Equals(PremiereExecutablePath, StringComparison.OrdinalIgnoreCase))
            {
                AssertExecutable(fullAncestorImage, PremiereExecutableSha256, "Adobe Premiere Pro");
                return;
            }
            if (!fullAncestorImage.Equals(CepExecutablePath, StringComparison.OrdinalIgnoreCase))
                throw new UnauthorizedAccessException("CEP broker process ancestry left the pinned Adobe runtime.");
            AssertExecutable(fullAncestorImage, CepExecutableSha256, "Adobe CEP runtime");
            var ancestorCommandLine = GetCommandLine(ancestor);
            if (depth == 0 && !ancestorCommandLine.Contains(AuthorizedCepExtensionRoot, StringComparison.OrdinalIgnoreCase))
                throw new UnauthorizedAccessException("CEP broker ancestor is not rooted in the authorized extension directory.");
            processId = ancestorId;
        }
        throw new UnauthorizedAccessException("CEP broker caller is not descended from the pinned Premiere process.");
    }

    private static void AssertExecutable(string path, string expectedHash, string label)
    {
        if (!File.Exists(path) || !HashMatches(path, expectedHash)) throw new UnauthorizedAccessException($"{label} integrity check failed.");
    }

    private static void AssertSelfIntegrity()
    {
        var self = Environment.ProcessPath ?? throw new UnauthorizedAccessException("Broker process path is unavailable.");
        if (!Path.GetFullPath(self).Equals(TrustedHelperPath, StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException("Broker must run from the trusted installed helper path.");
    }

    private static bool HashMatches(string path, string expectedHash)
    {
        var actual = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))).ToLowerInvariant();
        var actualBytes = Encoding.ASCII.GetBytes(actual);
        var expectedBytes = Encoding.ASCII.GetBytes(expectedHash);
        return actualBytes.Length == expectedBytes.Length && CryptographicOperations.FixedTimeEquals(actualBytes, expectedBytes);
    }

    internal static string Sign(string keyName, string message) => SecretStore.UseSecret(keyName, key =>
        Convert.ToBase64String(HMACSHA256.HashData(key, Encoding.UTF8.GetBytes(message))).TrimEnd('=').Replace('+', '-').Replace('/', '_'));

    internal static bool Verify(string keyName, string message, string signature)
    {
        var expected = Encoding.ASCII.GetBytes(Sign(keyName, message));
        var provided = Encoding.ASCII.GetBytes(signature);
        return expected.Length == provided.Length && CryptographicOperations.FixedTimeEquals(expected, provided);
    }

    private static int GetParentProcessId(int processId)
    {
        var snapshot = CreateToolhelp32Snapshot(SnapshotProcesses, 0);
        if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1)) throw new InvalidOperationException("Process snapshot failed.");
        try
        {
            var entry = new ProcessEntry32 { Size = (uint)Marshal.SizeOf<ProcessEntry32>() };
            if (!Process32First(snapshot, ref entry)) throw new InvalidOperationException("Process enumeration failed.");
            do { if (entry.ProcessId == processId) return (int)entry.ParentProcessId; } while (Process32Next(snapshot, ref entry));
            throw new InvalidOperationException("Parent process was not found.");
        }
        finally { CloseHandle(snapshot); }
    }

    private static string GetCommandLine(Process process)
    {
        var handle = OpenProcess(QueryLimitedInformation, false, process.Id);
        if (handle == IntPtr.Zero) throw new UnauthorizedAccessException("Caller command line cannot be inspected.");
        try
        {
            _ = NtQueryInformationProcess(handle, ProcessCommandLineInformation, IntPtr.Zero, 0, out var length);
            if (length <= 0 || length > 32768) throw new InvalidOperationException("Caller command line length is invalid.");
            var buffer = Marshal.AllocHGlobal(length);
            try
            {
                var status = NtQueryInformationProcess(handle, ProcessCommandLineInformation, buffer, length, out _);
                if (status != 0) throw new UnauthorizedAccessException($"Caller command line query failed: 0x{status:x8}.");
                var text = Marshal.PtrToStructure<UnicodeString>(buffer);
                return Marshal.PtrToStringUni(text.Buffer, text.Length / 2) ?? string.Empty;
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        finally { CloseHandle(handle); }
    }

    private static string[] ParseCommandLine(string commandLine)
    {
        var pointer = CommandLineToArgvW(commandLine, out var count);
        if (pointer == IntPtr.Zero) throw new InvalidOperationException("Caller command line parsing failed.");
        try
        {
            var values = new string[count];
            for (var index = 0; index < count; index++) values[index] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer, index * IntPtr.Size)) ?? string.Empty;
            return values;
        }
        finally { LocalFree(pointer); }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry32
    {
        internal uint Size; internal uint Usage; internal uint ProcessId; internal IntPtr DefaultHeapId; internal uint ModuleId; internal uint Threads; internal uint ParentProcessId; internal int BasePriority; internal uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] internal string ExeFile;
    }
    [StructLayout(LayoutKind.Sequential)] private struct UnicodeString { internal ushort Length; internal ushort MaximumLength; internal IntPtr Buffer; }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry32 entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry32 entry);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("ntdll.dll")] private static extern int NtQueryInformationProcess(IntPtr process, int informationClass, IntPtr information, int informationLength, out int returnLength);
    [DllImport("shell32.dll", SetLastError = true)] private static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string commandLine, out int argumentCount);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
}
