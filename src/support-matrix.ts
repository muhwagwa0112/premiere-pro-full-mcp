import type { ActionDescriptor, Backend, SupportStatus } from "./contracts.js";
import { listActions } from "./catalog.js";

export const SUPPORT_MATRIX_BACKENDS = ["local", "uxp", "cep", "qe", "ui"] as const satisfies readonly Backend[];

export type HandlerVerification = "verified" | "committed_unverified" | "runtime_dependent";

export interface HandlerEvidence {
  backend: Backend;
  actionId: string;
  handler: string;
  source: string;
  sourceFragment: string;
  liveEvidenceStatus: "not_run";
}

export type SupportMatrixMismatch =
  | "preferred_backend_without_handler"
  | "handler_not_declared_preferred"
  | "declared_implemented_without_handler";

export interface BackendSupportEntry {
  backend: Backend;
  declaredPreferred: boolean;
  handlerState: "implemented_unverified" | "not_implemented";
  handler: string | null;
  evidence: { basis: "code_inspection"; source: string; sourceFragment: string; liveEvidenceStatus: "not_run" } | null;
  mismatches: SupportMatrixMismatch[];
}

export interface ActionSupportEntry {
  actionId: string;
  domain: ActionDescriptor["domain"];
  declaredSupport: SupportStatus;
  preferredBackends: Backend[];
  backends: BackendSupportEntry[];
  mismatches: SupportMatrixMismatch[];
}

export interface SupportMatrix {
  schemaVersion: 1;
  evidenceBasis: "code_inspection_only";
  backendOrder: Backend[];
  actions: ActionSupportEntry[];
  summary: {
    actionCount: number;
    backendCellCount: number;
    implementedHandlerCount: number;
    mismatchCount: number;
  };
}

const localHandler = "LocalAdapter.execute";
const uxpHandler = "execute";
const cepHandler = "PPMCP.dispatch";
const uiHandler = "UiNamedPipeAdapter.execute";

function evidence(
  backend: Backend,
  actionId: string,
  handler: string,
  source: string,
  sourceFragment: string,
  _reportedOutcome: HandlerVerification,
): HandlerEvidence {
  return { backend, actionId, handler, source, sourceFragment, liveEvidenceStatus: "not_run" };
}

function uxpSourceFragment(actionId: string): string {
  const genericBucket = /^uxp\.(read|edit|sensitive|filesystem|destructive)$/.exec(actionId)?.[1];
  return genericBucket ? `${genericBucket}: \"${actionId}\"` : `if (operation === \"${actionId}\")`;
}

const handlerEvidence: HandlerEvidence[] = [
  ...["host.inspect", "plugin.catalog", "effects.catalog", "uxp.catalog"].map((actionId) =>
    evidence("local", actionId, localHandler, "src/bridge/local-adapter.ts", `\"${actionId}\"`, "verified")),

  ...[
    "host.inspect", "project.inspect", "sequence.inspect", "project.save", "project.checkpoint", "project.close_disposable", "captions.inspect",
    "media.relink", "media.proxy.attach", "timeline.track.set_mute", "timeline.clip.insert",
    "export.frame", "export.sequence", "uxp.catalog", "uxp.read", "uxp.edit", "uxp.sensitive",
    "uxp.filesystem", "uxp.destructive", "uxp.handle.release", "uxp.page.read",
    "uxp.transaction.execute", "uxp.locked.batch", "uxp.events.subscribe", "uxp.events.poll",
    "uxp.events.unsubscribe",
  ].map((actionId) => evidence(
    "uxp",
    actionId,
    uxpHandler,
    "uxp-plugin/main.cjs",
    uxpSourceFragment(actionId),
    ["host.inspect", "project.inspect", "sequence.inspect", "project.save", "captions.inspect", "export.frame", "export.sequence", "uxp.catalog", "uxp.read"].includes(actionId)
      ? "verified"
      : "committed_unverified",
  )),

  ...[
    "host.inspect", "project.inspect", "sequence.inspect", "project.create", "project.save", "project.save_as", "project.checkpoint",
    "project.open", "media.import", "timeline.sequence.create_from_media", "export.sequence",
    "workspace.set", "cep.surface.catalog", "cep.read", "cep.edit", "cep.filesystem", "cep.destructive",
  ].map((actionId) => evidence(
    "cep",
    actionId,
    cepHandler,
    "cep-plugin/host.jsx",
    actionId.startsWith("cep.") && actionId !== "cep.surface.catalog" ? "/^(cep|qe)\\.(read|edit|filesystem|destructive)$/" : `\"${actionId}\"`,
    ["host.inspect", "project.inspect", "sequence.inspect", "project.create", "project.open", "media.import", "timeline.sequence.create_from_media", "export.sequence", "cep.surface.catalog", "cep.read"].includes(actionId)
      ? "verified"
      : "committed_unverified",
  )),

  ...["qe.catalog", "qe.read", "qe.edit", "qe.destructive"].map((actionId) => evidence(
    "qe",
    actionId,
    cepHandler,
    "cep-plugin/host.jsx",
    actionId === "qe.catalog" ? `\"qe.catalog\"` : "/^(cep|qe)\\.(read|edit|filesystem|destructive)$/",
    actionId === "qe.catalog" || actionId === "qe.read" ? "verified" : "committed_unverified",
  )),

  ...[
    ["host.inspect", "premiere.window.inspect", "verified"],
    ["ui.adapter.catalog", "premiere.adapters.catalog", "verified"],
    ["ui.adapter.invoke", "premiere.adapter.invoke", "committed_unverified"],
  ].map(([actionId, sourceFragment, verification]) => evidence(
    "ui",
    actionId!,
    uiHandler,
    "src/bridge/ui-named-pipe.ts",
    `\"${sourceFragment}\"`,
    verification as HandlerVerification,
  )),
].sort((left, right) => left.actionId.localeCompare(right.actionId) || SUPPORT_MATRIX_BACKENDS.indexOf(left.backend) - SUPPORT_MATRIX_BACKENDS.indexOf(right.backend));

export const SUPPORT_MATRIX_HANDLER_EVIDENCE: readonly HandlerEvidence[] = Object.freeze(handlerEvidence);

function isImplementedDeclaration(status: SupportStatus): boolean {
  return status === "verified" || status === "implemented_unverified";
}

export function generateSupportMatrix(actions: readonly ActionDescriptor[] = listActions()): SupportMatrix {
  const evidenceByCell = new Map(handlerEvidence.map((item) => [`${item.actionId}\0${item.backend}`, item]));
  const actionEntries = [...actions]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((action): ActionSupportEntry => {
      const preferredBackends = [...action.preferredBackends].sort(
        (left, right) => SUPPORT_MATRIX_BACKENDS.indexOf(left) - SUPPORT_MATRIX_BACKENDS.indexOf(right),
      );
      const backends = SUPPORT_MATRIX_BACKENDS.map((backend): BackendSupportEntry => {
        const handler = evidenceByCell.get(`${action.id}\0${backend}`);
        const declaredPreferred = action.preferredBackends.includes(backend);
        const mismatches: SupportMatrixMismatch[] = [];
        if (declaredPreferred && !handler) mismatches.push("preferred_backend_without_handler");
        if (!declaredPreferred && handler) mismatches.push("handler_not_declared_preferred");
        return {
          backend,
          declaredPreferred,
          handlerState: handler ? "implemented_unverified" : "not_implemented",
          handler: handler?.handler ?? null,
          evidence: handler ? {
            basis: "code_inspection",
            source: handler.source,
            sourceFragment: handler.sourceFragment,
            liveEvidenceStatus: handler.liveEvidenceStatus,
          } : null,
          mismatches,
        };
      });
      const mismatches = [...new Set(backends.flatMap((backend) => backend.mismatches))];
      if (isImplementedDeclaration(action.support) && !backends.some((backend) => backend.handlerState === "implemented_unverified")) {
        mismatches.push("declared_implemented_without_handler");
      }
      return {
        actionId: action.id,
        domain: action.domain,
        declaredSupport: action.support,
        preferredBackends,
        backends,
        mismatches,
      };
    });
  return {
    schemaVersion: 1,
    evidenceBasis: "code_inspection_only",
    backendOrder: [...SUPPORT_MATRIX_BACKENDS],
    actions: actionEntries,
    summary: {
      actionCount: actionEntries.length,
      backendCellCount: actionEntries.length * SUPPORT_MATRIX_BACKENDS.length,
      implementedHandlerCount: actionEntries.flatMap((action) => action.backends).filter((backend) => backend.handlerState === "implemented_unverified").length,
      mismatchCount: actionEntries.reduce((total, action) => total + action.mismatches.length, 0),
    },
  };
}

export function serializeSupportMatrix(matrix: SupportMatrix = generateSupportMatrix()): string {
  return `${JSON.stringify(matrix, null, 2)}\n`;
}
