using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.IO;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;

namespace PremiereMcp.WindowsUiAgent;

internal static class BrokerSecurity
{
    internal static readonly string InstallationRoot = ResolveInstallationRoot();
    internal static readonly string AuthorizedServerEntry = Path.Combine(InstallationRoot, "bundle", "premiere-mcp.bundle.mjs");
    private static readonly string TrustedHelperPath = Path.Combine(InstallationRoot, "bin", "PremiereMcp.WindowsUiAgent.exe");
    internal static readonly string NodeExecutablePath = Path.Combine(InstallationRoot, "runtime", "node", "node.exe");
    private static readonly string RuntimeIntegrityManifestPath = Path.Combine(InstallationRoot, "app", "integrity", "runtime-integrity.json");
    private static readonly string RuntimeIntegritySignaturePath = Path.Combine(InstallationRoot, "app", "integrity", "runtime-integrity.json.sig");
    private const string ReleasePublicModulus = "3yADERIQUnDZxb5ZesfsTIZdhY+m97JGs6mZCuP4b1nHL+5cBwzqGxYmtVbdMZaE00KGP5dqVRur1+rjOKQK1QnUMUnb4dRTiFlpDdGYzBzOuJqUy1Mc33aP0U/1Px8ID49ME8vmgI7OvRORsrxhY4IZQGJusx2DkLbba+n0ijGyguYWmaCGLI/rL2zjCCvH4jjqO99vCSKlPdjsu84kYdolR+jMCsWrgPHFBB6WgmVlyzHHr6azAZC2S8jibQznqQAAre2JFKgko7bJOyRfso4k1D/QTJCTDDJR+zSNmwtJwk54Pt9L6/Mn9vkvlFDPQnCJAg37gDuhNgl1IGNexxwTlFug14/CsrJUfsZkRkHU4rNsT6bPpA+PmEej/W4ChTA8zgnhYNQNNOGRxuZ9kXse3cUz6lPOIAzOjdoXivFhFDbnXMBXNhwVUxcithTprTXDuV0Hp+TRNj54z9CH7kya2gY6L1guuQFNm5B/5qaM3cxyxm59KGJPkfeRUh9J";
    private const string ReleasePublicExponent = "AQAB";
    private const string AuthorizedCepExtensionId = "com.codex.premiere-pro-full-mcp.cep.headless";
    private static readonly string AuthorizedCepExtensionRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Adobe", "CEP", "extensions", "com.codex.premiere-pro-full-mcp.cep");
    private const uint SnapshotProcesses = 0x00000002;
    private const uint QueryLimitedInformation = 0x1000;
    private const int ProcessCommandLineInformation = 60;

    private static string ResolveInstallationRoot()
    {
        var configured = Environment.GetEnvironmentVariable("PREMIERE_MCP_INSTALL_ROOT");
        var root = string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PremiereMCP")
            : Path.GetFullPath(configured);
        var pathRoot = Path.GetPathRoot(root)?.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (string.IsNullOrWhiteSpace(root) || root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar).Equals(pathRoot, StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException("Premiere MCP installation root is unsafe.");
        return root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    }

    internal static void AssertServerEntryIntegrity(string path)
    {
        AssertSelfIntegrity();
        if (!Path.GetFullPath(path).Equals(AuthorizedServerEntry, StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException("MCP entrypoint path is not authorized.");
        var runtime = ReadSignedRuntimeIntegrity();
        AssertRuntimeFile(AuthorizedServerEntry, "bundle/premiere-mcp.bundle.mjs", runtime);
        AssertRuntimeFile(NodeExecutablePath, "runtime/node/node.exe", runtime);
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
            var runtime = ReadSignedRuntimeIntegrity();
            AssertRuntimeFile(image, "runtime/node/node.exe", runtime);
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
        var cepPath = Path.GetFullPath(image);
        AssertAdobeExecutable(cepPath, "CEPHtmlEngine.exe", requirePremiereVersion: false);
        var premiereRoot = Directory.GetParent(Path.GetDirectoryName(cepPath) ?? string.Empty)?.FullName
            ?? throw new UnauthorizedAccessException("Adobe CEP runtime root is unavailable.");
        var premiereExecutablePath = Path.Combine(premiereRoot, "Adobe Premiere Pro.exe");

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
            if (fullAncestorImage.Equals(premiereExecutablePath, StringComparison.OrdinalIgnoreCase))
            {
                AssertAdobeExecutable(fullAncestorImage, "Adobe Premiere Pro.exe", requirePremiereVersion: true);
                return;
            }
            if (!fullAncestorImage.Equals(cepPath, StringComparison.OrdinalIgnoreCase))
                throw new UnauthorizedAccessException("CEP broker process ancestry left the authenticated Adobe runtime.");
            AssertAdobeExecutable(fullAncestorImage, "CEPHtmlEngine.exe", requirePremiereVersion: false);
            var ancestorCommandLine = GetCommandLine(ancestor);
            if (depth == 0 && !ancestorCommandLine.Contains(AuthorizedCepExtensionRoot, StringComparison.OrdinalIgnoreCase))
                throw new UnauthorizedAccessException("CEP broker ancestor is not rooted in the authorized extension directory.");
            processId = ancestorId;
        }
        throw new UnauthorizedAccessException("CEP broker caller is not descended from the authenticated Premiere process.");
    }

    private static IReadOnlyDictionary<string, string> ReadSignedRuntimeIntegrity()
    {
        if (!File.Exists(RuntimeIntegrityManifestPath) || !File.Exists(RuntimeIntegritySignaturePath))
            throw new UnauthorizedAccessException("Signed runtime integrity metadata is missing.");
        var manifestBytes = File.ReadAllBytes(RuntimeIntegrityManifestPath);
        byte[] signature;
        try { signature = Convert.FromBase64String(File.ReadAllText(RuntimeIntegritySignaturePath).Trim()); }
        catch { throw new UnauthorizedAccessException("Runtime integrity signature is invalid."); }
        using var rsa = RSA.Create();
        rsa.ImportParameters(new RSAParameters { Modulus = Convert.FromBase64String(ReleasePublicModulus), Exponent = Convert.FromBase64String(ReleasePublicExponent) });
        if (!rsa.VerifyData(manifestBytes, signature, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1))
            throw new UnauthorizedAccessException("Runtime integrity signature verification failed.");
        using var document = JsonDocument.Parse(manifestBytes);
        var root = document.RootElement;
        if (!root.TryGetProperty("schema", out var schema) || schema.GetString() != "premiere-pro-full-mcp-runtime/1" ||
            !root.TryGetProperty("product", out var product) || product.GetString() != "premiere-pro-full-mcp" ||
            !root.TryGetProperty("files", out var files) || files.ValueKind != JsonValueKind.Object)
            throw new UnauthorizedAccessException("Runtime integrity metadata is invalid.");
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var property in files.EnumerateObject())
        {
            if (property.Name is not ("bundle/premiere-mcp.bundle.mjs" or "runtime/node/node.exe") ||
                property.Value.ValueKind != JsonValueKind.String || property.Value.GetString() is not { } hash ||
                hash.Length != 64 || hash.Any(character => !Uri.IsHexDigit(character)))
                throw new UnauthorizedAccessException("Runtime integrity file entry is invalid.");
            result.Add(property.Name, hash.ToLowerInvariant());
        }
        if (result.Count != 2) throw new UnauthorizedAccessException("Runtime integrity file set is incomplete.");
        return result;
    }

    private static void AssertRuntimeFile(string path, string relative, IReadOnlyDictionary<string, string> runtime)
    {
        if (!runtime.TryGetValue(relative, out var expected) || !File.Exists(path) || !HashMatches(path, expected))
            throw new UnauthorizedAccessException($"Signed runtime integrity check failed for {relative}.");
    }

    private static void AssertAdobeExecutable(string path, string expectedFileName, bool requirePremiereVersion)
    {
        var fullPath = Path.GetFullPath(path);
        var adobeRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Adobe") + Path.DirectorySeparatorChar;
        if (!fullPath.StartsWith(adobeRoot, StringComparison.OrdinalIgnoreCase) ||
            !Path.GetFileName(fullPath).Equals(expectedFileName, StringComparison.OrdinalIgnoreCase) ||
            !fullPath.Contains($"{Path.DirectorySeparatorChar}Adobe Premiere Pro ", StringComparison.OrdinalIgnoreCase) ||
            !File.Exists(fullPath) || !HasValidAuthenticodeSignature(fullPath))
            throw new UnauthorizedAccessException($"Authenticated Adobe executable check failed for {expectedFileName}.");
        using var certificate = new X509Certificate2(X509Certificate.CreateFromSignedFile(fullPath));
        if (!certificate.Subject.Contains("O=Adobe Inc.", StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException($"{expectedFileName} is not signed by Adobe Inc.");
        if (requirePremiereVersion)
        {
            var versionText = FileVersionInfo.GetVersionInfo(fullPath).ProductVersion?.Split(' ')[0];
            if (!Version.TryParse(versionText, out var version) || version < new Version(26, 3))
                throw new UnauthorizedAccessException("Premiere Pro 26.3 or later is required.");
        }
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

    private static bool HasValidAuthenticodeSignature(string path)
    {
        var filePath = Marshal.StringToCoTaskMemUni(path);
        var fileInfo = new WinTrustFileInfo
        {
            StructSize = (uint)Marshal.SizeOf<WinTrustFileInfo>(),
            FilePath = filePath,
            FileHandle = IntPtr.Zero,
            KnownSubject = IntPtr.Zero
        };
        var fileInfoPointer = Marshal.AllocCoTaskMem(Marshal.SizeOf<WinTrustFileInfo>());
        try
        {
            Marshal.StructureToPtr(fileInfo, fileInfoPointer, false);
            var trustData = new WinTrustData
            {
                StructSize = (uint)Marshal.SizeOf<WinTrustData>(),
                UiChoice = 2,
                RevocationChecks = 0,
                UnionChoice = 1,
                FileInfo = fileInfoPointer,
                StateAction = 0,
                ProviderFlags = 0x00001000,
                UiContext = 0
            };
            var policy = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE");
            return WinVerifyTrust(IntPtr.Zero, ref policy, ref trustData) == 0;
        }
        finally
        {
            Marshal.FreeCoTaskMem(fileInfoPointer);
            Marshal.FreeCoTaskMem(filePath);
        }
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
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WinTrustFileInfo
    {
        internal uint StructSize;
        internal IntPtr FilePath;
        internal IntPtr FileHandle;
        internal IntPtr KnownSubject;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WinTrustData
    {
        internal uint StructSize;
        internal IntPtr PolicyCallbackData;
        internal IntPtr SipClientData;
        internal uint UiChoice;
        internal uint RevocationChecks;
        internal uint UnionChoice;
        internal IntPtr FileInfo;
        internal uint StateAction;
        internal IntPtr StateData;
        internal IntPtr UrlReference;
        internal uint ProviderFlags;
        internal uint UiContext;
        internal IntPtr SignatureSettings;
    }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry32 entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry32 entry);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("ntdll.dll")] private static extern int NtQueryInformationProcess(IntPtr process, int informationClass, IntPtr information, int informationLength, out int returnLength);
    [DllImport("shell32.dll", SetLastError = true)] private static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string commandLine, out int argumentCount);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("wintrust.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] private static extern int WinVerifyTrust(IntPtr window, ref Guid actionId, ref WinTrustData data);
}
