import { BridgeOptions } from "../bridge/file-bridge.js";
export declare function getEffectsTools(bridgeOptions: BridgeOptions): {
    apply_effect: {
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
    apply_audio_effect: {
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
    remove_effect: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                effect_index: {
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
            effect_index?: number;
            effect_name?: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    list_available_effects: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    list_available_audio_effects: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    color_correct: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                exposure: {
                    type: string;
                    description: string;
                };
                contrast: {
                    type: string;
                    description: string;
                };
                highlights: {
                    type: string;
                    description: string;
                };
                shadows: {
                    type: string;
                    description: string;
                };
                whites: {
                    type: string;
                    description: string;
                };
                blacks: {
                    type: string;
                    description: string;
                };
                temperature: {
                    type: string;
                    description: string;
                };
                tint: {
                    type: string;
                    description: string;
                };
                saturation: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            exposure?: number;
            contrast?: number;
            highlights?: number;
            shadows?: number;
            whites?: number;
            blacks?: number;
            temperature?: number;
            tint?: number;
            saturation?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    apply_lut: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                lut_path: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            lut_path: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    stabilize_clip: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                smoothness: {
                    type: string;
                    description: string;
                };
                method: {
                    type: string;
                    enum: string[];
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            smoothness?: number;
            method?: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
};
//# sourceMappingURL=effects.d.ts.map