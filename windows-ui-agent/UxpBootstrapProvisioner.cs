using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using System.IO;

namespace PremiereMcp.WindowsUiAgent;

internal static class UxpBootstrapProvisioner
{
    internal const string BootstrapFileName = "runtime-bootstrap.json";
    private const string ExpectedPluginId = "com.local.ppmcp.uxp.2026";

    internal static string Provision(string pluginRoot)
    {
        var localBase = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PremiereMCP");
        var validatedRoot = ValidatePluginRoot(pluginRoot, localBase);
        var manifestPath = Path.Combine(validatedRoot, "manifest.json");
        using (var manifest = JsonDocument.Parse(File.ReadAllText(manifestPath)))
        {
            if (!manifest.RootElement.TryGetProperty("id", out var id) || id.GetString() != ExpectedPluginId)
                throw new InvalidDataException("UXP manifest id is not authorized.");
        }

        var token = SecretStore.GetOrCreateToken(McpLauncher.UxpTokenSecretName);
        var target = Path.Combine(validatedRoot, BootstrapFileName);
        var temporary = $"{target}.{Environment.ProcessId}.tmp";
        var payload = JsonSerializer.Serialize(new { version = 1, port = 17777, token, issuedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() });
        File.WriteAllText(temporary, payload);
        RestrictToCurrentUser(temporary);
        File.Move(temporary, target, true);
        RestrictToCurrentUser(target);
        return target;
    }

    internal static string ValidatePluginRoot(string pluginRoot, string localBase)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(pluginRoot);
        ArgumentException.ThrowIfNullOrWhiteSpace(localBase);
        var root = Path.GetFullPath(pluginRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var basePath = Path.GetFullPath(localBase).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        if (!Path.GetDirectoryName(root)!.Equals(basePath, StringComparison.OrdinalIgnoreCase) ||
            !Path.GetFileName(root).StartsWith("uxp-plugin-", StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException("UXP bootstrap target must be a versioned plugin directory directly under the PremiereMCP installation root.");
        if (!Directory.Exists(root) || !File.Exists(Path.Combine(root, "manifest.json")))
            throw new DirectoryNotFoundException("Installed UXP plugin manifest was not found.");
        return root;
    }

    private static void RestrictToCurrentUser(string path)
    {
        var identity = WindowsIdentity.GetCurrent().User ?? throw new UnauthorizedAccessException("Current Windows identity is unavailable.");
        var security = new FileSecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.AddAccessRule(new FileSystemAccessRule(identity, FileSystemRights.FullControl, AccessControlType.Allow));
        new FileInfo(path).SetAccessControl(security);
    }
}
