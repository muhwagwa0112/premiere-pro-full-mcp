import { BridgeOptions } from "../bridge/file-bridge.js";
export declare function getProjectTools(bridgeOptions: BridgeOptions): {
    save_project: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    save_project_as: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                path: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            path: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    open_project: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                path: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            path: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_active_sequence: {
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
    undo: {
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
    consolidate_duplicates: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    create_project: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                path: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            path: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    close_project: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                save_first: {
                    type: string;
                    description: string;
                };
            };
        };
        handler: (args: {
            save_first?: boolean;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    import_ae_comps: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                ae_project_path: {
                    type: string;
                    description: string;
                };
                comp_names: {
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
            ae_project_path: string;
            comp_names?: string[];
            target_bin?: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    delete_bin: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                bin_id: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            bin_id: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    rename_bin: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                bin_id: {
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
            bin_id: string;
            new_name: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    create_smart_bin: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                name: {
                    type: string;
                    description: string;
                };
                query: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            name: string;
            query: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    find_items_by_media_path: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                path_search: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            path_search: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    start_batch_encode: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    add_custom_metadata_field: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                field_name: {
                    type: string;
                    description: string;
                };
                field_label: {
                    type: string;
                    description: string;
                };
                field_type: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            field_name: string;
            field_label: string;
            field_type: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    import_sequences: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                project_path: {
                    type: string;
                    description: string;
                };
                sequence_ids: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            project_path: string;
            sequence_ids?: string[];
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    create_bars_and_tone: {
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
                timebase: {
                    type: string;
                    description: string;
                };
                name: {
                    type: string;
                    description: string;
                };
            };
        };
        handler: (args: {
            width?: number;
            height?: number;
            timebase?: string;
            name?: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    import_fcp_xml: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                path: {
                    type: string;
                    description: string;
                };
                output_directory: {
                    type: string;
                    description: string;
                };
                project_path: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            path: string;
            output_directory?: string;
            project_path?: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_transcode_on_ingest: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                enabled: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            enabled: boolean;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_insertion_bin: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_project_panel_metadata: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_project_panel_metadata: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                metadata_xml: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            metadata_xml: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_graphics_white_luminance: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_graphics_white_luminance: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                luminance: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            luminance: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_scratch_disk_path: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                scratch_disk_type: {
                    type: string;
                    description: string;
                };
                path: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            scratch_disk_type: string;
            path: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
};
//# sourceMappingURL=project.d.ts.map
