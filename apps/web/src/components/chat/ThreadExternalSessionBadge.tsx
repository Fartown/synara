// FILE: ThreadExternalSessionBadge.tsx
// Purpose: Compact chat-header badge shown when the open thread is bound to an external
//          CLI session (imported Codex/Claude session): provider icon + abbreviated session
//          id + a copy button for the "resume in CLI" command.
// Layer: Chat header feature component — fetches its own data so ChatHeader needs no new props.

import type { ThreadId } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { memo, useEffect, useRef } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { CheckIcon, CopyIcon } from "~/lib/icons";
import { threadExternalSessionQueryOptions } from "../../lib/externalSessions";
import { useStore } from "../../store";
import { shortenExternalSessionId } from "../externalSessionsGrouping";
import { ProviderIcon } from "../ProviderIcon";
import { Badge } from "../ui/badge";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const ThreadExternalSessionBadge = memo(function ThreadExternalSessionBadge({
  threadId,
}: {
  threadId: ThreadId;
}) {
  const orchestrationStatus = useStore(
    (store) => store.threadSessionById?.[threadId]?.orchestrationStatus ?? null,
  );
  const externalSessionQuery = useQuery(threadExternalSessionQueryOptions({ threadId }));
  const externalSession = externalSessionQuery.data ?? null;
  const refetch = externalSessionQuery.refetch;

  // The binding can be created by the thread's first turn — after this badge's first
  // fetch — so refetch once when the provider session transitions to ready.
  const previousStatusRef = useRef(orchestrationStatus);
  useEffect(() => {
    const previousStatus = previousStatusRef.current;
    previousStatusRef.current = orchestrationStatus;
    if (orchestrationStatus === "ready" && previousStatus !== "ready") {
      void refetch();
    }
  }, [orchestrationStatus, refetch]);

  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Failed to copy resume command",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
  });

  if (!externalSession) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant="outline"
            className="hidden !h-6 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-[10px] text-muted-foreground/79 sm:inline-flex"
          />
        }
      >
        <ProviderIcon
          provider={externalSession.provider}
          tone="header"
          className="size-3 shrink-0"
        />
        <span className="tabular-nums">{shortenExternalSessionId(externalSession.externalId)}</span>
        <button
          type="button"
          aria-label="Copy CLI resume command"
          className="inline-flex size-3.5 shrink-0 cursor-pointer items-center justify-center text-muted-foreground/65 transition-colors hover:text-foreground"
          onClick={(event) => {
            event.stopPropagation();
            copyToClipboard(externalSession.resumeCommand);
          }}
        >
          {isCopied ? (
            <CheckIcon className="size-2.5 text-success" />
          ) : (
            <CopyIcon className="size-2.5" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipPopup side="bottom">Resume in CLI: {externalSession.resumeCommand}</TooltipPopup>
    </Tooltip>
  );
});
