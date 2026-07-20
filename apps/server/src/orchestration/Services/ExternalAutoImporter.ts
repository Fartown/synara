import { Effect, Scope, ServiceMap } from "effect";

export interface ExternalAutoImporterShape {
  /** Launch the periodic auto-import sweep; scoped to the server's lifetime. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ExternalAutoImporter extends ServiceMap.Service<
  ExternalAutoImporter,
  ExternalAutoImporterShape
>()("synara/orchestration/Services/ExternalAutoImporter/ExternalAutoImporter") {}
