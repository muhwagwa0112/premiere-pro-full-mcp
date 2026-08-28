import { BridgeOptions } from "../bridge/file-bridge.js";
export declare function getScriptingTools(bridgeOptions: BridgeOptions): {
    execute_extendscript: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                code: {
                    type: string;
                    description: string;
                };
                timeout_ms: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            code: string;
            timeout_ms?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    evaluate_expression: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                expression: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            expression: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    inspect_dom_object: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                object_path: {
                    type: string;
                    description: string;
                };
                max_depth: {
                    type: string;
                    description: string;
                };
                max_items: {
                    type: string;
                    description: string;
                };
                max_properties: {
                    type: string;
                    description: string;
                };
                max_output_chars: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            object_path: string;
            max_depth?: number;
            max_items?: number;
            max_properties?: number;
            max_output_chars?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    list_clip_effects: {
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
    get_sequence_structure: {
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
    get_premiere_state: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
};
//# sourceMappingURL=scripting.d.ts.map
