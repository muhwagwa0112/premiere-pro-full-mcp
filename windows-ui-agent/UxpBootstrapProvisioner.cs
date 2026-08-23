using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using System.IO;

namespace PremiereMcp.WindowsUiAgent;

internal static class UxpBootstrapProvisioner
{
    internal const string BootstrapFileName = "runtime-bootstrap.json";

    internal static string Provision()
    {
        var localBase = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PremiereMCP");
        var applicationRoot = Path.Combine(localBase, "app");
        SecretStore.EnsureCurrentUserDirectory(localBase);
        SecretStore.EnsureCurrentUserDirectory(applicationRoot);
        var token = SecretStore.GetOrCreateToken(McpLauncher.UxpTokenSecretName);
        var target = ResolveTarget(localBase);
        var temporary = $"{target}.{Environment.ProcessId}.tmp";
        var payload = JsonSerializer.Serialize(new { version = 1, port = 17777, token, issuedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() });
        File.WriteAllText(temporary, payload);
        RestrictToCurrentUser(temporary);
        File.Move(temporary, target, true);
        RestrictToCurrentUser(target);
        return target;
    }

    internal static string ResolveTarget(string localBase)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(localBase);
        return Path.Combine(Path.GetFullPath(localBase), "app", BootstrapFileName);
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
