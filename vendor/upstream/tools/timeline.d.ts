import { BridgeOptions } from "../bridge/file-bridge.js";
export declare function getTimelineTools(bridgeOptions: BridgeOptions): {
    add_to_timeline: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                item_id: {
                    type: string;
                    description: string;
                };
                track_index: {
                    type: string;
                    description: string;
                };
                start_seconds: {
                    type: string;
                    description: string;
                };
                audio_track_index: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            item_id: string;
            track_index?: number;
            start_seconds?: number;
            audio_track_index?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    remove_from_timeline: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                ripple: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            ripple?: boolean;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    move_clip: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                new_start_seconds: {
                    type: string;
                    description: string;
                };
                new_track_index: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            new_start_seconds: number;
            new_track_index?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    trim_clip: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                new_in_seconds: {
                    type: string;
                    description: string;
                };
                new_out_seconds: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            new_in_seconds?: number;
            new_out_seconds?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    split_clip: {
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
            track_index?: number;
            track_type?: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    duplicate_clip: {
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
    enable_disable_clip: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                enabled: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            enabled: boolean;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_clip_properties: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                opacity: {
                    type: string;
                    description: string;
                };
                speed: {
                    type: string;
                    description: string;
                };
                scale: {
                    type: string;
                    description: string;
                };
                position_x: {
                    type: string;
                    description: string;
                };
                position_y: {
                    type: string;
                    description: string;
                };
                rotation: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            opacity?: number;
            speed?: number;
            scale?: number;
            position_x?: number;
            position_y?: number;
            rotation?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    replace_clip: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                new_item_id: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            new_item_id: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    speed_change: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                speed_percent: {
                    type: string;
                    description: string;
                };
                reverse: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            speed_percent: number;
            reverse?: boolean;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
};
//# sourceMappingURL=timeline.d.ts.map