// FILE: codexAppServerManager.threadArchive.test.ts
// Purpose: Verifies archiveExternalThread routes thread/archive through a discovery
//   context (never a thread-bound session) with the provider thread id.
// Layer: Codex app-server manager tests
// Depends on: codexAppServerManager.

import { describe, expect, it, vi } from "vitest";

import { CodexAppServerManager } from "./codexAppServerManager";

describe("CodexAppServerManager.archiveExternalThread", () => {
  function createManager() {
    const manager = new CodexAppServerManager();
    const context = { session: { cwd: "/work/repo" } };
    const resolveContextForDiscovery = vi.spyOn(
      manager as unknown as {
        resolveContextForDiscovery: (threadId?: string, cwd?: string) => Promise<unknown>;
      },
      "resolveContextForDiscovery",
    );
    resolveContextForDiscovery.mockResolvedValue(context);
    const sendRequest = vi
      .spyOn(
        manager as unknown as {
          sendRequest: (context: unknown, method: string, params: unknown) => Promise<unknown>;
        },
        "sendRequest",
      )
      .mockResolvedValue({});
    return { manager, resolveContextForDiscovery, sendRequest };
  }

  it("sends thread/archive with the external thread id through a discovery context", async () => {
    const { manager, resolveContextForDiscovery, sendRequest } = createManager();

    await manager.archiveExternalThread({ externalThreadId: "thread-ext-1", cwd: "/work/repo" });

    expect(resolveContextForDiscovery).toHaveBeenCalledWith(undefined, "/work/repo");
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(sendRequest).toHaveBeenCalledWith(expect.anything(), "thread/archive", {
      threadId: "thread-ext-1",
    });
  });

  it("does not require a cwd", async () => {
    const { manager, resolveContextForDiscovery, sendRequest } = createManager();

    await manager.archiveExternalThread({ externalThreadId: "thread-ext-2" });

    expect(resolveContextForDiscovery).toHaveBeenCalledWith(undefined, undefined);
    expect(sendRequest).toHaveBeenCalledWith(expect.anything(), "thread/archive", {
      threadId: "thread-ext-2",
    });
  });

  it("propagates app-server request failures", async () => {
    const { manager, sendRequest } = createManager();
    sendRequest.mockRejectedValueOnce(new Error("thread already archived"));

    await expect(
      manager.archiveExternalThread({ externalThreadId: "thread-ext-3" }),
    ).rejects.toThrow("thread already archived");
  });
});
