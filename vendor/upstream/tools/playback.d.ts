import { BridgeOptions } from "../bridge/file-bridge.js";
export declare function getPlaybackTools(bridgeOptions: BridgeOptions): {
    play_timeline: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    stop_playback: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    play_source_monitor: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                speed: {
                    type: string;
                    description: string;
                };
            };
        };
        handler: (args: {
            speed?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_source_monitor_position: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
};
//# sourceMappingURL=playback.d.ts.map