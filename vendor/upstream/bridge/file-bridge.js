function normalizeCommandResult(value) {
    if (typeof value === 'string') {
        try {
            return normalizeCommandResult(JSON.parse(value));
        }
        catch {
            return { success: true, data: value };
        }
    }
    if (!value || typeof value !== 'object') {
        return { success: true, data: value };
    }
    const record = value;
    if (record.success === false) {
        return {
            success: false,
            error: typeof record.error === 'string' ? record.error : JSON.stringify(record.error ?? record)
        };
    }
    if (record.success === true && 'data' in record) {
        return { success: true, data: record.data };
    }
    if (record.success === true && 'result' in record) {
        return normalizeCommandResult(record.result);
    }
    return { success: true, data: value };
}
async function executeThroughTransport(script, options) {
    if (!options?.transport) {
        return {
            success: false,
            error: 'No Premiere Pro transport configured for vendored upstream tool'
        };
    }
    try {
        return normalizeCommandResult(await options.transport.executeScript(makeScriptReturnValue(script)));
    }
    catch (error) {
        return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}
function makeScriptReturnValue(script) {
    const iifeStart = '\n(function() {\n  try {';
    const index = script.lastIndexOf(iifeStart);
    if (index === -1) {
        return script;
    }
    return `${script.slice(0, index)}\nreturn ${script.slice(index + 1)}`;
}
export async function sendCommand(script, options) {
    return executeThroughTransport(script, options);
}
export async function sendRawCommand(script, options) {
    return executeThroughTransport(script, options);
}
export function getTempDir(options) {
    return options?.tempDir || process.env.PREMIERE_TEMP_DIR || '';
}
export function cleanupTempDir(_options) {
    // The local PremiereProTransport owns command cleanup.
}
//# sourceMappingURL=file-bridge.js.map