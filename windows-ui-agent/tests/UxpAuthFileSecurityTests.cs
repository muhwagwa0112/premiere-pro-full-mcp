using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using Xunit;

namespace PremiereMcp.WindowsUiAgent.Tests;

public sealed class UxpAuthFileSecurityTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), $"ppmcp-uxp-acl-{Guid.NewGuid():N}");

    [Fact]
    public void InitialProvisionCreatesProtectedDirectoryAndSecret()
    {
        var identity = UxpAuthFileSecurity.Provision(_root);

        Assert.Equal(ValidPath(), identity.AuthFilePath);
        Assert.Matches("^[a-f0-9]{64}$", identity.Secret);
        Assert.Equal(identity.Secret, File.ReadAllText(identity.AuthFilePath));
        AssertStrictAcl(new DirectoryInfo(Path.GetDirectoryName(identity.AuthFilePath)!).GetAccessControl(), requireInheritance: true);
        AssertStrictAcl(new FileInfo(identity.AuthFilePath).GetAccessControl(), requireInheritance: false);
    }

    [Fact]
    public void UnsafeInheritedAclRotatesWithoutPreservingExistingSecret()
    {
        var foreign = new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null);
        CreateForeignReadableRoot(foreign);
        var path = ValidPath();
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var exposed = new string('d', 64);
        File.WriteAllText(path, exposed);
        Assert.Contains(Rules(new FileInfo(path).GetAccessControl()), rule => ((SecurityIdentifier)rule.IdentityReference).Equals(foreign));

        var identity = UxpAuthFileSecurity.Provision(_root);

        Assert.NotEqual(exposed, identity.Secret);
        Assert.Equal(identity.Secret, File.ReadAllText(path));
        AssertStrictAcl(new DirectoryInfo(Path.GetDirectoryName(path)!).GetAccessControl(), requireInheritance: true);
        AssertStrictAcl(new FileInfo(path).GetAccessControl(), requireInheritance: false);
    }

    [Fact]
    public void StrictValidProvisionIsPreserved()
    {
        var first = UxpAuthFileSecurity.Provision(_root);
        var firstWrite = File.GetLastWriteTimeUtc(first.AuthFilePath);

        var second = UxpAuthFileSecurity.Provision(_root);

        Assert.Equal(first, second);
        Assert.Equal(firstWrite, File.GetLastWriteTimeUtc(first.AuthFilePath));
    }

    [Fact]
    public void ProtectedBoundaryContainsNoForeignReadAce()
    {
        var identity = UxpAuthFileSecurity.Provision(_root);
        var foreign = new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null);

        Assert.DoesNotContain(Rules(new DirectoryInfo(Path.GetDirectoryName(identity.AuthFilePath)!).GetAccessControl()), rule => ((SecurityIdentifier)rule.IdentityReference).Equals(foreign));
        Assert.DoesNotContain(Rules(new FileInfo(identity.AuthFilePath).GetAccessControl()), rule => ((SecurityIdentifier)rule.IdentityReference).Equals(foreign));
    }

    [Fact]
    public void ProtectsSecretFromInheritedForeignReadBeforeReturningIt()
    {
        var foreign = new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null);
        var rootSecurity = new DirectorySecurity();
        var currentUser = WindowsIdentity.GetCurrent().User!;
        rootSecurity.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        rootSecurity.AddAccessRule(new FileSystemAccessRule(
            currentUser,
            FileSystemRights.FullControl,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None,
            AccessControlType.Allow));
        rootSecurity.AddAccessRule(new FileSystemAccessRule(
            foreign,
            FileSystemRights.ReadAndExecute,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None,
            AccessControlType.Allow));
        Directory.CreateDirectory(_root);
        new DirectoryInfo(_root).SetAccessControl(rootSecurity);

        var path = ValidPath();
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var secret = new string('a', 64);
        File.WriteAllText(path, secret);
        Assert.Contains(new FileInfo(path).GetAccessControl().GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>(),
            rule => rule.IsInherited && ((SecurityIdentifier)rule.IdentityReference).Equals(foreign));

        Assert.Equal(secret, UxpAuthFileSecurity.ProtectAndRead(path, _root));

        var security = new FileInfo(path).GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access);
        Assert.True(security.AreAccessRulesProtected);
        Assert.DoesNotContain(security.GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>(),
            rule => ((SecurityIdentifier)rule.IdentityReference).Equals(foreign));
    }

    [Fact]
    public void RejectsPathsOutsideExactPluginDataShape()
    {
        Directory.CreateDirectory(_root);
        var outsideDirectory = _root + "-outside";
        Directory.CreateDirectory(outsideDirectory);
        var outside = Path.Combine(outsideDirectory, UxpAuthFileSecurity.AuthFileName);
        File.WriteAllText(outside, new string('b', 64));
        Assert.Throws<UnauthorizedAccessException>(() => UxpAuthFileSecurity.ProtectAndRead(outside, _root));

        var otherPlugin = Path.Combine(_root, "26", "External", "com.example.attacker", "PluginData", UxpAuthFileSecurity.AuthFileName);
        Directory.CreateDirectory(Path.GetDirectoryName(otherPlugin)!);
        File.WriteAllText(otherPlugin, new string('c', 64));
        Assert.Throws<UnauthorizedAccessException>(() => UxpAuthFileSecurity.ProtectAndRead(otherPlugin, _root));
    }

    [Fact]
    public void RejectsMalformedSecret()
    {
        var path = ValidPath();
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, new string('Z', 64));
        Assert.Throws<InvalidDataException>(() => UxpAuthFileSecurity.ProtectAndRead(path, _root));
    }

    private string ValidPath() => Path.Combine(
        _root, "26", "External", UxpAuthFileSecurity.PluginId, "PluginData", UxpAuthFileSecurity.AuthFileName);

    private void CreateForeignReadableRoot(SecurityIdentifier foreign)
    {
        Directory.CreateDirectory(_root);
        var currentUser = WindowsIdentity.GetCurrent().User!;
        var security = new DirectorySecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.AddAccessRule(new FileSystemAccessRule(currentUser, FileSystemRights.FullControl, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        security.AddAccessRule(new FileSystemAccessRule(foreign, FileSystemRights.ReadAndExecute, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
        new DirectoryInfo(_root).SetAccessControl(security);
    }

    private static IEnumerable<FileSystemAccessRule> Rules(FileSystemSecurity security) =>
        security.GetAccessRules(true, true, typeof(SecurityIdentifier)).Cast<FileSystemAccessRule>();

    private static void AssertStrictAcl(FileSystemSecurity security, bool requireInheritance)
    {
        var current = WindowsIdentity.GetCurrent().User!;
        var allowed = new[]
        {
            current,
            new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
            new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
        }.Select(value => value.Value).ToHashSet(StringComparer.Ordinal);
        Assert.True(security.AreAccessRulesProtected);
        var rules = Rules(security).ToArray();
        Assert.Equal(3, rules.Length);
        Assert.All(rules, rule =>
        {
            Assert.False(rule.IsInherited);
            Assert.Equal(AccessControlType.Allow, rule.AccessControlType);
            Assert.Contains(((SecurityIdentifier)rule.IdentityReference).Value, allowed);
            Assert.Equal(requireInheritance ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None, rule.InheritanceFlags);
        });
    }

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
        if (Directory.Exists(_root + "-outside")) Directory.Delete(_root + "-outside", recursive: true);
    }
}
