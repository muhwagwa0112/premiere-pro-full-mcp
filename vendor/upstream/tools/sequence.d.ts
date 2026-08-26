import { BridgeOptions } from "../bridge/file-bridge.js";
export declare function getSequenceTools(bridgeOptions: BridgeOptions): {
    create_sequence: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                name: {
                    type: string;
                    description: string;
                };
                preset_path: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            name: string;
            preset_path?: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    duplicate_sequence: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                sequence_id: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            sequence_id: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    delete_sequence: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                sequence_id: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            sequence_id: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_sequence_settings: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                sequence_id: {
                    type: string;
                    description: string;
                };
                width: {
                    type: string;
                    description: string;
                };
                height: {
                    type: string;
                    description: string;
                };
            };
        };
        handler: (args: {
            sequence_id?: string;
            width?: number;
            height?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    create_subsequence: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                ignore_track_targeting: {
                    type: string;
                    description: string;
                };
            };
        };
        handler: (args: {
            ignore_track_targeting?: boolean;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    auto_reframe_sequence: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                sequence_id: {
                    type: string;
                    description: string;
                };
                target_width: {
                    type: string;
                    description: string;
                };
                target_height: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            sequence_id?: string;
            target_width: number;
            target_height: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    unnest_sequence: {
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
    create_sequence_from_preset: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                name: {
                    type: string;
                    description: string;
                };
                preset_path: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            name: string;
            preset_path: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    attach_custom_property: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                property_id: {
                    type: string;
                    description: string;
                };
                property_value: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            property_id: string;
            property_value: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    is_work_area_enabled: {
        description: string;
        parameters: {
            type: "object";
            properties: {};
        };
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_export_file_extension: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                preset_path: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            preset_path: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
};
//# sourceMappingURL=sequence.d.ts.map