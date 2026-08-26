import { BridgeOptions } from "../bridge/file-bridge.js";
export declare function getMarkerTools(bridgeOptions: BridgeOptions): {
    add_marker: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                time_seconds: {
                    type: string;
                    description: string;
                };
                name: {
                    type: string;
                    description: string;
                };
                comments: {
                    type: string;
                    description: string;
                };
                color: {
                    type: string;
                    description: string;
                };
                duration_seconds: {
                    type: string;
                    description: string;
                };
                node_id: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            time_seconds: number;
            name?: string;
            comments?: string;
            color?: number;
            duration_seconds?: number;
            node_id?: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    delete_marker: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                time_seconds: {
                    type: string;
                    description: string;
                };
                node_id: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            time_seconds: number;
            node_id?: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    update_marker: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                time_seconds: {
                    type: string;
                    description: string;
                };
                name: {
                    type: string;
                    description: string;
                };
                comments: {
                    type: string;
                    description: string;
                };
                color: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            time_seconds: number;
            name?: string;
            comments?: string;
            color?: number;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
    list_markers: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                node_id: {
                    type: string;
                    description: string;
                };
            };
        };
        handler: (args: {
            node_id?: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
};
//# sourceMappingURL=markers.d.ts.map