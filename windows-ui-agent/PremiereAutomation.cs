using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Automation;

namespace PremiereMcp.WindowsUiAgent;

public sealed record SemanticAdapterCatalogArgs;
public sealed record SemanticAdapterInvokeArgs(string AdapterId, int AdapterVersion, string HostBuild, string Locale, string UiFingerprint);

public interface IPremiereAutomation
{
    object InspectWindow();
    object CatalogAdapters(SemanticAdapterCatalogArgs args);
    object InvokeAdapter(SemanticAdapterInvokeArgs args);
}

public sealed class PremiereAutomation : IPremiereAutomation
{
    private static readonly HashSet<string> PremiereProcessNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "Adobe Premiere Pro", "Adobe Premiere Pro Beta"
    };

    private static readonly SemanticAdapterDefinition[] AdapterRegistry =
    {
        new(
            "premiere.workspace.editing", 1, "26.3.2",
            new HashSet<string>(new[] { "en-US", "ko-KR" }, StringComparer.OrdinalIgnoreCase),
            new SemanticLocator("WorkspaceBar", ControlType.ToolBar),
            new SemanticLocator("EditingWorkspace", ControlType.RadioButton),
            "select", "selection-item-is-selected")
    };

    public object InspectWindow()
    {
        var foreground = GetForegroundPremiereWindow();
        var processes = Process.GetProcesses().Where(IsPremiereProcess).Select(process => new
        {
            processId = process.Id,
            processName = process.ProcessName,
            hostBuild = SafeFileVersion(process),
            hasMainWindow = process.MainWindowHandle != IntPtr.Zero,
            isForeground = foreground is not null && process.Id == foreground.Value.ProcessId
        }).ToArray();
        if (foreground is null) return new { isRunning = processes.Length > 0, isForeground = false, processes };

        var element = AutomationElement.FromHandle(foreground.Value.Handle);
        var bounds = element.Current.BoundingRectangle;
        return new
        {
            isRunning = true,
            isForeground = true,
            processes,
            window = new
            {
                processId = foreground.Value.ProcessId,
                hostBuild = HostBuild(foreground.Value.ProcessId),
                locale = UiLocale(element),
                name = element.Current.Name,
                automationId = element.Current.AutomationId,
                controlType = element.Current.ControlType.ProgrammaticName,
                bounds = new { left = bounds.Left, top = bounds.Top, width = bounds.Width, height = bounds.Height }
            }
        };
    }

    public object CatalogAdapters(SemanticAdapterCatalogArgs args)
    {
        ArgumentNullException.ThrowIfNull(args);
        var context = ForegroundContext("semantic adapter discovery");
        var adapters = new List<object>();
        foreach (var definition in AdapterRegistry)
        {
            if (!definition.Supports(context.HostBuild, context.Locale)) continue;
            try
            {
                var target = FindTarget(context.Root, definition);
                if (!SupportsAction(target, definition.Action)) continue;
                adapters.Add(new
                {
                    adapterId = definition.Id,
                    adapterVersion = definition.Version,
                    hostBuild = context.HostBuild,
                    locale = context.Locale,
                    uiFingerprint = UiFingerprint(context, definition, target),
                    postcondition = definition.Postcondition
                });
            }
            catch (ControlNotFoundException)
            {
                // A missing targeted anchor makes only this adapter unavailable.
            }
        }
        return new { registryVersion = 1, hostBuild = context.HostBuild, locale = context.Locale, adapters };
    }

    public object InvokeAdapter(SemanticAdapterInvokeArgs args)
    {
        ArgumentNullException.ThrowIfNull(args);
        var definition = AdapterRegistry.SingleOrDefault(candidate =>
            string.Equals(candidate.Id, args.AdapterId, StringComparison.Ordinal) && candidate.Version == args.AdapterVersion)
            ?? throw new RequestValidationException("The semantic adapter ID and version are not registered.");
        var context = ForegroundContext("UI mutation");
        if (!definition.Supports(context.HostBuild, context.Locale) ||
            !string.Equals(context.HostBuild, args.HostBuild, StringComparison.Ordinal) ||
            !string.Equals(context.Locale, args.Locale, StringComparison.OrdinalIgnoreCase))
            throw new ControlActionException("The Premiere host build or UI locale changed or is not approved for this adapter version.");

        var target = FindTarget(context.Root, definition);
        var currentFingerprint = UiFingerprint(context, definition, target);
        if (!FixedTimeTextEquals(currentFingerprint, args.UiFingerprint))
            throw new ControlActionException("The targeted Premiere UI fingerprint changed; refresh the semantic adapter catalog.");
        if (!SupportsAction(target, definition.Action))
            throw new ControlActionException("The registered semantic action is no longer supported by its target.");

        ExecuteAction(target, definition.Action);
        if (!VerifyPostcondition(target, definition.Postcondition))
            throw new AutomationOperationException("ui_postcondition_failed", "The semantic UI action was dispatched, but its postcondition could not be verified.", false);

        return new
        {
            invoked = true,
            adapterId = definition.Id,
            adapterVersion = definition.Version,
            hostBuild = context.HostBuild,
            locale = context.Locale,
            uiFingerprint = currentFingerprint,
            postcondition = new { verified = true, method = definition.Postcondition },
            processId = context.ProcessId
        };
    }

    private static ForegroundUiContext ForegroundContext(string purpose)
    {
        var foreground = GetForegroundPremiereWindow();
        if (foreground is null) throw new PremiereNotForegroundException($"Adobe Premiere Pro must be the foreground application for {purpose}.");
        var root = AutomationElement.FromHandle(foreground.Value.Handle);
        return new ForegroundUiContext(foreground.Value.ProcessId, foreground.Value.Handle.ToInt64(), HostBuild(foreground.Value.ProcessId), UiLocale(root), root);
    }

    private static AutomationElement FindTarget(AutomationElement root, SemanticAdapterDefinition definition)
    {
        var ancestor = root.FindFirst(TreeScope.Descendants, ExactCondition(definition.Ancestor));
        if (ancestor is null) throw new ControlNotFoundException("The registered semantic adapter ancestor was not found.");
        return ancestor.FindFirst(TreeScope.Descendants, ExactCondition(definition.Target))
            ?? throw new ControlNotFoundException("The registered semantic adapter target was not found under its approved ancestor.");
    }

    private static Condition ExactCondition(SemanticLocator locator) => new AndCondition(
        new PropertyCondition(AutomationElement.AutomationIdProperty, locator.AutomationId),
        new PropertyCondition(AutomationElement.ControlTypeProperty, locator.ControlType));

    private static bool SupportsAction(AutomationElement element, string action) =>
        action == "select" && element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out _);

    private static void ExecuteAction(AutomationElement target, string action)
    {
        if (action == "select" && target.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var selection))
        {
            ((SelectionItemPattern)selection).Select();
            return;
        }
        throw new ControlActionException("The registered semantic action is unavailable.");
    }

    private static bool VerifyPostcondition(AutomationElement target, string postcondition) =>
        postcondition == "selection-item-is-selected" &&
        target.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var selection) &&
        ((SelectionItemPattern)selection).Current.IsSelected;

    private static string UiFingerprint(ForegroundUiContext context, SemanticAdapterDefinition definition, AutomationElement target)
    {
        var material = string.Join("|", new[]
        {
            "premiere-ui-semantic-v1", definition.Id, definition.Version.ToString(CultureInfo.InvariantCulture),
            context.HostBuild, context.Locale, context.WindowHandle.ToString(CultureInfo.InvariantCulture),
            definition.Ancestor.AutomationId, definition.Ancestor.ControlType.ProgrammaticName,
            target.Current.AutomationId, target.Current.ControlType.ProgrammaticName, definition.Action, definition.Postcondition
        });
        return "sha256:" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(material))).ToLowerInvariant();
    }

    private static bool FixedTimeTextEquals(string expected, string actual)
    {
        var expectedBytes = Encoding.ASCII.GetBytes(expected.ToLowerInvariant());
        var actualBytes = Encoding.ASCII.GetBytes(actual.ToLowerInvariant());
        return expectedBytes.Length == actualBytes.Length && CryptographicOperations.FixedTimeEquals(expectedBytes, actualBytes);
    }

    private static string HostBuild(int processId)
    {
        try { using var process = Process.GetProcessById(processId); return SafeFileVersion(process); }
        catch (ArgumentException) { throw new AutomationOperationException("host_identity_unavailable", "Premiere exited before its build could be verified.", true); }
    }

    private static string SafeFileVersion(Process process)
    {
        try { return process.MainModule?.FileVersionInfo.FileVersion ?? "unknown"; }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception) { return "unknown"; }
    }

    private static string UiLocale(AutomationElement root)
    {
        try
        {
            var value = root.GetCurrentPropertyValue(AutomationElement.CultureProperty, true);
            var lcid = value is int culture ? culture : 0;
            return lcid > 0 ? CultureInfo.GetCultureInfo(lcid).Name : "unknown";
        }
        catch (CultureNotFoundException) { return "unknown"; }
    }

    private static (IntPtr Handle, int ProcessId)? GetForegroundPremiereWindow()
    {
        var handle = GetForegroundWindow();
        if (handle == IntPtr.Zero) return null;
        _ = GetWindowThreadProcessId(handle, out var processId);
        try { using var process = Process.GetProcessById((int)processId); return IsPremiereProcess(process) ? (handle, process.Id) : null; }
        catch (ArgumentException) { return null; }
    }

    private static bool IsPremiereProcess(Process process) => PremiereProcessNames.Contains(process.ProcessName);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    private sealed record SemanticLocator(string AutomationId, ControlType ControlType);
    private sealed record SemanticAdapterDefinition(string Id, int Version, string HostBuildPrefix, HashSet<string> Locales, SemanticLocator Ancestor, SemanticLocator Target, string Action, string Postcondition)
    {
        internal bool Supports(string hostBuild, string locale) =>
            (string.Equals(hostBuild, HostBuildPrefix, StringComparison.Ordinal) || hostBuild.StartsWith(HostBuildPrefix + ".", StringComparison.Ordinal)) &&
            Locales.Contains(locale);
    }
    private sealed record ForegroundUiContext(int ProcessId, long WindowHandle, string HostBuild, string Locale, AutomationElement Root);
}
