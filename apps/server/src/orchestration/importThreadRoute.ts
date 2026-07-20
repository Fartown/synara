// FILE: importThreadRoute.ts
// Purpose: Imports provider-native sessions and binds them to Synara thread projections.
// Layer: Orchestration command handler
// Exports: makeImportThreadHandler.
//
// The import flow itself lives in externalSessionImport.ts (shared with the batch
// import route); this handler only adapts the WS request shape to the shared runner.

import { type OrchestrationImportThreadInput } from "@synara/contracts";
import { Effect } from "effect";

import {
  makeExternalSessionImportRunner,
  type ExternalSessionImportRunnerOptions,
} from "./externalSessionImport";

type ImportThreadRequest = OrchestrationImportThreadInput;

export type ImportThreadHandlerOptions = ExternalSessionImportRunnerOptions;

export function makeImportThreadHandler(options: ImportThreadHandlerOptions) {
  const runExternalSessionImport = makeExternalSessionImportRunner(options);

  return Effect.fnUntraced(function* (body: ImportThreadRequest) {
    return yield* runExternalSessionImport(body);
  });
}
