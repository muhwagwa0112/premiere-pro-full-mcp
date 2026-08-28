import { BridgeOptions } from "../bridge/file-bridge.js";
export declare function getTrackTools(bridgeOptions: BridgeOptions): {
    add_track: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                track_type: {
                    type: string;
                    enum: string[];
                    description: string;
                };
                count: {
                    type: string;
                    description: string;
                };
                sequence_id: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            track_type: string;
            count?: number;
            sequence_id?: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    delete_track: {
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
            required: string[];
        };
        handler: (args: {
            track_type: string;
            track_index: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    lock_track: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                track_index: {
                    type: string;
                    description: string;
                };
                locked: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            track_index: number;
            locked: boolean;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    toggle_track_visibility: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                track_index: {
                    type: string;
                    description: string;
                };
                visible: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            track_index: number;
            visible: boolean;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
};
//# sourceMappingURL=tracks.d.ts.map
