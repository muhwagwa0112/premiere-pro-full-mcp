import { BridgeOptions } from "../bridge/file-bridge.js";
export declare function getKeyframeTools(bridgeOptions: BridgeOptions): {
    get_effect_properties: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                effect_name: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            effect_name: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_effect_property: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                effect_name: {
                    type: string;
                    description: string;
                };
                property_name: {
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
            node_id: string;
            effect_name: string;
            property_name: string;
            value: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_keyframes: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                effect_name: {
                    type: string;
                    description: string;
                };
                property_name: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            effect_name: string;
            property_name: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    add_keyframe: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                effect_name: {
                    type: string;
                    description: string;
                };
                property_name: {
                    type: string;
                    description: string;
                };
                time_seconds: {
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
            node_id: string;
            effect_name: string;
            property_name: string;
            time_seconds: number;
            value: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    remove_keyframe: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                effect_name: {
                    type: string;
                    description: string;
                };
                property_name: {
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
            node_id: string;
            effect_name: string;
            property_name: string;
            time_seconds: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    remove_keyframe_range: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                effect_name: {
                    type: string;
                    description: string;
                };
                property_name: {
                    type: string;
                    description: string;
                };
                start_seconds: {
                    type: string;
                    description: string;
                };
                end_seconds: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            effect_name: string;
            property_name: string;
            start_seconds: number;
            end_seconds: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_keyframe_interpolation: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                effect_name: {
                    type: string;
                    description: string;
                };
                property_name: {
                    type: string;
                    description: string;
                };
                time_seconds: {
                    type: string;
                    description: string;
                };
                interpolation: {
                    type: string;
                    enum: string[];
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            effect_name: string;
            property_name: string;
            time_seconds: number;
            interpolation: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_value_at_time: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                effect_name: {
                    type: string;
                    description: string;
                };
                property_name: {
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
            node_id: string;
            effect_name: string;
            property_name: string;
            time_seconds: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
};
//# sourceMappingURL=keyframes.d.ts.map