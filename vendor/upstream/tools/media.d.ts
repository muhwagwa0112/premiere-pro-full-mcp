import { BridgeOptions } from "../bridge/file-bridge.js";
export declare function getMediaTools(bridgeOptions: BridgeOptions): {
    import_media: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                file_paths: {
                    type: string;
                    items: {
                        type: string;
                    };
                    description: string;
                };
                target_bin: {
                    type: string;
                    description: string;
                };
                suppress_ui: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            file_paths: string[];
            target_bin?: string;
            suppress_ui?: boolean;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    import_folder: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                folder_path: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            folder_path: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    create_bin: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                name: {
                    type: string;
                    description: string;
                };
                parent_bin: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            name: string;
            parent_bin?: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    move_item_to_bin: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                item_id: {
                    type: string;
                    description: string;
                };
                target_bin: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            item_id: string;
            target_bin: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    relink_media: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                item_id: {
                    type: string;
                    description: string;
                };
                new_path: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            item_id: string;
            new_path: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    refresh_media: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                item_id: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            item_id: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    check_offline_media: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_offline: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                item_id: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            item_id: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    has_proxy: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                item_id: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            item_id: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    detach_proxy: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                item_id: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            item_id: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_override_frame_rate: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                item_id: {
                    type: string;
                    description: string;
                };
                frame_rate: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            item_id: string;
            frame_rate: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_override_pixel_aspect_ratio: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                item_id: {
                    type: string;
                    description: string;
                };
                numerator: {
                    type: string;
                    description: string;
                };
                denominator: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            item_id: string;
            numerator: number;
            denominator: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_scale_to_frame_size: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                item_id: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            item_id: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_item_info: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                item_id: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            item_id: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    select_item: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                item_id: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            item_id: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_start_time: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                item_id: {
                    type: string;
                    description: string;
                };
                start_seconds: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            item_id: string;
            start_seconds: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
};
//# sourceMappingURL=media.d.ts.map