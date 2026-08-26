import { BridgeOptions } from "../bridge/file-bridge.js";
export declare function getTransitionsTools(bridgeOptions: BridgeOptions): {
    add_transition: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                transition_name: {
                    type: string;
                    description: string;
                };
                track_index: {
                    type: string;
                    description: string;
                };
                cut_point_seconds: {
                    type: string;
                    description: string;
                };
                duration_seconds: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            transition_name: string;
            track_index: number;
            cut_point_seconds: number;
            duration_seconds?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    add_transition_to_clip: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                transition_name: {
                    type: string;
                    description: string;
                };
                position: {
                    type: string;
                    enum: string[];
                    description: string;
                };
                duration_seconds: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            transition_name: string;
            position?: string;
            duration_seconds?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    batch_add_transitions: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                transition_name: {
                    type: string;
                    description: string;
                };
                track_index: {
                    type: string;
                    description: string;
                };
                duration_seconds: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            transition_name: string;
            track_index?: number;
            duration_seconds?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    list_available_transitions: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    list_available_audio_transitions: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
};
//# sourceMappingURL=transitions.d.ts.map