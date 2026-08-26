import { BridgeOptions } from "../bridge/file-bridge.js";
export declare function getClipboardTools(bridgeOptions: BridgeOptions): {
    copy_effects_between_clips: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                source_node_id: {
                    type: string;
                    description: string;
                };
                target_node_id: {
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
            source_node_id: string;
            target_node_id: string;
            effect_name?: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    copy_effect_values: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                source_node_id: {
                    type: string;
                    description: string;
                };
                target_node_id: {
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
            source_node_id: string;
            target_node_id: string;
            effect_name: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    replace_clip_media: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                clip_node_id: {
                    type: string;
                    description: string;
                };
                new_item_id: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            clip_node_id: string;
            new_item_id: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    batch_apply_effect: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                effect_name: {
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
            effect_name: string;
            target: string;
            track_type?: string;
            track_index?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    remove_effect_by_name: {
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
    set_blend_mode: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                blend_mode: {
                    type: string;
                    enum: string[];
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            blend_mode: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
};
//# sourceMappingURL=clipboard.d.ts.map