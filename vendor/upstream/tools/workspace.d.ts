import { BridgeOptions } from "../bridge/file-bridge.js";
export declare function getWorkspaceTools(bridgeOptions: BridgeOptions): {
    get_workspaces: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_workspace: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                name: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            name: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
};
//# sourceMappingURL=workspace.d.ts.map