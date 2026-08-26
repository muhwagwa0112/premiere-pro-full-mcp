import { BridgeOptions } from "../bridge/file-bridge.js";
export declare function getUtilityTools(bridgeOptions: BridgeOptions): {
    delete_project_item: {
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
    delete_multiple_project_items: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                item_ids: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            item_ids: string[];
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    rename_project_item: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                item_id: {
                    type: string;
                    description: string;
                };
                new_name: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            item_id: string;
            new_name: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    add_adjustment_layer: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                track_index: {
                    type: string;
                    description: string;
                };
            };
        };
        handler: (args: {
            track_index?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    freeze_frame: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                time_seconds: {
                    type: string;
                    description: string;
                };
                output_path: {
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
            time_seconds?: number;
            output_path: string;
            duration_seconds?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_sequence_frame_rate: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                frame_rate: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            frame_rate: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_sequence_resolution: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                width: {
                    type: string;
                    description: string;
                };
                height: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            width: number;
            height: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_sequence_audio_settings: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                sample_rate: {
                    type: string;
                    description: string;
                };
                channel_type: {
                    type: string;
                    description: string;
                };
            };
        };
        handler: (args: {
            sample_rate?: number;
            channel_type?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_sequence_pixel_aspect_ratio: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                ratio: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            ratio: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_sequence_field_type: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                field_type: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            field_type: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_all_project_paths: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_unused_media: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_duplicate_media: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    lift_selection: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    extract_selection: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_clip_links: {
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
    get_sequence_markers_by_type: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                marker_type: {
                    type: string;
                    enum: string[];
                    description: string;
                };
                sequence_id: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            marker_type: string;
            sequence_id?: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_clip_markers: {
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
    add_marker_to_project_item: {
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
                name: {
                    type: string;
                    description: string;
                };
                comments: {
                    type: string;
                    description: string;
                };
                duration_seconds: {
                    type: string;
                    description: string;
                };
                type: {
                    type: string;
                    enum: string[];
                    description: string;
                };
                color_index: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            item_id: string;
            time_seconds: number;
            name?: string;
            comments?: string;
            duration_seconds?: number;
            type?: string;
            color_index?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_sequence_display_format: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                video_display_format: {
                    type: string;
                    description: string;
                };
                audio_display_format: {
                    type: string;
                    description: string;
                };
            };
        };
        handler: (args: {
            video_display_format?: number;
            audio_display_format?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_clip_at_playhead: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                track_type: {
                    type: string;
                    enum: string[];
                    description: string;
                };
            };
        };
        handler: (args: {
            track_type?: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_next_edit_point: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                direction: {
                    type: string;
                    enum: string[];
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
            direction?: string;
            track_type?: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    move_playhead_to_edit: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                direction: {
                    type: string;
                    enum: string[];
                    description: string;
                };
            };
        };
        handler: (args: {
            direction?: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_project_scratch_disk: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                captured_video: {
                    type: string;
                    description: string;
                };
                captured_audio: {
                    type: string;
                    description: string;
                };
                video_previews: {
                    type: string;
                    description: string;
                };
                audio_previews: {
                    type: string;
                    description: string;
                };
            };
        };
        handler: (args: {
            captured_video?: string;
            captured_audio?: string;
            video_previews?: string;
            audio_previews?: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_project_scratch_disks: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    nest_clips: {
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
    get_sequence_count: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_total_clip_count: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    match_frame: {
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
        };
        handler: (args: {
            track_type?: string;
            track_index?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
};
//# sourceMappingURL=utility.d.ts.map