import { afterEach, describe, expect, it, vi } from "vitest";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildCodexProcessEnv,
  linkOrCopyCodexOverlayEntry,
  prioritizeCodexOverlayEntries,
} from "./codexProcessEnv";

describe("linkOrCopyCodexOverlayEntry", () => {
  it("copies auth.json when symlink creation is unavailable", async () => {
    const symlink = vi.fn(async () => {
      throw new Error("symlinks unavailable");
    });
    const copyFile = vi.fn(async () => undefined);

    await linkOrCopyCodexOverlayEntry(
      {
        entryName: "auth.json",
        sourcePath: "C:\\Users\\test\\.codex\\auth.json",
        targetPath: "C:\\Users\\test\\.synara\\codex-home-overlay\\auth.json",
        type: "file",
      },
      { symlink, copyFile },
    );

    expect(symlink).toHaveBeenCalledWith(
      "C:\\Users\\test\\.codex\\auth.json",
      "C:\\Users\\test\\.synara\\codex-home-overlay\\auth.json",
      "file",
    );
    expect(copyFile).toHaveBeenCalledWith(
      "C:\\Users\\test\\.codex\\auth.json",
      "C:\\Users\\test\\.synara\\codex-home-overlay\\auth.json",
    );
  });

  it("keeps symlink failures visible for other overlay entries", async () => {
    const symlink = vi.fn(async () => {
      throw new Error("symlinks unavailable");
    });

    await expect(
      linkOrCopyCodexOverlayEntry(
        {
          entryName: "sessions",
          sourcePath: "C:\\Users\\test\\.codex\\sessions",
          targetPath: "C:\\Users\\test\\.synara\\codex-home-overlay\\sessions",
          type: "dir",
        },
        { symlink, copyFile: vi.fn(async () => undefined) },
      ),
    ).rejects.toThrow("symlinks unavailable");
  });
});

describe("prioritizeCodexOverlayEntries", () => {
  it("prepares auth.json before entries whose symlinks may fail first", () => {
    expect(prioritizeCodexOverlayEntries(["sessions", "auth.json", "config.toml"])).toEqual([
      "auth.json",
      "sessions",
      "config.toml",
    ]);
  });
});

describe("codex home overlay session healing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createOverlayHealingFixture() {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "synara-codex-overlay-heal-"));
    const sourceHomePath = path.join(tempDir, "codex-home");
    const synaraHomePath = path.join(tempDir, "synara-home");
    const overlayHomePath = path.join(synaraHomePath, "codex-home-overlay");
    mkdirSync(sourceHomePath, { recursive: true });
    return { tempDir, sourceHomePath, synaraHomePath, overlayHomePath };
  }

  // "win32" skips the login-shell environment hydration so the test stays hermetic.
  async function prepareOverlay(sourceHomePath: string, synaraHomePath: string): Promise<void> {
    await buildCodexProcessEnv({
      env: { SYNARA_HOME: synaraHomePath },
      homePath: sourceHomePath,
      platform: "win32",
    });
  }

  function writeRollout(filePath: string, content: string): void {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf8");
  }

  function expectDirectorySymlink(linkPath: string, targetPath: string): void {
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(targetPath);
  }

  it("merges a diverged overlay sessions directory into the source home without overwriting rollouts", async () => {
    const { tempDir, sourceHomePath, synaraHomePath, overlayHomePath } =
      createOverlayHealingFixture();
    try {
      const sourceSharedRolloutPath = path.join(
        sourceHomePath,
        "sessions",
        "2026",
        "07",
        "18",
        "rollout-shared.jsonl",
      );
      writeRollout(sourceSharedRolloutPath, "source-original\n");

      const overlaySessionsPath = path.join(overlayHomePath, "sessions");
      writeRollout(
        path.join(overlaySessionsPath, "2026", "07", "18", "rollout-shared.jsonl"),
        "overlay-duplicate\n",
      );
      writeRollout(
        path.join(overlaySessionsPath, "2026", "07", "18", "rollout-overlay-only.jsonl"),
        "overlay-only\n",
      );
      writeRollout(
        path.join(overlaySessionsPath, "2026", "07", "19", "rollout-other-day.jsonl"),
        "other-day\n",
      );

      await prepareOverlay(sourceHomePath, synaraHomePath);

      expectDirectorySymlink(overlaySessionsPath, path.join(sourceHomePath, "sessions"));
      // The same-name source rollout kept its own content.
      expect(readFileSync(sourceSharedRolloutPath, "utf8")).toBe("source-original\n");
      // Overlay-only rollouts moved into the source home, preserving YYYY/MM/DD.
      expect(
        readFileSync(
          path.join(sourceHomePath, "sessions", "2026", "07", "18", "rollout-overlay-only.jsonl"),
          "utf8",
        ),
      ).toBe("overlay-only\n");
      expect(
        readFileSync(
          path.join(sourceHomePath, "sessions", "2026", "07", "19", "rollout-other-day.jsonl"),
          "utf8",
        ),
      ).toBe("other-day\n");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("heals a diverged overlay sessions directory that the source home never had", async () => {
    const { tempDir, sourceHomePath, synaraHomePath, overlayHomePath } =
      createOverlayHealingFixture();
    try {
      // The source home has no sessions entry, so the overlay loop never visits it.
      const overlayRolloutPath = path.join(
        overlayHomePath,
        "sessions",
        "2026",
        "07",
        "18",
        "rollout-a.jsonl",
      );
      writeRollout(overlayRolloutPath, "rollout-a\n");

      await prepareOverlay(sourceHomePath, synaraHomePath);

      expectDirectorySymlink(
        path.join(overlayHomePath, "sessions"),
        path.join(sourceHomePath, "sessions"),
      );
      expect(
        readFileSync(
          path.join(sourceHomePath, "sessions", "2026", "07", "18", "rollout-a.jsonl"),
          "utf8",
        ),
      ).toBe("rollout-a\n");
      // The merged rollout is readable through the new symlink.
      expect(readFileSync(overlayRolloutPath, "utf8")).toBe("rollout-a\n");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("heals a diverged overlay archived_sessions directory missing from the source home", async () => {
    const { tempDir, sourceHomePath, synaraHomePath, overlayHomePath } =
      createOverlayHealingFixture();
    try {
      const overlayRolloutPath = path.join(
        overlayHomePath,
        "archived_sessions",
        "2026",
        "07",
        "18",
        "rollout-old.jsonl.zst",
      );
      writeRollout(overlayRolloutPath, "archived\n");

      await prepareOverlay(sourceHomePath, synaraHomePath);

      expectDirectorySymlink(
        path.join(overlayHomePath, "archived_sessions"),
        path.join(sourceHomePath, "archived_sessions"),
      );
      expect(
        readFileSync(
          path.join(
            sourceHomePath,
            "archived_sessions",
            "2026",
            "07",
            "18",
            "rollout-old.jsonl.zst",
          ),
          "utf8",
        ),
      ).toBe("archived\n");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps a correct sessions symlink and never heals other real directories", async () => {
    const { tempDir, sourceHomePath, synaraHomePath, overlayHomePath } =
      createOverlayHealingFixture();
    try {
      const sourceSessionsPath = path.join(sourceHomePath, "sessions");
      mkdirSync(sourceSessionsPath, { recursive: true });
      mkdirSync(overlayHomePath, { recursive: true });
      symlinkSync(sourceSessionsPath, path.join(overlayHomePath, "sessions"), "dir");

      // A non-session real directory keeps the historical "leave it alone" behavior.
      mkdirSync(path.join(sourceHomePath, "plugins"), { recursive: true });
      writeRollout(path.join(overlayHomePath, "plugins", "cache.json"), "{}\n");

      await prepareOverlay(sourceHomePath, synaraHomePath);

      expectDirectorySymlink(path.join(overlayHomePath, "sessions"), sourceSessionsPath);
      const overlayPluginsPath = path.join(overlayHomePath, "plugins");
      expect(lstatSync(overlayPluginsPath).isSymbolicLink()).toBe(false);
      expect(lstatSync(overlayPluginsPath).isDirectory()).toBe(true);
      expect(readFileSync(path.join(overlayPluginsPath, "cache.json"), "utf8")).toBe("{}\n");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("leaves both directories untouched when the merge fails", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { tempDir, sourceHomePath, synaraHomePath, overlayHomePath } =
      createOverlayHealingFixture();
    try {
      // A file blocks the path where the overlay has a directory, so the
      // recursive merge fails partway.
      const sourceBlockerPath = path.join(sourceHomePath, "sessions", "2026");
      writeRollout(sourceBlockerPath, "blocking-file\n");
      const overlayRolloutPath = path.join(
        overlayHomePath,
        "sessions",
        "2026",
        "07",
        "18",
        "rollout-a.jsonl",
      );
      writeRollout(overlayRolloutPath, "rollout-a\n");

      await prepareOverlay(sourceHomePath, synaraHomePath);

      const overlaySessionsPath = path.join(overlayHomePath, "sessions");
      expect(lstatSync(overlaySessionsPath).isSymbolicLink()).toBe(false);
      expect(lstatSync(overlaySessionsPath).isDirectory()).toBe(true);
      expect(readFileSync(overlayRolloutPath, "utf8")).toBe("rollout-a\n");
      expect(readFileSync(sourceBlockerPath, "utf8")).toBe("blocking-file\n");
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
