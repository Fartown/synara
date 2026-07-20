// FILE: claudeSessionDiscovery.ts
// Purpose: Lists locally persisted Claude Code sessions for external session discovery.
// Layer: Provider discovery utility (SDK listSessions first, filesystem scan fallback).
// Exports: listClaudeSessions, scanClaudeSessionFiles, parseClaudeSessionFileHead,
//   resolveClaudeProjectsDir, ClaudeSessionSummary.

import { listSessions as listSdkClaudeSessions } from "@anthropic-ai/claude-agent-sdk";
import { closeSync, openSync, readdirSync, readSync, statSync, type Dirent } from "node:fs";
import OS from "node:os";
import nodePath from "node:path";

const DEFAULT_SESSION_LIMIT = 200;
const SESSION_FILE_HEAD_BYTES = 8 * 1024;
const MAX_SCANNED_FILES = 2_000;
const MAX_SCAN_DEPTH = 4;

export interface ClaudeSessionSummary {
  readonly sessionId: string;
  readonly cwd?: string;
  readonly title?: string;
  readonly updatedAt?: string;
  readonly createdAt?: string;
}

export interface ClaudeSessionDiscoveryInput {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly limit?: number;
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function millisToIso(value: unknown): string | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : undefined;
}

/**
 * Resolve the Claude projects directory the same way claudeProcessEnv resolves
 * credential paths: CLAUDE_CONFIG_DIR wins, otherwise `<home>/.claude`.
 */
export function resolveClaudeProjectsDir(input?: {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
}): string {
  const env = input?.env ?? process.env;
  const configDir = trimToUndefined(env.CLAUDE_CONFIG_DIR);
  if (configDir) {
    return nodePath.join(configDir, "projects");
  }
  const homeDir = trimToUndefined(input?.homeDir) ?? trimToUndefined(env.HOME) ?? OS.homedir();
  return nodePath.join(homeDir, ".claude", "projects");
}

function readFileHead(filePath: string, maxBytes: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const buffer = Buffer.alloc(maxBytes);
    const bytesRead = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Best effort close; a leaked descriptor here is not worth failing discovery.
      }
    }
  }
}

/**
 * Parse the head of a Claude session JSONL file. Individual malformed lines
 * (including a truncated tail line) are skipped; the file is skipped only when no
 * session id can be recovered from its lines or its file name.
 */
export function parseClaudeSessionFileHead(
  content: string,
  fallbackSessionId?: string,
): ClaudeSessionSummary | undefined {
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let createdAt: string | undefined;
  let title: string | undefined;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: Record<string, unknown> | undefined;
    try {
      record = readRecord(JSON.parse(trimmed));
    } catch {
      continue;
    }
    if (!record) continue;

    sessionId ??= readNonEmptyString(record.sessionId);
    cwd ??= readNonEmptyString(record.cwd);
    createdAt ??= readNonEmptyString(record.timestamp);

    const type = readNonEmptyString(record.type);
    if (type === "summary") {
      title ??= readNonEmptyString(record.summary);
    } else if (type === "ai-title") {
      title ??= readNonEmptyString(record.title) ?? readNonEmptyString(record.aiTitle);
    }
  }

  const resolvedSessionId = sessionId ?? trimToUndefined(fallbackSessionId);
  if (!resolvedSessionId) {
    return undefined;
  }
  return {
    sessionId: resolvedSessionId,
    ...(cwd ? { cwd } : {}),
    ...(title ? { title } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}

function collectSessionFiles(dir: string, depth: number, out: string[]): void {
  if (depth > MAX_SCAN_DEPTH || out.length >= MAX_SCANNED_FILES) return;
  let entries: Array<Dirent>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_SCANNED_FILES) return;
    const entryPath = nodePath.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSessionFiles(entryPath, depth + 1, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(entryPath);
    }
  }
}

/**
 * Filesystem fallback scanner: walks `<config>/projects/**.jsonl`, keeps the latest
 * files by mtime, and reads only the first few KB of each for metadata.
 */
export function scanClaudeSessionFiles(
  input?: ClaudeSessionDiscoveryInput & { readonly projectsDir?: string },
): ReadonlyArray<ClaudeSessionSummary> {
  const projectsDir = trimToUndefined(input?.projectsDir) ?? resolveClaudeProjectsDir(input);
  const limit = input?.limit ?? DEFAULT_SESSION_LIMIT;

  const files: string[] = [];
  collectSessionFiles(projectsDir, 0, files);

  const withMtime: Array<{ path: string; mtimeMs: number }> = [];
  for (const filePath of files) {
    try {
      withMtime.push({ path: filePath, mtimeMs: statSync(filePath).mtimeMs });
    } catch {
      continue;
    }
  }
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const sessions: ClaudeSessionSummary[] = [];
  const seen = new Set<string>();
  for (const file of withMtime.slice(0, limit)) {
    const head = readFileHead(file.path, SESSION_FILE_HEAD_BYTES);
    if (head === undefined) continue;
    const fallbackSessionId = nodePath.basename(file.path, ".jsonl");
    const parsed = parseClaudeSessionFileHead(head, fallbackSessionId);
    if (!parsed || seen.has(parsed.sessionId)) continue;
    seen.add(parsed.sessionId);
    sessions.push({
      ...parsed,
      updatedAt: new Date(file.mtimeMs).toISOString(),
    });
  }
  return sessions;
}

/**
 * List all locally persisted Claude sessions across projects. Uses the SDK's
 * `listSessions` (all projects in one call when `dir` is omitted) and falls back to
 * a direct filesystem scan if the SDK call fails.
 */
export async function listClaudeSessions(
  input?: ClaudeSessionDiscoveryInput,
): Promise<ReadonlyArray<ClaudeSessionSummary>> {
  try {
    const sessions = await listSdkClaudeSessions({
      limit: input?.limit ?? DEFAULT_SESSION_LIMIT,
      // Match terminal `/resume` parity: hide programmatic/headless sessions
      // (including Synara's own SDK-created sessions).
      includeProgrammatic: false,
    });
    return sessions.map((session) => {
      const title =
        trimToUndefined(session.summary) ??
        trimToUndefined(session.customTitle) ??
        trimToUndefined(session.firstPrompt);
      const cwd = trimToUndefined(session.cwd);
      const updatedAt = millisToIso(session.lastModified);
      const createdAt = millisToIso(session.createdAt);
      return {
        sessionId: session.sessionId,
        ...(cwd ? { cwd } : {}),
        ...(title ? { title } : {}),
        ...(updatedAt ? { updatedAt } : {}),
        ...(createdAt ? { createdAt } : {}),
      };
    });
  } catch {
    return scanClaudeSessionFiles(input);
  }
}
