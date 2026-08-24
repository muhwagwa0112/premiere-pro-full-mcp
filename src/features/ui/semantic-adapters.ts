import { z } from "zod";
import type { ActionDescriptor } from "../../contracts.js";

export const uiAdapterCatalogArgs = z.object({}).strict();

export const uiAdapterInvokeArgs = z.object({
  adapterId: z.string().regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/).max(128),
  adapterVersion: z.number().int().positive().max(1_000),
  hostBuild: z.string().min(1).max(64),
  locale: z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/).max(35),
  uiFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict();

export const uiSemanticActions: ActionDescriptor[] = [
  {
    id: "ui.adapter.catalog",
    domain: "api",
    title: "Catalog compatible UI semantic adapters",
    description: "List fixed, versioned Premiere UI workflows that match the foreground host build, locale, and targeted UI fingerprint.",
    risk: "R0",
    authority: "inspect",
    preferredBackends: ["ui"],
    minimumPremiereVersion: "26.3.2",
    mutatesProject: false,
    undoable: false,
    verification: "targeted semantic adapter fingerprint",
    support: "implemented_unverified",
    argsSchema: uiAdapterCatalogArgs,
  },
  {
    id: "ui.adapter.invoke",
    domain: "api",
    title: "Invoke a versioned UI semantic adapter",
    description: "Run one fixed registry workflow using the exact host build, locale, and UI fingerprint returned by ui.adapter.catalog.",
    risk: "R3",
    authority: "experimental",
    preferredBackends: ["ui"],
    minimumPremiereVersion: "26.3.2",
    mutatesProject: true,
    undoable: false,
    verification: "adapter-specific UI Automation postcondition",
    support: "implemented_unverified",
    argsSchema: uiAdapterInvokeArgs,
  },
];

export const uiSemanticOperationIds = uiSemanticActions.map((action) => action.id) as readonly string[];
