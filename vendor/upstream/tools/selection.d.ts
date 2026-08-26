import { BridgeOptions } from "../bridge/file-bridge.js";
export declare function getSelectionTools(bridgeOptions: BridgeOptions): {
    select_clips_by_name: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                name: {
                    type: string;
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
                add_to_selection: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            name: string;
            track_type?: string;
            track_index?: number;
            add_to_selection?: boolean;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    select_all_clips: {
        description: string;
        parameters: {
            type: "object";
            properties: {
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
        };
        handler: (args: {
            track_type?: string;
            track_index?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    deselect_all_clips: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    select_clips_in_range: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                start_seconds: {
                    type: string;
                    description: string;
                };
                end_seconds: {
                    type: string;
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
            start_seconds: number;
            end_seconds: number;
            track_type?: string;
            track_index?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    select_clips_by_color: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                color_index: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            color_index: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    invert_selection: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    select_disabled_clips: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
};
//# sourceMappingURL=selection.d.ts.map