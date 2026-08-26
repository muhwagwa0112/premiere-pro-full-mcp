import type { PremiereProTransport } from '../../bridge/types.js';
import type { MCPTool } from '../../tools/index.js';
import type { CommandResult } from '../bridge/file-bridge.js';
export interface UpstreamToolDef {
    description: string;
    parameters: Record<string, unknown>;
    handler: (args: Record<string, unknown>) => Promise<CommandResult>;
}
export declare function getUpstreamToolModules(transport: PremiereProTransport): Record<string, UpstreamToolDef>;
export declare function getMissingUpstreamTools(transport: PremiereProTransport, existingNames: Set<string>): MCPTool[];
//# sourceMappingURL=catalog.d.ts.map