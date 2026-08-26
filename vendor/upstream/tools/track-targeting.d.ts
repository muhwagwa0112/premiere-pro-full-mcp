import { BridgeOptions } from "../bridge/file-bridge.js";
export declare function getTrackTargetingTools(bridgeOptions: BridgeOptions): {
    set_target_track: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                track_type: {
                    type: string;
                    enum: string[];
                    description: string;
                };
                track_index: {
                    type: string;
                    description: string;
                };
                targeted: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            track_type: string;
            track_index: number;
            targeted: boolean;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_target_tracks: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_all_tracks_targeted: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                targeted: {
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
            targeted: boolean;
            track_type?: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    rename_track: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                track_type: {
                    type: string;
                    enum: string[];
                    description: string;
                };
                track_index: {
                    type: string;
                    description: string;
                };
                name: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            track_type: string;
            track_index: number;
            name: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_track_info: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                track_type: {
                    type: string;
                    enum: string[];
                    description: string;
                };
                track_index: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            track_type: string;
            track_index: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    razor_all_tracks: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                time_seconds: {
                    type: string;
                    description: string;
                };
                track_type: {
                    type: string;
                    enum: string[];
                    description: string;
                };
            };
        };
        handler: (args: {
            time_seconds?: number;
            track_type?: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_clip_start_time: {
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
    clear_item_in_out: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                item_id: {
                    type: string;
                    description: string;
                };
                clear_in: {
                    type: string;
                    description: string;
                };
                clear_out: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            item_id: string;
            clear_in?: boolean;
            clear_out?: boolean;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_item_in_out: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                item_id: {
                    type: string;
                    description: string;
                };
                in_seconds: {
                    type: string;
                    description: string;
                };
                out_seconds: {
                    type: string;
                    description: string;
                };
                media_type: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            item_id: string;
            in_seconds?: number;
            out_seconds?: number;
            media_type?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    import_image_sequence: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                first_file_path: {
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
            first_file_path: string;
            target_bin?: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_clip_position: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                x: {
                    type: string;
                    description: string;
                };
                y: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            x: number;
            y: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_clip_scale: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                scale: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            scale: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_clip_rotation: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                degrees: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            degrees: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_clip_anchor_point: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                x: {
                    type: string;
                    description: string;
                };
                y: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            x: number;
            y: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_clip_opacity: {
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
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            opacity: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_clip_volume: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                volume_db: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            volume_db: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_clip_pan: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                pan: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            pan: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    batch_rename_clips: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                pattern: {
                    type: string;
                    description: string;
                };
                track_type: {
                    type: string;
                    enum: string[];
                    description: string;
                };
                track_index: {
                    type: string;
                    description: string;
                };
                selected_only: {
                    type: string;
                    description: string;
                };
                start_number: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            pattern: string;
            track_type: string;
            track_index: number;
            selected_only?: boolean;
            start_number?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    batch_enable_disable: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                enabled: {
                    type: string;
                    description: string;
                };
                target: {
                    type: string;
                    enum: string[];
                    description: string;
                };
                track_type: {
                    type: string;
                    enum: string[];
                    description: string;
                };
                track_index: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            enabled: boolean;
            target: string;
            track_type?: string;
            track_index?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    remove_selected_clips: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                ripple: {
                    type: string;
                    description: string;
                };
            };
        };
        handler: (args: {
            ripple?: boolean;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    clear_sequence_in_out: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                clear_in: {
                    type: string;
                    description: string;
                };
                clear_out: {
                    type: string;
                    description: string;
                };
            };
        };
        handler: (args: {
            clear_in?: boolean;
            clear_out?: boolean;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_encoder_presets: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                format: {
                    type: string;
                    description: string;
                };
            };
        };
        handler: (args: {
            format?: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_qe_clip_info: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                track_type: {
                    type: string;
                    enum: string[];
                    description: string;
                };
                track_index: {
                    type: string;
                    description: string;
                };
                clip_index: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            track_type: string;
            track_index: number;
            clip_index: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    redo: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    multiple_undo: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                count: {
                    type: string;
                    description: string;
                };
            };
        };
        handler: (args: {
            count?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_poster_frame: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                item_id: {
                    type: string;
                    description: string;
                };
                time_seconds: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            item_id: string;
            time_seconds: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_version_info: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    move_items_to_bin: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                item_ids: {
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
            item_ids: string[];
            target_bin: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_anti_alias_quality: {
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
    set_uniform_scale: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                uniform: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            uniform: boolean;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_scale_width_height: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                scale_width: {
                    type: string;
                    description: string;
                };
                scale_height: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            scale_width: number;
            scale_height: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
};
//# sourceMappingURL=track-targeting.d.ts.map