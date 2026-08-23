using System.IO;
using System.Text.Json;

namespace PremiereMcp.WindowsUiAgent;

internal static class UiaWorkerEntry
{
    internal static int Run(Stream input, Stream output)
    {
        UiaWorkerResponse response;
        try
        {
            var json = Program.ReadBoundedUtf8(input);
            var request = JsonSerializer.Deserialize<UiaWorkerRequest>(json, UiaWorkerJson.Options)
                          ?? throw new InvalidDataException("UI worker request is required.");
            if (request.ProtocolVersion != 1) throw new InvalidDataException("UI worker protocolVersion must be 1.");
            var automation = new PremiereAutomation();
            var result = request.Operation switch
            {
                "premiere.window.inspect" => automation.InspectWindow(),
                "premiere.controls.catalog" => automation.CatalogControls(
                    request.Args.Deserialize<ControlCatalogArgs>(UiaWorkerJson.Options)
                    ?? throw new InvalidDataException("Catalog arguments are required.")),
                "ui.control.invoke" => automation.InvokeControl(
                    request.Args.Deserialize<ControlInvokeArgs>(UiaWorkerJson.Options)
                    ?? throw new InvalidDataException("Invoke arguments are required.")),
                _ => throw new InvalidDataException("UI worker operation is not allowlisted.")
            };
            response = UiaWorkerResponse.Success(result);
        }
        catch (RequestValidationException ex) { response = UiaWorkerResponse.Failure("invalid_args", ex.Message); }
        catch (PremiereNotForegroundException ex) { response = UiaWorkerResponse.Failure("premiere_not_foreground", ex.Message); }
        catch (ControlNotFoundException ex) { response = UiaWorkerResponse.Failure("control_not_found", ex.Message); }
        catch (ControlActionException ex) { response = UiaWorkerResponse.Failure("control_action_failed", ex.Message); }
        catch (Exception ex) when (ex is InvalidDataException or JsonException)
        {
            response = UiaWorkerResponse.Failure("worker_invalid_request", "UI worker request was invalid.");
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.Runtime.InteropServices.COMException)
        {
            response = UiaWorkerResponse.Failure("automation_error", "Windows UI Automation could not complete the operation.");
        }

        var payload = JsonSerializer.SerializeToUtf8Bytes(response, UiaWorkerJson.Options);
        if (payload.Length > Program.MaxMessageBytes) return 9;
        output.Write(payload);
        output.Flush();
        return response.Ok ? 0 : 10;
    }
}
