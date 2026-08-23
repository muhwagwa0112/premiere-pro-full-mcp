using System.Security.Cryptography;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

namespace PremiereMcp.WindowsUiAgent;

internal static class SecretStore
{
    private static readonly byte[] Entropy = "PremiereMCP.local.v1"u8.ToArray();

    internal static T UseSecret<T>(string name, Func<byte[], T> operation)
    {
        if (!name.All(c => char.IsLetterOrDigit(c) || c is '-' or '_') || name.Length is < 3 or > 64)
        {
            throw new ArgumentException("Secret name is invalid.", nameof(name));
        }

        var root = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "PremiereMCP",
            "secrets");
        EnsureCurrentUserDirectory(root);
        var path = Path.Combine(root, $"{name}.dpapi");

        byte[] protectedValue;
        try
        {
            protectedValue = File.ReadAllBytes(path);
        }
        catch (FileNotFoundException)
        {
            var raw = RandomNumberGenerator.GetBytes(32);
            protectedValue = ProtectedData.Protect(raw, Entropy, DataProtectionScope.CurrentUser);
            try
            {
                using var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                stream.Write(protectedValue);
            }
            catch (IOException) when (File.Exists(path))
            {
                protectedValue = File.ReadAllBytes(path);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(raw);
            }
        }

        var value = ProtectedData.Unprotect(protectedValue, Entropy, DataProtectionScope.CurrentUser);
        try
        {
            if (value.Length != 32) throw new CryptographicException("Stored secret has an invalid length.");
            return operation(value);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(value);
        }
    }

    internal static string GetOrCreateToken(string name) =>
        UseSecret(name, Convert.ToHexString);

    internal static string ProtectText(string purpose, string value)
    {
        var entropy = SHA256.HashData(Entropy.Concat(Encoding.UTF8.GetBytes(purpose)).ToArray());
        var protectedValue = ProtectedData.Protect(Encoding.UTF8.GetBytes(value), entropy, DataProtectionScope.CurrentUser);
        return Convert.ToBase64String(protectedValue);
    }

    internal static string UnprotectText(string purpose, string ciphertext)
    {
        var entropy = SHA256.HashData(Entropy.Concat(Encoding.UTF8.GetBytes(purpose)).ToArray());
        var value = ProtectedData.Unprotect(Convert.FromBase64String(ciphertext), entropy, DataProtectionScope.CurrentUser);
        return new UTF8Encoding(false, true).GetString(value);
    }

    internal static void EnsureCurrentUserDirectory(string path)
    {
        Directory.CreateDirectory(path);
        var identity = WindowsIdentity.GetCurrent().User ?? throw new UnauthorizedAccessException("Current Windows identity is unavailable.");
        var security = new DirectorySecurity();
        security.SetOwner(identity);
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.AddAccessRule(new FileSystemAccessRule(identity, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        new DirectoryInfo(path).SetAccessControl(security);
    }
}
