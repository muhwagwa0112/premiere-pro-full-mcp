using System.Security.Cryptography;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace PremiereMcp.WindowsUiAgent;

internal sealed record TrustProfileBinding(
    string UserSid,
    string ProductId,
    string InstallRootDigest,
    string LauncherDigest);

internal sealed record ProtectedTrustProfileEnvelope(
    int EnvelopeVersion,
    TrustProfileBinding Binding,
    JsonElement Profile);

internal sealed class TrustProfileStore
{
    private const int MaxProfileBytes = 1024 * 1024;
    private static readonly JsonSerializerOptions StrictJson = new(JsonSerializerDefaults.Web)
    {
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };
    private readonly string _root;
    private readonly TrustProfileBinding _binding;
    private readonly Func<string, string, string> _protect;
    private readonly Func<string, string, string> _unprotect;

    internal TrustProfileStore(
        string root,
        TrustProfileBinding binding,
        Func<string, string, string> protect,
        Func<string, string, string> unprotect)
    {
        _root = Path.GetFullPath(root);
        _binding = binding;
        _protect = protect;
        _unprotect = unprotect;
    }

    internal static TrustProfileStore CreateDefault()
    {
        var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "PremiereMCP", "trust-profiles");
        return new TrustProfileStore(root, BrokerSecurity.GetTrustProfileBinding(), SecretStore.ProtectText, SecretStore.UnprotectText);
    }

    internal void EnrollFile(string sourcePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sourcePath);
        string? profileId = null;
        try
        {
            var source = Path.GetFullPath(sourcePath);
            var info = new FileInfo(source);
            if (!info.Exists || info.Length > MaxProfileBytes) throw new InvalidDataException("Enrollment source is missing or too large.");
            var json = File.ReadAllText(source, new UTF8Encoding(false, true));
            using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 32 });
            profileId = RequiredString(document.RootElement, "profileId", 3, 64);
            WriteProtected(profileId, json);
            AppendAudit("enroll", profileId, "success");
        }
        catch
        {
            AppendAudit("enroll", profileId, "failure");
            throw;
        }
    }

    internal void Revoke(string profileId)
    {
        ValidateProfileId(profileId);
        try
        {
            var path = ProfilePath(profileId);
            if (!File.Exists(path)) throw new FileNotFoundException("Trust profile does not exist.");
            File.Delete(path);
            AppendAudit("revoke", profileId, "success");
        }
        catch
        {
            AppendAudit("revoke", profileId, "failure");
            throw;
        }
    }

    internal void WriteProtected(string profileId, string profileJson)
    {
        ValidateProfileId(profileId);
        if (Encoding.UTF8.GetByteCount(profileJson) > MaxProfileBytes) throw new InvalidDataException("Trust profile exceeds 1 MiB.");
        using var profileDocument = JsonDocument.Parse(profileJson, new JsonDocumentOptions { MaxDepth = 32 });
        ValidateProfile(profileDocument.RootElement, profileId);
        var envelope = new ProtectedTrustProfileEnvelope(1, _binding, profileDocument.RootElement.Clone());
        var serialized = JsonSerializer.Serialize(envelope, StrictJson);
        var protectedText = _protect(Purpose(profileId), serialized);

        SecretStore.EnsureCurrentUserDirectory(_root);
        var target = ProfilePath(profileId);
        var temporary = target + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
            using (var writer = new StreamWriter(stream, new UTF8Encoding(false)))
            {
                writer.Write(protectedText);
                writer.Flush();
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporary, target, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    internal string Read(string profileId)
    {
        ValidateProfileId(profileId);
        var protectedText = File.ReadAllText(ProfilePath(profileId), Encoding.UTF8);
        if (Encoding.UTF8.GetByteCount(protectedText) > MaxProfileBytes * 2) throw new InvalidDataException("Protected trust profile is too large.");
        var serialized = _unprotect(Purpose(profileId), protectedText);
        ProtectedTrustProfileEnvelope? envelope;
        try
        {
            envelope = JsonSerializer.Deserialize<ProtectedTrustProfileEnvelope>(serialized, StrictJson);
        }
        catch (JsonException ex)
        {
            throw new CryptographicException("Protected trust profile envelope is invalid.", ex);
        }
        if (envelope is null || envelope.EnvelopeVersion != 1 || !BindingEquals(envelope.Binding, _binding))
            throw new CryptographicException("Trust profile user or installation binding does not match.");
        ValidateProfile(envelope.Profile, profileId);
        return envelope.Profile.GetRawText();
    }

    private string Purpose(string profileId)
    {
        var binding = $"{_binding.UserSid}\n{_binding.ProductId}\n{_binding.InstallRootDigest}\n{_binding.LauncherDigest}";
        var digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(binding))).ToLowerInvariant();
        return $"trust-profile-v1:{profileId}:{digest}";
    }

    private string ProfilePath(string profileId) => Path.Combine(_root, profileId + ".dpapi");

    private void AppendAudit(string eventName, string? profileId, string outcome)
    {
        SecretStore.EnsureCurrentUserDirectory(_root);
        var profileKey = profileId is null ? null : Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(profileId))).ToLowerInvariant();
        var record = JsonSerializer.Serialize(new { schemaVersion = 1, timestampUtc = DateTimeOffset.UtcNow, eventName, profileKey, outcome });
        using var stream = new FileStream(Path.Combine(_root, "audit.jsonl"), FileMode.Append, FileAccess.Write, FileShare.Read);
        using var writer = new StreamWriter(stream, new UTF8Encoding(false));
        writer.WriteLine(record);
    }

    private static bool BindingEquals(TrustProfileBinding left, TrustProfileBinding right) =>
        FixedTimeTextEquals(left.UserSid, right.UserSid) &&
        FixedTimeTextEquals(left.ProductId, right.ProductId) &&
        FixedTimeTextEquals(left.InstallRootDigest, right.InstallRootDigest) &&
        FixedTimeTextEquals(left.LauncherDigest, right.LauncherDigest);

    private static bool FixedTimeTextEquals(string? left, string? right)
    {
        if (left is null || right is null) return false;
        var leftBytes = Encoding.UTF8.GetBytes(left);
        var rightBytes = Encoding.UTF8.GetBytes(right);
        return leftBytes.Length == rightBytes.Length && CryptographicOperations.FixedTimeEquals(leftBytes, rightBytes);
    }

    private static void ValidateProfileId(string profileId)
    {
        if (profileId.Length is < 3 or > 64 || profileId.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or '-')))
            throw new ArgumentException("Trust profile ID is invalid.", nameof(profileId));
    }

    private static void ValidateProfile(JsonElement profile, string expectedProfileId)
    {
        if (profile.ValueKind != JsonValueKind.Object) throw new InvalidDataException("Trust profile must be an object.");
        var allowed = new HashSet<string>(StringComparer.Ordinal)
        {
            "schemaVersion", "profileId", "mode", "premiereVersions", "riskCeiling", "actionAllow", "actionDeny",
            "approvedRoots", "capabilities", "checkpoint", "limits", "unexpectedModalPolicy"
        };
        RejectUnknown(profile, allowed, "trust profile");
        RequiredInt(profile, "schemaVersion", 1, 1);
        if (RequiredString(profile, "profileId", 3, 64) != expectedProfileId) throw new InvalidDataException("Trust profile ID does not match the broker request.");
        OneOf(RequiredString(profile, "mode", 1, 64), "interactive", "trusted_unattended", "isolated_lab");
        OneOf(RequiredString(profile, "riskCeiling", 2, 2), "R0", "R1", "R2", "R3");
        RequiredStringArray(profile, "approvedRoots", 1, 100, 3, 32767);
        OptionalStringArray(profile, "premiereVersions", 1, 100, 1, 64);
        OptionalStringArray(profile, "actionAllow", 0, 1000, 1, 256);
        OptionalStringArray(profile, "actionDeny", 0, 1000, 1, 256);

        var capabilities = RequiredObject(profile, "capabilities");
        var capabilityNames = new[] { "overwrite", "delete", "thirdPartyPluginUi", "cloudPublish", "cloudShare", "purchase" };
        RejectUnknown(capabilities, capabilityNames.ToHashSet(StringComparer.Ordinal), "capabilities");
        foreach (var name in capabilityNames) RequiredBoolean(capabilities, name);

        var checkpoint = RequiredObject(profile, "checkpoint");
        RejectUnknown(checkpoint, new[] { "beforeFirstMutation", "beforeNonUndoable", "intervalOperations", "retainCount" }.ToHashSet(StringComparer.Ordinal), "checkpoint");
        RequiredBoolean(checkpoint, "beforeFirstMutation");
        RequiredBoolean(checkpoint, "beforeNonUndoable");
        RequiredInt(checkpoint, "intervalOperations", 1, 1000);
        RequiredInt(checkpoint, "retainCount", 1, 100);

        if (profile.TryGetProperty("limits", out var limits))
        {
            if (limits.ValueKind != JsonValueKind.Object) throw new InvalidDataException("limits must be an object.");
            RejectUnknown(limits, new[] { "maxOperations", "maxRuntimeMinutes" }.ToHashSet(StringComparer.Ordinal), "limits");
            if (limits.TryGetProperty("maxOperations", out _)) RequiredInt(limits, "maxOperations", 1, int.MaxValue);
            if (limits.TryGetProperty("maxRuntimeMinutes", out _)) RequiredInt(limits, "maxRuntimeMinutes", 1, int.MaxValue);
        }
        if (profile.TryGetProperty("unexpectedModalPolicy", out var modal))
            OneOf(StringValue(modal, "unexpectedModalPolicy", 1, 64), "pause_and_report", "fail", "known_adapter_only");
    }

    private static void RejectUnknown(JsonElement value, HashSet<string> allowed, string label)
    {
        if (value.EnumerateObject().Any(property => !allowed.Contains(property.Name))) throw new InvalidDataException($"{label} contains an unknown property.");
    }

    private static JsonElement RequiredObject(JsonElement value, string name)
    {
        if (!value.TryGetProperty(name, out var property) || property.ValueKind != JsonValueKind.Object) throw new InvalidDataException($"{name} must be an object.");
        return property;
    }

    private static string RequiredString(JsonElement value, string name, int min, int max)
    {
        if (!value.TryGetProperty(name, out var property)) throw new InvalidDataException($"{name} is required.");
        return StringValue(property, name, min, max);
    }

    private static string StringValue(JsonElement value, string name, int min, int max)
    {
        if (value.ValueKind != JsonValueKind.String || value.GetString() is not { } result || result.Length < min || result.Length > max) throw new InvalidDataException($"{name} is invalid.");
        return result;
    }

    private static void RequiredBoolean(JsonElement value, string name)
    {
        if (!value.TryGetProperty(name, out var property) || property.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) throw new InvalidDataException($"{name} must be boolean.");
    }

    private static void RequiredInt(JsonElement value, string name, int min, int max)
    {
        if (!value.TryGetProperty(name, out var property) || !property.TryGetInt32(out var result) || result < min || result > max) throw new InvalidDataException($"{name} is invalid.");
    }

    private static void RequiredStringArray(JsonElement value, string name, int minItems, int maxItems, int minLength, int maxLength)
    {
        if (!value.TryGetProperty(name, out var property)) throw new InvalidDataException($"{name} is required.");
        ValidateStringArray(property, name, minItems, maxItems, minLength, maxLength);
    }

    private static void OptionalStringArray(JsonElement value, string name, int minItems, int maxItems, int minLength, int maxLength)
    {
        if (value.TryGetProperty(name, out var property)) ValidateStringArray(property, name, minItems, maxItems, minLength, maxLength);
    }

    private static void ValidateStringArray(JsonElement value, string name, int minItems, int maxItems, int minLength, int maxLength)
    {
        if (value.ValueKind != JsonValueKind.Array) throw new InvalidDataException($"{name} must be an array.");
        var items = value.EnumerateArray().ToArray();
        if (items.Length < minItems || items.Length > maxItems) throw new InvalidDataException($"{name} has an invalid item count.");
        foreach (var item in items) _ = StringValue(item, name, minLength, maxLength);
    }

    private static void OneOf(string value, params string[] allowed)
    {
        if (!allowed.Contains(value, StringComparer.Ordinal)) throw new InvalidDataException("Trust profile contains an unsupported enum value.");
    }
}
