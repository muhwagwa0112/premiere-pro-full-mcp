import { BridgeOptions } from "../bridge/file-bridge.js";
export declare function getHealthTools(bridgeOptions: BridgeOptions): {
    ping: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
};
//# sourceMappingURL=health.d.ts.map