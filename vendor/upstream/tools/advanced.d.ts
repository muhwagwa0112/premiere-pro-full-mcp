import { BridgeOptions } from "../bridge/file-bridge.js";
export declare function getAdvancedTools(bridgeOptions: BridgeOptions): {
    ripple_delete: {
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
    roll_edit: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                offset_seconds: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            offset_seconds: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    slide_edit: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                offset_seconds: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            offset_seconds: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    slip_edit: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                offset_seconds: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            offset_seconds: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    move_clip_to_track: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                target_track_index: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            target_track_index: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    remove_all_effects: {
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
    set_clip_speed_qe: {
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
    reverse_clip: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
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
            reverse?: boolean;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_frame_blend: {
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
    set_time_interpolation: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                interpolation_type: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            interpolation_type: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    rename_clip: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
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
            node_id: string;
            new_name: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_clip_speed: {
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
    set_clip_selection: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                selected: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            selected: boolean;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    link_selection: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    unlink_selection: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    overwrite_clip: {
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
                track_index: {
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
            start_seconds?: number;
            track_index?: number;
            audio_track_index?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    create_sequence_from_clips: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                name: {
                    type: string;
                    description: string;
                };
                item_ids: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            name: string;
            item_ids: string[];
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    close_sequence: {
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
    export_as_project: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                sequence_id: {
                    type: string;
                    description: string;
                };
                output_path: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            sequence_id?: string;
            output_path: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_zero_point: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                sequence_id: {
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
            sequence_id?: string;
            start_seconds: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    scene_edit_detection: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    delete_preview_files: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                media_type: {
                    type: string;
                    description: string;
                };
            };
        };
        handler: (args: {
            media_type?: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    add_tracks: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                video_tracks: {
                    type: string;
                    description: string;
                };
                audio_tracks: {
                    type: string;
                    description: string;
                };
                audio_mono_tracks: {
                    type: string;
                    description: string;
                };
                audio_51_tracks: {
                    type: string;
                    description: string;
                };
            };
        };
        handler: (args: {
            video_tracks?: number;
            audio_tracks?: number;
            audio_mono_tracks?: number;
            audio_51_tracks?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_color_value: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                component_name: {
                    type: string;
                    description: string;
                };
                property_name: {
                    type: string;
                    description: string;
                };
                alpha: {
                    type: string;
                    description: string;
                };
                red: {
                    type: string;
                    description: string;
                };
                green: {
                    type: string;
                    description: string;
                };
                blue: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            component_name: string;
            property_name: string;
            alpha: number;
            red: number;
            green: number;
            blue: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_clip_adjustment_layer: {
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
    get_linked_items: {
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
    get_mogrt_component: {
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
};
//# sourceMappingURL=advanced.d.ts.map