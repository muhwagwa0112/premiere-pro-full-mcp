import type { PremiereProTransport } from '../../bridge/types.js';
export interface BridgeOptions {
    tempDir?: string;
    timeoutMs?: number;
    transport?: PremiereProTransport;
}
export interface CommandResult {
    success: boolean;
    data?: unknown;
    error?: string;
}
export declare function sendCommand(script: string, options?: BridgeOptions): Promise<CommandResult>;
export declare function sendRawCommand(script: string, options?: BridgeOptions): Promise<CommandResult>;
export declare function getTempDir(options?: BridgeOptions): string;
export declare function cleanupTempDir(_options?: BridgeOptions): void;
//# sourceMappingURL=file-bridge.d.ts.map