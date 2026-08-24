using System.IO;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;

namespace PremiereMcp.WindowsUiAgent;

internal sealed record UxpAuthenticationIdentity(string AuthFilePath, string Secret);

internal static class UxpAuthFileSecurity
{
    internal const string AuthFileName = "premiere-mcp-bridge-key-v1";
    internal const string PluginId = "com.codex.premiere-pro-full-mcp";
    internal const string PremiereMajorVersion = "26";

    internal static string DefaultAuthRoot => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Adobe", "UXP", "PluginsStorage", "PPRO");

    internal static UxpAuthenticationIdentity Provision(string? authRoot = null)
    {
        var root = Path.GetFullPath(authRoot ?? DefaultAuthRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var pluginData = Path.Combine(root, PremiereMajorVersion, "External", PluginId, "PluginData");
        EnsureDirectoryTreeWithoutReparse(root, pluginData);
        ProtectDirectory(pluginData);
        AssertProtectedDirectory(pluginData);

        var path = Path.Combine(pluginData, AuthFileName);
        if (File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new UnauthorizedAccessException("UXP authentication file cannot be a reparse point.");
        if (File.Exists(path) && HasStrictFileAcl(path) && TryReadValidSecret(path, out var preserved))
            return new UxpAuthenticationIdentity(path, preserved);

        // Do not read a pre-existing key whose owner or DACL crosses the current-user boundary.
        var secret = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var temporaryPath = Path.Combine(pluginData, $".{AuthFileName}.{Guid.NewGuid():N}.tmp");
        try
        {
            using (var stream = new FileStream(temporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                ProtectFile(temporaryPath);
                AssertProtectedFile(temporaryPath);
                using var writer = new StreamWriter(stream, new System.Text.UTF8Encoding(false), leaveOpen: true);
                writer.Write(secret);
                writer.Flush();
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporaryPath, path, overwrite: true);
            AssertProtectedFile(path);
            return new UxpAuthenticationIdentity(path, secret);
        }
        finally
        {
            if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
        }
    }

    internal static string ProtectAndRead(string untrustedPath, string? authRoot = null)
    {
        var path = ValidatePath(untrustedPath, authRoot ?? DefaultAuthRoot);
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.None);
        ProtectFile(path);
        AssertProtectedFile(path);
        return ReadValidSecret(stream);
    }

    internal static string ValidatePath(string untrustedPath, string authRoot)
    {
        if (string.IsNullOrWhiteSpace(untrustedPath) || !Path.IsPathFullyQualified(untrustedPath))
            throw new UnauthorizedAccessException("UXP authentication path must be absolute.");
        var root = Path.GetFullPath(authRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var expected = Path.Combine(root, PremiereMajorVersion, "External", PluginId, "PluginData", AuthFileName);
        var path = Path.GetFullPath(untrustedPath);
        if (!path.Equals(expected, StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException("UXP authentication path is not authorized.");
        AssertNoReparsePoints(root, path);
        if (!File.Exists(path)) throw new FileNotFoundException("UXP authentication file does not exist.", path);
        return path;
    }

    private static string ReadValidSecret(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.None);
        return ReadValidSecret(stream);
    }

    private static bool TryReadValidSecret(string path, out string secret)
    {
        try { secret = ReadValidSecret(path); return true; }
        catch (InvalidDataException) { secret = string.Empty; return false; }
    }

    private static string ReadValidSecret(Stream stream)
    {
        if (stream.Length != 64) throw new InvalidDataException("UXP authentication secret has an invalid length.");
        using var reader = new StreamReader(stream, new System.Text.UTF8Encoding(false, true), detectEncodingFromByteOrderMarks: false, leaveOpen: true);
        var secret = reader.ReadToEnd();
        if (secret.Length != 64 || secret.Any(character => character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f')))
            throw new InvalidDataException("UXP authentication secret is invalid.");
        return secret;
    }

    private static void AssertNoReparsePoints(string root, string path)
    {
        var current = root;
        if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
            throw new UnauthorizedAccessException("UXP authentication root cannot be a reparse point.");
        foreach (var component in Path.GetRelativePath(root, path).Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, component);
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new UnauthorizedAccessException("UXP authentication path cannot contain a reparse point.");
        }
    }

    private static void EnsureDirectoryTreeWithoutReparse(string root, string path)
    {
        if (!Directory.Exists(root)) Directory.CreateDirectory(root);
        if ((File.GetAttributes(root) & FileAttributes.ReparsePoint) != 0)
            throw new UnauthorizedAccessException("UXP authentication root cannot be a reparse point.");
        var current = root;
        foreach (var component in Path.GetRelativePath(root, path).Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, component);
            if (!Directory.Exists(current)) Directory.CreateDirectory(current);
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new UnauthorizedAccessException("UXP authentication path cannot contain a reparse point.");
        }
    }

    private static void ProtectDirectory(string path)
    {
        var security = new DirectorySecurity();
        var currentUser = CurrentUser();
        security.SetOwner(currentUser);
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        foreach (var identity in AllowedIdentities(currentUser))
            security.AddAccessRule(new FileSystemAccessRule(identity, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        new DirectoryInfo(path).SetAccessControl(security);
    }

    private static void ProtectFile(string path)
    {
        var security = new FileSecurity();
        var currentUser = CurrentUser();
        security.SetOwner(currentUser);
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        foreach (var identity in AllowedIdentities(currentUser))
            security.AddAccessRule(new FileSystemAccessRule(identity, FileSystemRights.FullControl, AccessControlType.Allow));
        new FileInfo(path).SetAccessControl(security);
    }

    private static bool HasStrictFileAcl(string path)
    {
        try { AssertProtectedFile(path); return true; }
        catch (UnauthorizedAccessException) { return false; }
    }

    private static void AssertProtectedFile(string path) => AssertProtectedAcl(new FileInfo(path).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access), requireInheritance: false);
    private static void AssertProtectedDirectory(string path) => AssertProtectedAcl(new DirectoryInfo(path).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access), requireInheritance: true);

    private static void AssertProtectedAcl(FileSystemSecurity security, bool requireInheritance)
    {
        var currentUser = CurrentUser();
        var allowed = AllowedIdentities(currentUser).Select(identity => identity.Value).ToHashSet(StringComparer.Ordinal);
        if (!security.AreAccessRulesProtected || !currentUser.Equals(security.GetOwner(typeof(SecurityIdentifier))))
            throw new UnauthorizedAccessException("UXP authentication ACL is not protected for the current user.");
        var rules = security.GetAccessRules(includeExplicit: true, includeInherited: true, typeof(SecurityIdentifier));
        foreach (FileSystemAccessRule rule in rules)
        {
            var sid = ((SecurityIdentifier)rule.IdentityReference).Value;
            var inheritanceIsExact = requireInheritance
                ? rule.InheritanceFlags == (InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit) && rule.PropagationFlags == PropagationFlags.None
                : rule.InheritanceFlags == InheritanceFlags.None && rule.PropagationFlags == PropagationFlags.None;
            if (rule.IsInherited || rule.AccessControlType != AccessControlType.Allow || !allowed.Contains(sid) ||
                (rule.FileSystemRights & FileSystemRights.FullControl) != FileSystemRights.FullControl || !inheritanceIsExact)
                throw new UnauthorizedAccessException("UXP authentication ACL grants access outside the current-user boundary.");
        }
        if (rules.Count != allowed.Count) throw new UnauthorizedAccessException("UXP authentication ACL is incomplete.");
    }

    private static SecurityIdentifier CurrentUser() => WindowsIdentity.GetCurrent().User ?? throw new UnauthorizedAccessException("Current Windows identity is unavailable.");
    private static SecurityIdentifier[] AllowedIdentities(SecurityIdentifier currentUser) =>
    [
        currentUser,
        new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
        new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
    ];
}
