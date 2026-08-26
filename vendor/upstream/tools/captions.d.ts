import { BridgeOptions } from "../bridge/file-bridge.js";
export declare function getCaptionTools(bridgeOptions: BridgeOptions): {
    create_caption_track: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                item_id: {
                    type: string;
                    description: string;
                };
                start_seconds: {
                    type: string;
                    description: string;
                };
                caption_format: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            item_id: string;
            start_seconds?: number;
            caption_format?: string;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
};
//# sourceMappingURL=captions.d.ts.map