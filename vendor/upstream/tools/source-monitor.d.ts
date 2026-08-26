import { BridgeOptions } from "../bridge/file-bridge.js";
export declare function getSourceMonitorTools(bridgeOptions: BridgeOptions): {
    open_in_source: {
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
    close_source_monitor: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    close_all_source_clips: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    set_source_in_out: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                in_seconds: {
                    type: string;
                    description: string;
                };
                out_seconds: {
                    type: string;
                    description: string;
                };
            };
        };
        handler: (args: {
            in_seconds?: number;
            out_seconds?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    insert_from_source: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                video_track_index: {
                    type: string;
                    description: string;
                };
                audio_track_index: {
                    type: string;
                    description: string;
                };
            };
        };
        handler: (args: {
            video_track_index?: number;
            audio_track_index?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    overwrite_from_source: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                video_track_index: {
                    type: string;
                    description: string;
                };
                audio_track_index: {
                    type: string;
                    description: string;
                };
            };
        };
        handler: (args: {
            video_track_index?: number;
            audio_track_index?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    get_source_monitor_info: {
        description: string;
        parameters: {};
        handler: () => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
};
//# sourceMappingURL=source-monitor.d.ts.map