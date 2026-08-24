using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using PremiereMcp.WindowsUiAgent;
using Xunit;

namespace PremiereMcp.WindowsUiAgent.Tests;

public sealed class TrustProfileStoreTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "ppmcp-profile-" + Guid.NewGuid().ToString("N"));

    [Fact]
    public void RoundTripsStrictProfileWithUserAndInstallBinding()
    {
        var store = CreateStore(Binding("S-1-5-21-100"));
        var json = ValidProfile();
        store.WriteProtected("studio-unattended", json);

        using var actual = JsonDocument.Parse(store.Read("studio-unattended"));
        Assert.Equal("trusted_unattended", actual.RootElement.GetProperty("mode").GetString());
        Assert.True(File.Exists(Path.Combine(_root, "studio-unattended.dpapi")));
    }

    [Fact]
    public void RejectsSidMismatchEvenWhenProtectedPayloadCanBeDecoded()
    {
        CreateStore(Binding("S-1-5-21-100")).WriteProtected("studio-unattended", ValidProfile());
        var otherUser = CreateStore(Binding("S-1-5-21-200"));

        Assert.Throws<CryptographicException>(() => otherUser.Read("studio-unattended"));
    }

    [Fact]
    public void RejectsInstallAndLauncherBindingMismatch()
    {
        CreateStore(Binding("S-1-5-21-100")).WriteProtected("studio-unattended", ValidProfile());
        var changedInstall = Binding("S-1-5-21-100") with { InstallRootDigest = new string('b', 64) };
        var changedLauncher = Binding("S-1-5-21-100") with { LauncherDigest = new string('c', 64) };

        Assert.Throws<CryptographicException>(() => CreateStore(changedInstall).Read("studio-unattended"));
        Assert.Throws<CryptographicException>(() => CreateStore(changedLauncher).Read("studio-unattended"));
    }

    [Fact]
    public void RejectsCiphertextTamperingAndUnknownSchemaFields()
    {
        var store = CreateStore(Binding("S-1-5-21-100"));
        store.WriteProtected("studio-unattended", ValidProfile());
        var path = Path.Combine(_root, "studio-unattended.dpapi");
        File.AppendAllText(path, "tamper", Encoding.UTF8);
        Assert.Throws<CryptographicException>(() => store.Read("studio-unattended"));

        Assert.Throws<InvalidDataException>(() => store.WriteProtected("studio-unattended", ValidProfile().Replace("\"schemaVersion\":1", "\"schemaVersion\":1,\"bypassPolicy\":true", StringComparison.Ordinal)));
        Assert.Throws<InvalidDataException>(() => store.WriteProtected("studio-unattended", ValidProfile().Replace("\"schemaVersion\":1", "\"schemaVersion\":2", StringComparison.Ordinal)));
    }

    [Fact]
    public void EnrollmentAndRevocationCreatePrivacySafeAuditEvents()
    {
        var source = Path.Combine(Path.GetTempPath(), "ppmcp-enroll-" + Guid.NewGuid().ToString("N") + ".json");
        try
        {
            File.WriteAllText(source, ValidProfile(), new UTF8Encoding(false));
            var store = CreateStore(Binding("S-1-5-21-100"));
            store.EnrollFile(source);
            store.Revoke("studio-unattended");

            var audit = File.ReadAllText(Path.Combine(_root, "audit.jsonl"));
            Assert.Contains("\"eventName\":\"enroll\"", audit, StringComparison.Ordinal);
            Assert.Contains("\"eventName\":\"revoke\"", audit, StringComparison.Ordinal);
            Assert.DoesNotContain(source, audit, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("S-1-5-21-100", audit, StringComparison.Ordinal);
            Assert.DoesNotContain("approvedRoots", audit, StringComparison.Ordinal);
        }
        finally { if (File.Exists(source)) File.Delete(source); }
    }

    [Fact]
    public void DpapiCurrentUserRoundTripRejectsCiphertextTamper()
    {
        var store = new TrustProfileStore(_root, Binding("S-1-5-21-100"), SecretStore.ProtectText, SecretStore.UnprotectText);
        store.WriteProtected("studio-unattended", ValidProfile());
        Assert.Contains("studio-unattended", store.Read("studio-unattended"), StringComparison.Ordinal);

        var path = Path.Combine(_root, "studio-unattended.dpapi");
        var ciphertext = File.ReadAllText(path);
        var index = ciphertext.Length / 2;
        var replacement = ciphertext[index] == 'A' ? 'B' : 'A';
        File.WriteAllText(path, ciphertext[..index] + replacement + ciphertext[(index + 1)..], Encoding.UTF8);
        Assert.ThrowsAny<CryptographicException>(() => store.Read("studio-unattended"));
    }

    private TrustProfileStore CreateStore(TrustProfileBinding binding) => new(
        _root,
        binding,
        (_, plain) => Convert.ToBase64String(Encoding.UTF8.GetBytes(plain)),
        (_, cipher) =>
        {
            try { return Encoding.UTF8.GetString(Convert.FromBase64String(cipher)); }
            catch (FormatException ex) { throw new CryptographicException("tampered", ex); }
        });

    private static TrustProfileBinding Binding(string sid) => new(sid, "premiere-pro-full-mcp", new string('a', 64), new string('d', 64));

    private static string ValidProfile() => """
        {
          "schemaVersion":1,
          "profileId":"studio-unattended",
          "mode":"trusted_unattended",
          "premiereVersions":["26.3.*"],
          "riskCeiling":"R3",
          "actionAllow":["*"],
          "actionDeny":[],
          "approvedRoots":["D:\\PremiereAutomation"],
          "capabilities":{"overwrite":true,"delete":true,"thirdPartyPluginUi":true,"cloudPublish":false,"cloudShare":false,"purchase":false},
          "checkpoint":{"beforeFirstMutation":true,"beforeNonUndoable":true,"intervalOperations":50,"retainCount":10},
          "limits":{"maxOperations":5000,"maxRuntimeMinutes":360},
          "unexpectedModalPolicy":"pause_and_report"
        }
        """;

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }
}
