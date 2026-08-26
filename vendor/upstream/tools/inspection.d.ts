import { BridgeOptions } from "../bridge/file-bridge.js";
export declare function getInspectionTools(bridgeOptions: BridgeOptions): {
    get_full_project_overview: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_bin_contents: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                bin_id: {
                    type: string;
                    description: string;
                };
                recursive: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            bin_id: string;
            recursive?: boolean;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_full_sequence_info: {
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
    get_full_clip_info: {
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
    get_project_item_info: {
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
    search_project_items: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                query: {
                    type: string;
                    description: string;
                };
                extension: {
                    type: string;
                    description: string;
                };
                offline_only: {
                    type: string;
                    description: string;
                };
                color_label: {
                    type: string;
                    description: string;
                };
                item_type: {
                    type: string;
                    enum: string[];
                    description: string;
                };
                max_results: {
                    type: string;
                    description: string;
                };
            };
        };
        handler: (args: {
            query?: string;
            extension?: string;
            offline_only?: boolean;
            color_label?: number;
            item_type?: string;
            max_results?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_timeline_gaps: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                sequence_id: {
                    type: string;
                    description: string;
                };
                track_type: {
                    type: string;
                    enum: string[];
                    description: string;
                };
                min_gap_seconds: {
                    type: string;
                    description: string;
                };
            };
        };
        handler: (args: {
            sequence_id?: string;
            track_type?: string;
            min_gap_seconds?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_timeline_summary: {
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
    get_offline_media: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_used_media_report: {
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
};
//# sourceMappingURL=inspection.d.ts.map