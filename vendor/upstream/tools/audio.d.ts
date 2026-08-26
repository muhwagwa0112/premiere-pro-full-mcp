import { BridgeOptions } from "../bridge/file-bridge.js";
export declare function getAudioTools(bridgeOptions: BridgeOptions): {
    adjust_audio_levels: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                level_db: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            level_db: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    add_audio_keyframes: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
                keyframes: {
                    type: string;
                    items: {
                        type: string;
                        properties: {
                            time_seconds: {
                                type: string;
                                description: string;
                            };
                            level_db: {
                                type: string;
                                description: string;
                            };
                        };
                        required: string[];
                    };
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            node_id: string;
            keyframes: Array<{
                time_seconds: number;
                level_db: number;
            }>;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    mute_track: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                track_index: {
                    type: string;
                    description: string;
                };
                muted: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            track_index: number;
            muted: boolean;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
};
//# sourceMappingURL=audio.d.ts.map