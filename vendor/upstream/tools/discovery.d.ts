import { BridgeOptions } from "../bridge/file-bridge.js";
export declare function getDiscoveryTools(bridgeOptions: BridgeOptions): {
    get_project_info: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    list_project_items: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                bin_path: {
                    type: string;
                    description: string;
                };
            };
        };
        handler: (args: {
            bin_path?: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    list_sequences: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_active_sequence: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    list_sequence_tracks: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                sequence_id: {
                    type: string;
                    description: string;
                };
            };
        };
        handler: (args: {
            sequence_id?: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_clip_properties: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    find_project_item_by_name: {
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
    get_sequence_settings: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                sequence_id: {
                    type: string;
                    description: string;
                };
            };
        };
        handler: (args: {
            sequence_id?: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_selected_clips: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_clip_at_position: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                time_seconds: {
                    type: string;
                    description: string;
                };
                track_index: {
                    type: string;
                    description: string;
                };
                track_type: {
                    type: string;
                    enum: string[];
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            time_seconds: number;
            track_index: number;
            track_type: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
};
//# sourceMappingURL=discovery.d.ts.map