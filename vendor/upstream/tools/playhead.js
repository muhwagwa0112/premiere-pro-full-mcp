import { buildToolScript } from "../bridge/script-builder.js";
import { sendCommand } from "../bridge/file-bridge.js";
export function getPlayheadTools(bridgeOptions) {
    return {
        get_playhead_position: {
            description: "Get the current playhead (CTI) position in the active sequence",
            parameters: {},
            handler: async () => {
                const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");
          
          var ticks = seq.getPlayerPosition().ticks;
          return __result({
            seconds: __ticksToSeconds(ticks),
            ticks: ticks
          });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        set_playhead_position: {
            description: "Set the playhead (CTI) position in the active sequence",
            parameters: {
                type: "object",
                properties: {
                    time_seconds: {
                        type: "number",
                        description: "Time position in seconds to move the playhead to",
                    },
                },
                required: ["time_seconds"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");
          
          var ticks = __secondsToTicks(${args.time_seconds}).toString();
          seq.setPlayerPosition(ticks);
          
          return __result({ positionSeconds: ${args.time_seconds} });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        set_work_area: {
            description: "Set the work area (bar) in and out points",
            parameters: {
                type: "object",
                properties: {
                    in_seconds: {
                        type: "number",
                        description: "Work area in-point in seconds",
                    },
                    out_seconds: {
                        type: "number",
                        description: "Work area out-point in seconds",
                    },
                },
                required: ["in_seconds", "out_seconds"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");
          
          seq.setWorkAreaInPoint(__secondsToTicks(${args.in_seconds}).toString());
          seq.setWorkAreaOutPoint(__secondsToTicks(${args.out_seconds}).toString());
          
          return __result({ workAreaIn: ${args.in_seconds}, workAreaOut: ${args.out_seconds} });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        get_work_area: {
            description: "Get the current work area in and out points",
            parameters: {},
            handler: async () => {
                const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");

          var workIn = seq.getWorkAreaInPoint();
          var workOut = seq.getWorkAreaOutPoint();
          return __result({
            inSeconds: __ticksToSeconds(workIn),
            outSeconds: __ticksToSeconds(workOut)
          });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        set_sequence_in_out_points: {
            description: "Set the sequence in and out points (for export range, etc.)",
            parameters: {
                type: "object",
                properties: {
                    in_seconds: {
                        type: "number",
                        description: "In-point in seconds",
                    },
                    out_seconds: {
                        type: "number",
                        description: "Out-point in seconds",
                    },
                },
                required: ["in_seconds", "out_seconds"],
            },
            handler: async (args) => {
                const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");
          
          seq.setInPoint(__secondsToTicks(${args.in_seconds}).toString());
          seq.setOutPoint(__secondsToTicks(${args.out_seconds}).toString());
          
          return __result({ inSeconds: ${args.in_seconds}, outSeconds: ${args.out_seconds} });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
        get_sequence_in_out_points: {
            description: "Get the current sequence in and out points",
            parameters: {},
            handler: async () => {
                const script = buildToolScript(`
          var seq = app.project.activeSequence;
          if (!seq) return __error("No active sequence");
          
          return __result({
            inSeconds: __ticksToSeconds(seq.getInPoint()),
            outSeconds: __ticksToSeconds(seq.getOutPoint())
          });
        `);
                return sendCommand(script, bridgeOptions);
            },
        },
    };
}
//# sourceMappingURL=playhead.js.map
