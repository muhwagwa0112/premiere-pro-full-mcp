import { BridgeOptions } from "../bridge/file-bridge.js";
export declare function getExportTools(bridgeOptions: BridgeOptions): {
    export_sequence: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                output_path: {
                    type: string;
                    description: string;
                };
                preset_path: {
                    type: string;
                    description: string;
                };
                work_area_only: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            output_path: string;
            preset_path?: string;
            work_area_only?: boolean;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    export_frame: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                output_path: {
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
            output_path: string;
            time_seconds?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    export_as_fcp_xml: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                output_path: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            output_path: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    export_aaf: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                output_path: {
                    type: string;
                    description: string;
                };
                mix_down_video: {
                    type: string;
                    description: string;
                };
                explode_to_mono: {
                    type: string;
                    description: string;
                };
                sample_rate: {
                    type: string;
                    description: string;
                };
                bits_per_sample: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            output_path: string;
            mix_down_video?: boolean;
            explode_to_mono?: boolean;
            sample_rate?: number;
            bits_per_sample?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    add_to_render_queue: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                output_path: {
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
            output_path: string;
            preset_path?: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_render_queue_status: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    create_subclip: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                item_id: {
                    type: string;
                    description: string;
                };
                name: {
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
            };
            required: string[];
        };
        handler: (args: {
            item_id: string;
            name: string;
            in_seconds: number;
            out_seconds: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    capture_frame: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                time_seconds: {
                    type: string;
                    description: string;
                };
            };
        };
        handler: (args: {
            time_seconds?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    export_omf: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                output_path: {
                    type: string;
                    description: string;
                };
                sample_rate: {
                    type: string;
                    description: string;
                };
                bits_per_sample: {
                    type: string;
                    description: string;
                };
                audio_encapsulated: {
                    type: string;
                    description: string;
                };
                audio_file_format: {
                    type: string;
                    description: string;
                };
                trim_audio_files: {
                    type: string;
                    description: string;
                };
                handle_frames: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            output_path: string;
            sample_rate?: number;
            bits_per_sample?: number;
            audio_encapsulated?: boolean;
            audio_file_format?: number;
            trim_audio_files?: boolean;
            handle_frames?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    encode_project_item: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                item_id: {
                    type: string;
                    description: string;
                };
                output_path: {
                    type: string;
                    description: string;
                };
                preset_path: {
                    type: string;
                    description: string;
                };
                remove_on_completion: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            item_id: string;
            output_path: string;
            preset_path: string;
            remove_on_completion?: boolean;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    encode_file: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                input_path: {
                    type: string;
                    description: string;
                };
                output_path: {
                    type: string;
                    description: string;
                };
                preset_path: {
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
                remove_on_completion: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            input_path: string;
            output_path: string;
            preset_path: string;
            in_seconds?: number;
            out_seconds?: number;
            remove_on_completion?: boolean;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    manage_proxies: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                item_id: {
                    type: string;
                    description: string;
                };
                action: {
                    type: string;
                    enum: string[];
                    description: string;
                };
                proxy_path: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            item_id: string;
            action: string;
            proxy_path?: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
};
//# sourceMappingURL=export.d.ts.map