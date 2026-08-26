import { BridgeOptions } from "../bridge/file-bridge.js";
export declare function getProjectManagerTools(bridgeOptions: BridgeOptions): {
    consolidate_and_transfer: {
        description: string;
        parameters: {
            type: "object";
            properties: {
                destination_path: {
                    type: string;
                    description: string;
                };
                include_all_sequences: {
                    type: string;
                    description: string;
                };
                copy_to_new_location: {
                    type: string;
                    description: string;
                };
                exclude_unused: {
                    type: string;
                    description: string;
                };
                transcode: {
                    type: string;
                    description: string;
                };
                include_preview_files: {
                    type: string;
                    description: string;
                };
                rename_media: {
                    type: string;
                    description: string;
                };
                convert_image_sequences: {
                    type: string;
                    description: string;
                };
                convert_ae_comps: {
                    type: string;
                    description: string;
                };
                convert_synthetic: {
                    type: string;
                    description: string;
                };
            };
            required: string[];
        };
        handler: (args: {
            destination_path: string;
            include_all_sequences?: boolean;
            copy_to_new_location?: boolean;
            exclude_unused?: boolean;
            transcode?: boolean;
            include_preview_files?: boolean;
            rename_media?: boolean;
            convert_image_sequences?: boolean;
            convert_ae_comps?: boolean;
            convert_synthetic?: boolean;
        }) => Promise<import("../bridge/file-bridge.js").CommandResult>;
    };
};
//# sourceMappingURL=project-manager.d.ts.map