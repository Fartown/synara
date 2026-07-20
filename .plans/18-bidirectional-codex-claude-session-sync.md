# 18 —— Synara 与 Codex / Claude Code 的双向会话同步方案

## 状态

调研完成，方案待决策。等待确认优先实现哪个阶段。

## 目标

让 Synara 能够感知用户机器上所有 Codex 和 Claude Code 会话，无论它们是在哪里启动的；同时让 Synara 启动的会话也能在原生 Codex / Claude Code CLI 中被看到并继续。

具体包括：

1. **Inbound 自动发现**：Synara 自动发现用户在 `codex` 或 `claude` 终端会话中启动的会话。
2. **Inbound 导入**：发现的会话可以导入 Synara 并继续。
3. **Outbound 镜像（Codex）**：Synara 启动的 Codex 会话出现在用户真实的 `~/.codex` 中，使 `codex` CLI 可以识别。
4. **Outbound 兼容（Claude Code）**：Synara 启动的 Claude Code 会话写入 `~/.claude/projects/<项目>/<sessionId>.jsonl`，使 `claude --continue` 可以恢复。

## 现状

### Synara 已经具备导入外部会话的基础设施

- `apps/server/src/orchestration/importThreadRoute.ts`：将外部 provider 原生会话导入为 Synara 线程。
- `apps/server/src/orchestration/importedThreadMessages.ts`：把 Codex / Claude / OpenCode / Droid 的 transcript 映射为 `ThreadHandoffImportedMessage`。
- `apps/server/src/codexAppServerManager.ts:1388` 已实现 `readExternalThread(externalThreadId, cwd?)`，通过 Codex app-server 的 `thread/read` RPC 读取任意 Codex 线程。
- Claude 导入使用 `@anthropic-ai/claude-agent-sdk`：
  - `getClaudeSessionInfo(externalId, { dir: cwd })`
  - `getClaudeSessionMessages(externalId, { dir: cwd })`

因此，**手动导入路径已经打通**。缺少的是自动发现和双向写入。

### Codex 存储结构（已本地验证）

```text
~/.codex/
  state_5.sqlite            # threads 表：id, rollout_path, cwd, title, source, created_at, updated_at 等
  session_index.jsonl       # 每行 {id, thread_name, updated_at}
  sessions/
    YYYY/MM/DD/
      rollout-<时间戳>-<threadId>.jsonl
```

rollout JSONL 中观察到的事件类型包括：

- `session_meta`
- `event_msg`（`agent_message`、`commentary`、`task_complete`、`sub_agent_activity` 等）
- `response_item`（`custom_tool_call_output` 等）
- `turn_context`
- `world_state`
- `inter_agent_communication_metadata`

### Claude Code 存储结构（已本地验证）

```text
~/.claude/
  history.jsonl
  sessions/<pid>.json       # 轻量级运行时会话元数据
  projects/<转义后的 cwd>/
    <session-uuid>.jsonl    # 完整对话日志
```

对话事件包括 `type: user`、`assistant`、`attachment`、`mode`、`permission-mode`、`ai-title`、`queue-operation`、`last-prompt` 等。工具调用和结果嵌套在 `assistant.message.content` 数组内。

### 双向不通的根因

- **Codex**：Synara 在 `apps/server/src/codexProcessEnv.ts` 中为每个 Codex app-server 子进程构造了一个隔离的 overlay home（`~/.synara/runtime/codex-home-overlay`），并将 `CODEX_HOME` 指向该 overlay。这样做是为了隔离配置、避免浏览器插件冲突，但副作用是 Synara 创建的会话全部写在这个 overlay 的 `state_5.sqlite` 和 `sessions/` 里，**用户主目录 `~/.codex` 完全看不到**。
- **Claude**：`ClaudeAdapter.startSession` 向 SDK 的 `query()` 调用传入 `cwd` 以及 `sessionId` 或 `resume`。SDK 应该会把会话持久化到 `~/.claude/projects/<转义 cwd>/<sessionId>.jsonl`。因此**理论上可能已经可行**，只需验证。

## 改造架构

### 阶段 1 —— Inbound 自动发现（优先级最高，风险最低）

新增一个发现层，扫描用户本地 provider 存储，并在 Synara UI 中展示可导入的会话。

#### 1.1 Codex 会话发现

只读扫描 `~/.codex/state_5.sqlite` 和 `~/.codex/session_index.jsonl`。

```ts
// apps/server/src/codexSessionDiscovery.ts
export interface DiscoveredCodexThread {
  externalThreadId: string;
  provider: "codex";
  cwd: string;
  title: string;
  source: string;        // 例如 "vscode"、"subagent"、"cli"
  modelProvider: string;
  lastActivityAt: number;
  rolloutPath: string;
}

export function discoverCodexThreads(options?: {
  codexHome?: string;
}): ReadonlyArray<DiscoveredCodexThread>;
```

实现要点：

- 只读打开 SQLite；若存在 `-wal`/`-shm`，使用 WAL 感知读取或复制后读取。
- 验证 `rollout_path` 文件存在。
- 过滤掉已归档线程（`archived = 1`）。
- 同时扫描 Synara 的 overlay home，这样 outbound 镜像实现前，Synara 也能列出自己的 Codex 会话。

#### 1.2 Claude Code 会话发现

两层策略：

1. **优先**：如果 SDK 暴露 list API，优先使用（需调研 `@anthropic-ai/claude-agent-sdk`）。
2. **兜底**：扫描 `~/.claude/projects/` 下的 `*.jsonl` 文件。

```ts
// apps/server/src/claudeSessionDiscovery.ts
export interface DiscoveredClaudeThread {
  externalId: string;    // 文件名中的 session UUID
  provider: "claudeAgent";
  cwd: string;           // 从目录名反解出的绝对路径
  title?: string;        // 从 ai-title 事件中提取（如有）
  lastActivityAt: number;
}

export function discoverClaudeThreads(options?: {
  claudeHome?: string;
}): ReadonlyArray<DiscoveredClaudeThread>;
```

实现要点：

- 目录名为转义后的绝对路径（例如 `-Users-bytedance-workspace-dev-synara`），需反解为 `cwd`。
- 读取 JSONL 的首行/末行提取 `cwd`、`sessionId`、`ai-title` 和最新时间戳。
- 用 `getClaudeSessionInfo` 验证会话可访问后再展示。

#### 1.3 项目匹配

复用现有工具：

- `@synara/shared/threadWorkspace` 中的 `workspaceRootsEqual`。
- `parseManagedWorktreeWorkspaceRoot` 处理 worktree 场景。
- `apps/server/src/checkpointing/Utils.ts` 中的 `resolveThreadWorkspaceCwd`。

每个发现的会话按 `cwd` 关联到 Synara 项目。若没有匹配项目，放入“其他位置”分组。

#### 1.4 RPC 与 UI

新增服务端方法：

```ts
// packages/contracts/src/ws.ts
export const DiscoverExternalThreadsInput = Schema.Struct({
  projectId: ProjectId,
  providers: Schema.optional(
    Schema.Array(Schema.Literal("codex", "claudeAgent")),
  ),
});

export const DiscoverExternalThreadsResult = Schema.Struct({
  threads: Schema.Array(
    Schema.Struct({
      externalId: Schema.String,
      provider: ProviderKind,
      title: Schema.String,
      cwd: Schema.String,
      lastActivityAt: IsoDateTime,
    }),
  ),
});
```

在 `apps/server/src/wsRpc.ts` 注册 handler，新增 `apps/server/src/orchestration/discoverExternalThreadsRoute.ts`。

Web 端在线程列表 / Sidebar 中新增分组：

- **来自 Codex CLI**
- **来自 Claude Code CLI**

点击条目即创建 Synara 线程并调用现有的 `importThread` 流程。

### 阶段 2 —— Inbound 导入一键化

发现之后，简化导入流程：

- “导入”先创建 Synara 线程，然后调用 `providerService.startSession` 并带上正确的 `resumeCursor`，再通过现有 mapper 回放历史。
- Codex：使用 `adapter.readExternalThread` + `mapCodexSnapshotMessages`。
- Claude：使用 `getClaudeSessionMessages` + `mapClaudeSessionMessages`。
- 保留原 `cwd`，让 provider 在同一工作区恢复。

### 阶段 3 —— Codex 的 Outbound 镜像（最复杂）

Synara 必须把自己的 Codex 会话写回用户真实的 `~/.codex`，`codex` CLI 才能列出/恢复。

三种候选策略：

#### 3A —— 共享 `CODEX_HOME`（最简单，风险最高）

去掉 overlay，让 Codex app-server 直接使用用户真实的 `~/.codex`。

- 优点：零同步代码；原生 CLI 立即看到所有 Synara 会话。
- 缺点：
  - Synara 对 `config.toml` 的修改（skills、浏览器插件抑制等）会污染用户 Codex 配置。
  - Synara 与用户 CLI 并发写 `state_5.sqlite`，可能损坏。
  - Codex CLI 版本升级导致 schema 变化后，Synara 写入的历史可能不兼容。

结论：仅作为高级用户的可选开关。

#### 3B —— 会话镜像服务（推荐默认方案）

运行时保留 overlay 隔离，但新增后台镜像服务，把 Synara 创建的 Codex 会话从 overlay home 复制到用户真实 `~/.codex`。

职责：

```ts
// apps/server/src/codexSessionMirror.ts
export interface CodexSessionMirror {
  /**
   * 把 overlay home 中 Synara 创建的 Codex 线程
   * 同步到用户真实的 ~/.codex。
   */
  sync(): Effect.Effect<void, CodexMirrorError>;
}
```

算法：

1. 只读打开 overlay 的 `state_5.sqlite`。
2. 选出 `source` 标记为 Synara 的线程（创建时写入该标记）。
3. 对每个线程：
   - 将 rollout JSONL 复制到 `~/.codex/sessions/YYYY/MM/DD/` 对应路径。
   - 在 `~/.codex/state_5.sqlite` 的 `threads` 表中 upsert 一行。
4. JSONL 文件使用“写入临时文件再重命名”的原子写入。
5. 元数据使用 SQLite 事务 upsert。
6. Schema 健壮：运行时读取目标库 `.schema`，只写入已知字段，忽略未知字段。

标记 Synara 会话：

- `CodexAppServerManager` 调用 `thread/start` 时，将 `source`/`thread_source` 设置为可识别 Synara 的值（例如 `source = { synara: true }` 或 `thread_source = "synara"`）。
- 这样镜像服务能区分 Synara 拥有的线程与用户原生线程，避免覆盖用户 CLI 会话。

优点：保留隔离，同时兼容原生 CLI。
缺点：仍依赖 Codex 私有 SQLite schema；需在 schema 变化时做防御性降级。

#### 3C —— Codex CLI 插件 / Wrapper

提供一个包装命令，让 CLI 能查询 Synara 的会话存储。

- 目前受限于 Codex CLI 没有公开的“按 thread ID 恢复”命令。
- 放入 backlog，等 Codex 开放 app-server 或 CLI 插件能力后再做。

### 阶段 4 —— Claude Code 的 Outbound 兼容

`ClaudeAdapter` 已经向 SDK 传入了正确参数：

```ts
const queryOptions: ClaudeQueryOptions = {
  ...(input.cwd ? { cwd: input.cwd } : {}),
  ...(existingResumeSessionId ? { resume: existingResumeSessionId } : {}),
  ...(newSessionId ? { sessionId: newSessionId } : {}),
  // ...
};
```

需要完成的工作：

1. 验证生成的 `~/.claude/projects/<转义 cwd>/<sessionId>.jsonl` 能被 `claude --continue` 读取。
2. 确保 `buildClaudeProcessEnv` 不会把 Claude home 重定向到 overlay，导致原生 CLI 看不到会话文件。
3. Claude 发现服务要包含 Synara 自己启动的会话，避免 UI 重复创建。
4. 如果 SDK 持久化格式与原生 Claude Code 有差异，调整 `ClaudeAdapter` 的事件处理以输出兼容记录；或接受原生 CLI 可能只显示有限内容。

## 文件改动清单

### 新增文件

- `apps/server/src/codexSessionDiscovery.ts`
- `apps/server/src/claudeSessionDiscovery.ts`
- `apps/server/src/orchestration/discoverExternalThreadsRoute.ts`
- `apps/server/src/codexSessionMirror.ts`（阶段 3）

### 修改文件

- `packages/contracts/src/ws.ts` —— 新增 `DiscoverExternalThreadsInput/Result`。
- `apps/server/src/wsRpc.ts` —— 注册 discovery handler。
- `apps/server/src/codexAppServerManager.ts` —— 给 Synara 创建的会话打标记，供镜像服务识别。
- `apps/server/src/codexProcessEnv.ts` —— 增加关闭 overlay 的选项（阶段 3A），或把 overlay 路径暴露给镜像服务。
- `apps/server/src/provider/Layers/ClaudeAdapter.ts` —— 验证 `cwd`/`sessionId` 持久化（阶段 4）。
- `apps/web/src/components/Sidebar.tsx`（或相关线程列表组件）—— 展示发现的外部会话。

## 风险与缓解

| 风险 | 严重程度 | 缓解措施 |
|------|----------|----------|
| Codex / Claude 私有存储格式升级 | 高 | 读/写最小字段集；检测 schema 版本；优雅降级；不假设可选字段存在。 |
| 并发写坏 `~/.codex/state_5.sqlite` | 高 | 镜像使用事务和原子文件写入；不在 Codex CLI 活跃运行时写同一线程；必要时加文件锁。 |
| Overlay home 让原生 CLI 看不到会话 | 中 | 实现阶段 3 镜像服务；或提供共享 home 的可选开关。 |
| 发现服务扫描大量历史会话 | 低 | 分页并缓存；按 `updated_at` 倒序；后台刷新。 |
| 隐私/权限：读取用户所有 provider 历史 | 中 | 首次运行时明确授权；支持按项目排除。 |
| Claude SDK 会话文件与原生 CLI 不兼容 | 中 | 阶段 4 验证；若原生恢复失败则退化为仅导入。 |

## 推荐路线图

1. **第 1 周 —— 阶段 1 MVP**
   - 实现 Codex 发现（扫描 `state_5.sqlite` + `session_index.jsonl`）。
   - 实现 Claude 发现（文件系统扫描 + SDK 验证）。
   - 新增 RPC 和 UI 中的“可导入外部会话”分组。

2. **第 2 周 —— 阶段 2 完善**
   - 一键导入：创建 Synara 线程并恢复 provider 会话。
   - 处理 worktree 和非项目 cwd 的情况。

3. **第 3 周 —— 阶段 4 Claude Outbound**
   - 验证 `claude --continue` 能恢复 Synara 启动的会话。
   - 修复 `ClaudeAdapter` 中可能的 `cwd`/`env` 问题。

4. **第 4–5 周 —— 阶段 3 Codex Outbound**
   - 实现 `CodexSessionMirror`，做 schema 健壮 upsert。
   - 给 Synara 创建的 Codex 线程打标记。
   - 为高级用户添加共享 `CODEX_HOME` 可选开关。
   - 补充镜像安全测试。

## 快速验证原型

在全力实现前，两个低成本实验可验证可行性：

1. **Codex Inbound PoC**
   - 从 `~/.codex/state_5.sqlite` 查询一个 thread ID。
   - 调用 `CodexAppServerManager.readExternalThread({ externalThreadId })`。
   - 确认 transcript 能通过 `mapCodexSnapshotMessages` 解析。

2. **Claude Outbound PoC**
   - 从 Synara 启动一个 Claude 会话。
   - 检查 `~/.claude/projects/<转义 cwd>/<sessionId>.jsonl` 是否存在。
   - 在同一目录执行 `claude --continue`，验证会话被识别。

## 决策记录

- **默认保留 Codex overlay**：隔离收益（配置分离、避免插件冲突）大于同步复杂度。
- **只镜像 Synara 拥有的线程**：绝不覆盖用户原生 CLI 会话；用 `source` 标记区分。
- **发现服务优先用文件系统扫描**：不依赖不稳定 list API，对两个 provider 都适用。
