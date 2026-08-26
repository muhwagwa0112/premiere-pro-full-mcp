import { BridgeOptions } from "../bridge/file-bridge.js";
export declare function getTextTools(bridgeOptions: BridgeOptions): {
    add_text_overlay: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                text: {
                    type: string;
                    description: string;
                };
                track_index: {
                    type: string;
                    description: string;
                };
                start_seconds: {
                    type: string;
                    description: string;
                };
                duration_seconds: {
                    type: string;
                    description: string;
                };
                font_size: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            text: string;
            track_index?: number;
            start_seconds?: number;
            duration_seconds?: number;
            font_size?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    import_mogrt: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                mogrt_path: {
                    type: string;
                    description: string;
                };
                track_index: {
                    type: string;
                    description: string;
                };
                start_seconds: {
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
            mogrt_path: string;
            track_index?: number;
            start_seconds?: number;
            duration_seconds?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    import_mogrt_from_library: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                mogrt_name: {
                    type: string;
                    description: string;
                };
                track_index: {
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
            mogrt_name: string;
            track_index?: number;
            start_seconds?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
};
//# sourceMappingURL=text.d.ts.map