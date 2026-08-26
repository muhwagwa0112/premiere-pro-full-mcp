import { BridgeOptions } from "../bridge/file-bridge.js";
export declare function getMetadataTools(bridgeOptions: BridgeOptions): {
    get_metadata: {
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
    set_metadata: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                item_id: {
                    type: string;
                    description: string;
                };
                field_name: {
                    type: string;
                    description: string;
                };
                value: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            item_id: string;
            field_name: string;
            value: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_color_label: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                item_id: {
                    type: string;
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
            color_index: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_color_label: {
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
    get_footage_interpretation: {
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
    set_footage_interpretation: {
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
                pixel_aspect_ratio: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            item_id: string;
            frame_rate?: number;
            pixel_aspect_ratio?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_xmp_metadata: {
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
    set_xmp_metadata: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                item_id: {
                    type: string;
                    description: string;
                };
                xmp_xml: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            item_id: string;
            xmp_xml: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_color_space: {
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
};
//# sourceMappingURL=metadata.d.ts.map