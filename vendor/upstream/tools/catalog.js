import { z } from 'zod';
import { getAdvancedTools } from './advanced.js';
import { getAudioTools } from './audio.js';
import { getCaptionTools } from './captions.js';
import { getClipboardTools } from './clipboard.js';
import { getDiscoveryTools } from './discovery.js';
import { getEffectsTools } from './effects.js';
import { getExportTools } from './export.js';
import { getHealthTools } from './health.js';
import { getInspectionTools } from './inspection.js';
import { getKeyframeTools } from './keyframes.js';
import { getMarkerTools } from './markers.js';
import { getMediaTools } from './media.js';
import { getMetadataTools } from './metadata.js';
import { getPlaybackTools } from './playback.js';
import { getPlayheadTools } from './playhead.js';
import { getProjectManagerTools } from './project-manager.js';
import { getProjectTools } from './project.js';
import { getScriptingTools } from './scripting.js';
import { getSelectionTools } from './selection.js';
import { getSequenceTools } from './sequence.js';
import { getSourceMonitorTools } from './source-monitor.js';
import { getTextTools } from './text.js';
import { getTimelineTools } from './timeline.js';
import { getTrackTargetingTools } from './track-targeting.js';
import { getTrackTools } from './tracks.js';
import { getTransitionsTools } from './transitions.js';
import { getUtilityTools } from './utility.js';
import { getWorkspaceTools } from './workspace.js';
function jsonSchemaToZod(schema) {
    const type = schema.type;
    const enumValues = schema.enum;
    if (enumValues?.length) {
        return z.enum(enumValues);
    }
    switch (type) {
        case 'string':
            return z.string();
        case 'number':
        case 'integer':
            return z.number();
        case 'boolean':
            return z.boolean();
        case 'array':
            return z.array(z.any());
        case 'object':
            return z.record(z.any());
        default:
            return z.any();
    }
}
function parametersToZodSchema(parameters) {
    const properties = (parameters.properties ?? {});
    const required = new Set((parameters.required ?? []));
    const shape = {};
    for (const [key, property] of Object.entries(properties)) {
        let valueSchema = jsonSchemaToZod(property);
        if (typeof property.description === 'string') {
            valueSchema = valueSchema.describe(property.description);
        }
        shape[key] = required.has(key) ? valueSchema : valueSchema.optional();
    }
    return z.object(shape);
}
export function getUpstreamToolModules(transport) {
    const bridgeOptions = { transport };
    return {
        ...getDiscoveryTools(bridgeOptions),
        ...getProjectTools(bridgeOptions),
        ...getMediaTools(bridgeOptions),
        ...getSequenceTools(bridgeOptions),
        ...getTimelineTools(bridgeOptions),
        ...getEffectsTools(bridgeOptions),
        ...getTransitionsTools(bridgeOptions),
        ...getAudioTools(bridgeOptions),
        ...getTextTools(bridgeOptions),
        ...getMarkerTools(bridgeOptions),
        ...getTrackTools(bridgeOptions),
        ...getPlayheadTools(bridgeOptions),
        ...getMetadataTools(bridgeOptions),
        ...getExportTools(bridgeOptions),
        ...getAdvancedTools(bridgeOptions),
        ...getKeyframeTools(bridgeOptions),
        ...getScriptingTools(bridgeOptions),
        ...getInspectionTools(bridgeOptions),
        ...getSelectionTools(bridgeOptions),
        ...getClipboardTools(bridgeOptions),
        ...getSourceMonitorTools(bridgeOptions),
        ...getTrackTargetingTools(bridgeOptions),
        ...getUtilityTools(bridgeOptions),
        ...getHealthTools(bridgeOptions),
        ...getWorkspaceTools(bridgeOptions),
        ...getCaptionTools(bridgeOptions),
        ...getPlaybackTools(bridgeOptions),
        ...getProjectManagerTools(bridgeOptions)
    };
}
export function getMissingUpstreamTools(transport, existingNames) {
    return Object.entries(getUpstreamToolModules(transport))
        .filter(([name]) => !existingNames.has(name))
        .map(([name, tool]) => ({
        name,
        description: tool.description,
        inputSchema: parametersToZodSchema(tool.parameters)
    }));
}
//# sourceMappingURL=catalog.js.map