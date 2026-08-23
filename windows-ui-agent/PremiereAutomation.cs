using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Automation;

namespace PremiereMcp.WindowsUiAgent;

public sealed record ControlInvokeArgs(
    string Capability,
    string AutomationId,
    string ControlType,
    string Action,
    string? ExpectedName = null,
    int? ExpectedProcessId = null,
    long? ExpectedWindowHandle = null);
public sealed record ControlCatalogArgs(int Offset, int Limit);

public interface IPremiereAutomation
{
    object InspectWindow();
    object CatalogControls(ControlCatalogArgs args);
    object InvokeControl(ControlInvokeArgs args);
}

public sealed class PremiereAutomation : IPremiereAutomation
{
    private const int CatalogTraversalNodeLimit = 5000;
    private static readonly TimeSpan CatalogTraversalTimeLimit = TimeSpan.FromSeconds(8);
    private static readonly HashSet<string> PremiereProcessNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "Adobe Premiere Pro",
        "Adobe Premiere Pro Beta"
    };

    private static readonly IReadOnlyDictionary<string, ControlType> AllowedControlTypes =
        new Dictionary<string, ControlType>(StringComparer.Ordinal)
        {
            ["Button"] = ControlType.Button,
            ["MenuItem"] = ControlType.MenuItem,
            ["CheckBox"] = ControlType.CheckBox,
            ["RadioButton"] = ControlType.RadioButton,
            ["ListItem"] = ControlType.ListItem,
            ["TabItem"] = ControlType.TabItem
        };

    private static readonly HashSet<string> AllowedActions = new(StringComparer.Ordinal)
    {
        "invoke",
        "toggle",
        "select"
    };

    private static readonly IReadOnlyDictionary<string, HashSet<string>> ActionsByControlType =
        new Dictionary<string, HashSet<string>>(StringComparer.Ordinal)
        {
            ["Button"] = new(StringComparer.Ordinal) { "invoke" },
            ["MenuItem"] = new(StringComparer.Ordinal) { "invoke" },
            ["CheckBox"] = new(StringComparer.Ordinal) { "toggle" },
            ["RadioButton"] = new(StringComparer.Ordinal) { "select" },
            ["ListItem"] = new(StringComparer.Ordinal) { "select" },
            ["TabItem"] = new(StringComparer.Ordinal) { "select" }
        };

    public object InspectWindow()
    {
        var foreground = GetForegroundPremiereWindow();
        var processes = Process.GetProcesses()
            .Where(IsPremiereProcess)
            .Select(process => new
            {
                processId = process.Id,
                processName = process.ProcessName,
                hasMainWindow = process.MainWindowHandle != IntPtr.Zero,
                isForeground = foreground is not null && process.Id == foreground.Value.ProcessId
            })
            .ToArray();

        if (foreground is null)
        {
            return new { isRunning = processes.Length > 0, isForeground = false, processes };
        }

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
                name = element.Current.Name,
                automationId = element.Current.AutomationId,
                controlType = element.Current.ControlType.ProgrammaticName,
                bounds = new { left = bounds.Left, top = bounds.Top, width = bounds.Width, height = bounds.Height }
            }
        };
    }

    public object InvokeControl(ControlInvokeArgs args)
    {
        if (!AllowedControlTypes.TryGetValue(args.ControlType, out var controlType))
        {
            throw new RequestValidationException("controlType is not allowlisted.");
        }

        if (!AllowedActions.Contains(args.Action))
        {
            throw new RequestValidationException("action is not allowlisted.");
        }

        if (!ActionsByControlType[args.ControlType].Contains(args.Action))
        {
            throw new RequestValidationException("action is not allowlisted for the specified controlType.");
        }

        var foreground = GetForegroundPremiereWindow();
        if (foreground is null)
        {
            throw new PremiereNotForegroundException("Adobe Premiere Pro must be the foreground application for UI mutations.");
        }
        if (args.ExpectedProcessId is null || args.ExpectedWindowHandle is null || args.ExpectedName is null)
        {
            throw new RequestValidationException("ui.invoke requires catalog-bound foreground context.");
        }
        if (foreground.Value.ProcessId != args.ExpectedProcessId || foreground.Value.Handle.ToInt64() != args.ExpectedWindowHandle)
        {
            throw new ControlActionException("The foreground Premiere window changed after ui.catalog; request a new capability.");
        }

        var root = AutomationElement.FromHandle(foreground.Value.Handle);
        var condition = new AndCondition(
            new PropertyCondition(AutomationElement.AutomationIdProperty, args.AutomationId),
            new PropertyCondition(AutomationElement.ControlTypeProperty, controlType));
        var matches = root.FindAll(TreeScope.Descendants, condition);

        if (matches.Count == 0)
        {
            throw new ControlNotFoundException("No matching semantic control was found in the foreground Premiere window.");
        }

        if (matches.Count > 1)
        {
            throw new ControlActionException("The semantic target is ambiguous; automationId and controlType matched multiple controls.");
        }

        var target = matches[0];
        if (!string.Equals(target.Current.Name, args.ExpectedName, StringComparison.Ordinal))
        {
            throw new ControlActionException("The semantic control changed after ui.catalog; request a new capability.");
        }
        if (!SupportsAction(target, args.Action))
        {
            throw new ControlActionException("The semantic action is no longer supported by the catalogued control.");
        }
        ExecuteAction(target, args.Action);

        return new
        {
            invoked = true,
            automationId = args.AutomationId,
            controlType = args.ControlType,
            action = args.Action,
            processId = foreground.Value.ProcessId
        };
    }

    public object CatalogControls(ControlCatalogArgs args)
    {
        if (args.Offset < 0 || args.Limit is < 1 or > 500)
        {
            throw new RequestValidationException("offset must be non-negative and limit must be between 1 and 500.");
        }

        var foreground = GetForegroundPremiereWindow();
        if (foreground is null)
        {
            throw new PremiereNotForegroundException("Adobe Premiere Pro must be the foreground application for semantic control discovery.");
        }

        var root = AutomationElement.FromHandle(foreground.Value.Handle);
        var walker = TreeWalker.ControlViewWalker;
        var pending = new Queue<AutomationElement>();
        var timer = Stopwatch.StartNew();
        var providerTruncated = EnqueueChildren(walker, root, pending, timer, CatalogTraversalNodeLimit);
        var controls = new List<object>();
        var matched = 0;
        var visited = 0;
        var missingAutomationIdCount = 0;
        var allowedTypeCount = 0;
        var patternSupportedCount = 0;
        var hasMore = false;

        while (pending.Count > 0 && visited < CatalogTraversalNodeLimit && timer.Elapsed < CatalogTraversalTimeLimit)
        {
            var element = pending.Dequeue();
            visited++;
            providerTruncated |= EnqueueChildren(walker, element, pending, timer, CatalogTraversalNodeLimit - visited);
            string automationId;
            ControlType controlType;
            string name;
            try
            {
                automationId = element.Current.AutomationId;
                controlType = element.Current.ControlType;
                name = element.Current.Name;
            }
            catch (ElementNotAvailableException)
            {
                continue;
            }

            if (string.IsNullOrWhiteSpace(automationId)) missingAutomationIdCount++;
            var typeName = AllowedControlTypes.FirstOrDefault(pair => pair.Value == controlType).Key;
            if (typeName is null) continue;
            allowedTypeCount++;
            var actions = ActionsByControlType[typeName].Where(action => SupportsAction(element, action)).ToArray();
            if (actions.Length == 0) continue;
            patternSupportedCount++;
            if (string.IsNullOrWhiteSpace(automationId)) continue;
            if (matched >= args.Offset)
            {
                if (controls.Count < args.Limit)
                {
                    controls.Add(new { automationId, controlType = typeName, name, actions });
                }
                else
                {
                    hasMore = true;
                    break;
                }
            }
            matched++;
        }

        var traversalComplete = pending.Count == 0 && !hasMore && !providerTruncated;
        var truncated = !traversalComplete;
        var nextOffset = hasMore || (truncated && controls.Count == args.Limit)
            ? args.Offset + controls.Count
            : (int?)null;

        return new
        {
            processId = foreground.Value.ProcessId,
            windowHandle = foreground.Value.Handle.ToInt64(),
            total = traversalComplete ? matched : (int?)null,
            offset = args.Offset,
            limit = args.Limit,
            nextOffset,
            traversal = new
            {
                visitedNodes = visited,
                missingAutomationIdCount,
                allowedTypeCount,
                patternSupportedCount,
                nodeLimit = CatalogTraversalNodeLimit,
                timeLimitMs = (int)CatalogTraversalTimeLimit.TotalMilliseconds,
                complete = traversalComplete,
                truncated
            },
            semanticControlsAvailable = matched > 0,
            reason = matched > 0
                ? null
                : missingAutomationIdCount > 0
                    ? "provider_exposes_no_stable_automation_ids"
                    : "provider_exposes_no_supported_semantic_controls",
            controls
        };
    }

    private static bool EnqueueChildren(
        TreeWalker walker,
        AutomationElement parent,
        Queue<AutomationElement> pending,
        Stopwatch timer,
        int remainingNodeBudget)
    {
        try
        {
            var child = walker.GetFirstChild(parent);
            while (child is not null)
            {
                if (timer.Elapsed >= CatalogTraversalTimeLimit || pending.Count >= remainingNodeBudget)
                {
                    return true;
                }
                pending.Enqueue(child);
                child = walker.GetNextSibling(child);
            }
        }
        catch (ElementNotAvailableException)
        {
            // Premiere rebuilds parts of its UI tree while panels change. A stale
            // branch is skipped, while the rest of the bounded traversal remains valid.
        }
        catch (InvalidOperationException)
        {
            // UI Automation providers may withdraw a branch during enumeration.
        }
        catch (COMException)
        {
            // Treat a provider-level failure as an unavailable branch, not a hung catalog.
        }
        return false;
    }

    private static bool SupportsAction(AutomationElement element, string action) => action switch
    {
        "invoke" => element.TryGetCurrentPattern(InvokePattern.Pattern, out _),
        "toggle" => element.TryGetCurrentPattern(TogglePattern.Pattern, out _),
        "select" => element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out _),
        _ => false
    };

    private static void ExecuteAction(AutomationElement target, string action)
    {
        switch (action)
        {
            case "invoke" when target.TryGetCurrentPattern(InvokePattern.Pattern, out var invoke):
                ((InvokePattern)invoke).Invoke();
                return;
            case "toggle" when target.TryGetCurrentPattern(TogglePattern.Pattern, out var toggle):
                ((TogglePattern)toggle).Toggle();
                return;
            case "select" when target.TryGetCurrentPattern(SelectionItemPattern.Pattern, out var select):
                ((SelectionItemPattern)select).Select();
                return;
            default:
                throw new ControlActionException("The target does not support the requested semantic action.");
        }
    }

    private static (IntPtr Handle, int ProcessId)? GetForegroundPremiereWindow()
    {
        var handle = GetForegroundWindow();
        if (handle == IntPtr.Zero)
        {
            return null;
        }

        _ = GetWindowThreadProcessId(handle, out var processId);
        try
        {
            using var process = Process.GetProcessById((int)processId);
            return IsPremiereProcess(process) ? (handle, process.Id) : null;
        }
        catch (ArgumentException)
        {
            return null;
        }
    }

    private static bool IsPremiereProcess(Process process) => PremiereProcessNames.Contains(process.ProcessName);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
