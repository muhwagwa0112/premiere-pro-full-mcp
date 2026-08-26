import { BridgeOptions } from "../bridge/file-bridge.js";
export declare function getPlayheadTools(bridgeOptions: BridgeOptions): {
    get_playhead_position: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_playhead_position: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                time_seconds: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            time_seconds: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_work_area: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                in_seconds: {
                    type: string;
                    description: string;
                };
                out_seconds: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            in_seconds: number;
            out_seconds: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_work_area: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_sequence_in_out_points: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                in_seconds: {
                    type: string;
                    description: string;
                };
                out_seconds: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            in_seconds: number;
            out_seconds: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_sequence_in_out_points: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
};
//# sourceMappingURL=playhead.d.ts.map