using System.Security.Cryptography;
using System.IO;

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
        Directory.CreateDirectory(root);
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
}
