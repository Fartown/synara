# 方案 —— 外部会话发现与 CLI 互通（Codex + Claude Code）

> 状态：**已提案**（调研完成，尚未实施）。调研日期 2026-07-18。
> 一句话目标：Synara 要能列出本地**所有** Codex 和 Claude Code 会话——不只是它自己
> 创建的——并且 Synara 创建的每个会话都必须能被官方 `codex` / `claude` CLI 恢复续聊。
> 每个实施阶段收尾前的门禁：按 AGENTS.md 一次性跑 `bun fmt`、`bun lint`、
> `bun typecheck`；改动范围用 `bun run test` 做聚焦验证（永远不要跑 `bun test`）。
> 未被明确要求前不要提交代码。

## 1. 目标与非目标

三个用户诉求：

1. **发现并导入外部 Codex 会话。** 像 Codex Desktop / CodexMonitor 一样，自动列出
   磁盘上的全部会话（`~/.codex/sessions`），包括用原生 `codex` CLI 创建的，并允许
   用户在 Synara 中接管。
2. **发现并导入外部 Claude Code 会话。** 同理覆盖
   `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`。
3. **Synara 创建的会话必须能被 CLI 识别。** 在 Synara 里发起的会话必须出现在
   `codex resume` 列表中、能通过 `claude --resume <id>` 恢复。

非目标（显式划界，防止范围蔓延）：

- Synara 不直接写/改 provider 的会话文件。所有外部文件对我们只读；恢复续聊一律
  通过官方运行时完成。
- 不重新实现 provider 的会话格式。只走官方 API（`codex app-server` JSON-RPC、
  Claude Agent SDK），绝不手解析 JSONL——除非作为降級兜底，且必须带版本容错。
- 本方案不涉及其他 provider（grok/droid/cursor/……）的迁移。

## 2. 现状（调研结论，附证据）

### 2.1 Codex 链路 —— 存储已共享，缺的是发现

- **通过 CODEX_HOME overlay 共享存储。** Synara 启动 `codex app-server` 时设置
  `CODEX_HOME=<overlay>`，overlay 把真实 codex home 的**所有**条目（含 `sessions/`
  和 `state_*.sqlite`）symlink 进来，只重写 `config.toml`
  （`apps/server/src/codexProcessEnv.ts:238-307`、`apps/server/src/codexHomePaths.ts`）。
  基础 home = `providerOptions.codex.homePath || $CODEX_HOME || ~/.codex`。
  → Synara 创建的会话**已经**落在真实的 `~/.codex/sessions/` 里。
- **CLI 可见性已经成立。** app-server 会话被标记为 `source=vscode`（在上游
  `INTERACTIVE_SESSION_SOURCES` 白名单内），`clientInfo.name`（`synara_desktop`）
  记录为 `originator` → 会出现在 `codex resume` 选择器和 Codex Desktop 历史里
  （[app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)、
  [openai/codex#23442](https://github.com/openai/codex/issues/23442)）。
- **一个会悄悄破坏共享的边缘 case：** overlay 首次建立时，如果源 home 里还没有某个
  条目（比如 `sessions/`），codex 之后会在 overlay 里创建一个**真实目录**，此后永远
  不会被替换成 symlink（`codexProcessEnv.ts:217-233`）。这些会话在两个方向上都与
  真实 home 分裂。→ 由阶段 0 自愈。
- **发现能力是真空白。** Synara 从不调用 `thread/list`；侧边栏线程列表只读自己的
  SQLite projection（`apps/server/src/wsRpc.ts:601-610` → `ProjectionSnapshotQuery`）。
  CLI 创建的会话完全不可见。
- **导入已存在，但只能手贴 UUID 且有损。**
  `orchestration.importThread {threadId, externalId}`
  （`packages/contracts/src/orchestration.ts:2135-2144`，处理器
  `apps/server/src/orchestration/importThreadRoute.ts`）会先通过
  `readExternalThread`（在一次性 discovery app-server 上调 codex `thread/read`）校验
  cwd，再以 resumeCursor `{threadId: externalId}` 启动会话，最后经
  `thread.messages.import` 导入历史。但是：
  - 只有 `userMessage`/`agentMessage` 文本被保留
    （`apps/server/src/orchestration/importedThreadMessages.ts:34-73`）——工具调用、
    推理、计划、图片、turn 结构全部丢弃（`turnId` 为 null → 没有 checkpoints/diffs）。
  - 没有去重：同一个 codex 线程导入两次会产生两个 Synara 线程绑定同一个 codex
    线程（双重拥有）。
  - 标题是通用的 `Imported Codex thread <suffix8>`。
- **事件溯源约束：** 线程行必须通过 orchestration commands/events 创建。手写
  `projection_threads` 行会被 `orchestration.repairState` 冲掉（它只从事件日志重建，
  `OrchestrationEngine.ts:445-466`）。现有 import 路径是合规的，扩展时必须继续走
  这条路径。
- **当前的 ID 映射：** Synara threadId ↔ codex threadId 只存在
  `provider_session_runtime.resume_cursor_json`
  （`apps/server/src/provider/Layers/ProviderService.ts:435-496`）。codex id 从不在
  UI 上显示。`projection_thread_sessions.provider_thread_id` 列存在但已废弃
  （upsert 不再写它，`persistence/Layers/ProjectionThreadSessions.ts:22-48`）。

### 2.2 Claude 链路 —— provider 完整、会话已共享，缺的同样是发现

- Claude 已经是**一等 provider**，基于 `@anthropic-ai/claude-agent-sdk`
  （`apps/server/src/provider/Layers/ClaudeAdapter.ts`，约 4.5k 行），不是 ACP。
- 会话已经持久化到**真实的** `~/.claude/projects/…`：`main.ts:187` 始终传
  `OS.homedir()`，`buildClaudeProcessEnv` 不覆盖 `CLAUDE_CONFIG_DIR`，
  `settingSources: ["user","project","local"]`。→ `claude --resume <sessionId>`
  可用（ID 查找限定在同一项目 cwd 下，见风险节）。
- 导入同样已存在、同样只能手贴 session ID：`importThreadRoute.ts:105-133` 用 SDK
  `getSessionInfo` 校验、`getSessionMessages` 读历史，并要求会话位于线程 workspace
  cwd 之下（`ensureClaudeThreadImportable`）。
- **缺发现/浏览：** SDK 自带的 `listSessions()` 完全没被使用；今天唯一读
  `~/.claude/projects` 的代码是用量统计扫描器
  （`apps/server/src/providerUsageSnapshot.ts:416-446`）。

### 2.3 官方协议能力（已核实的外部事实）

Codex app-server（[README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)、
[ThreadListParams schema](https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/schema/json/v2/ThreadListParams.json)）：

- `thread/list` 枚举磁盘上**全部** rollout（不区分谁创建的）；过滤项：`cursor`、
  `limit`、`sortKey`、`modelProviders`、`sourceKinds`（默认只含交互式：`cli`、
  `vscode` 等）、`archived`、`cwd`、`searchTerm`、`useStateDbOnly`。
- `thread/read`（带 `includeTurns`）、`thread/resume`（按 id / 按历史 / 按 rollout
  路径）、`thread/fork`、`thread/archive`、`thread/name/set` 均已存在。
- rollout 格式：`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`；首行
  `session_meta`（id、cwd、originator、source、timestamp……）；冷文件可能被后台
  worker **zstd 压缩**成 `.jsonl.zst`——任何碰文件的代码必须两种都容忍。
- 性能注意：`thread/list` 会急切读取 rollout 文件
  （[openai/codex#22411](https://github.com/openai/codex/issues/22411)）→ 必须
  分页 + 缓存，绝不放在 UI 热路径上。
- 参考实现：CodexMonitor 的发现完全靠 `thread/list`，自己不解析文件
  （[codex_core.rs](https://raw.githubusercontent.com/Dimillian/CodexMonitor/main/src-tauri/src/shared/codex_core.rs)）
  ——验证了同样的架构对 Synara 可行。

Claude Agent SDK（[sessions 指南](https://code.claude.com/docs/en/agent-sdk/sessions)、
[CLI 参考](https://code.claude.com/docs/en/cli-reference)）：

- `listSessions()`、`getSessionInfo()`、`getSessionMessages()`、`renameSession()`
  在我们已依赖的 SDK（`@anthropic-ai/claude-agent-sdk@0.3.207`）里就有。
- 会话默认持久化到 `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
  （encoded-cwd = 绝对路径中非字母数字字符替换为 `-`）；`CLAUDE_CONFIG_DIR` 可
  改变根目录。
- `claude --resume <id>` 的 ID 查找只搜当前项目目录（含 git worktree）——导入时
  cwd 的准确性很重要。
- JSONL 行格式**不是**有文档承诺的稳定 schema，且有过漂移前科
  （[claude-code#43053](https://github.com/anthropics/claude-code/issues/43053)）
  → 优先用 SDK API，不要解析文件。

## 3. 方案

### 阶段 0 —— 共享存储自愈与双向验证

诉求 3 的地基；不做它，后面每个阶段都有暗坑。

1. **overlay 自愈**（`codexProcessEnv.ts` 的 `ensureCodexOverlaySymlink`）：spawn
   时断言 overlay 中的 `sessions`、`archived_sessions`、`state_*.sqlite*` 是指向真实
   home 的 symlink。若发现真实目录（历史边缘 case），把内容合并回真实 home
   （rollout 是不可变/只追加的，同名文件永不覆盖），再重建 symlink。每次自愈动作
   记日志。
2. **端到端验证测试：** 通过 Synara 建 codex 线程并发一轮，断言 (a) 真实
   `~/.codex/sessions/` 下出现 rollout 文件，(b) 新起的 app-server 上 `thread/list`
   能看到它。Claude 侧：断言 `~/.claude/projects/<encoded-cwd>/` 下出现对应
   jsonl，且 SDK `getSessionInfo` 能解析。
3. Claude 侧无需改动（已共享），加回归测试锁死。

### 阶段 1 —— 会话发现服务（server 新增）

在 `apps/server/src/orchestration/`（或 `provider/`）新增
`SessionDiscoveryService`，统一产出"已发现会话"模型：

```
{ provider, externalId, cwd, title, createdAt, updatedAt, source, archived, importedThreadId? }
```

1. **Codex：** 复用现有 discovery session 基础设施
   （`codexAppServerManager.ts:1979-2124` 的 `resolveContextForDiscovery`），在
   discovery app-server 上调 `thread/list`。显式传 `sourceKinds`（包含 `exec`、
   `appServer` 等）让非交互式会话也列出。分页拉取；按 `(cursor, filters)` 缓存
   （内存 + 可选 SQLite 表）；后台刷新——绝不从 WS handler 同步触发。
2. **Claude：** 用 SDK `listSessions()`（尊重 `CLAUDE_CONFIG_DIR`，对齐
   `claudeProcessEnv.ts` 的 env 解析）。手扫 jsonl 头部只作降級兜底，且必须严格
   版本容错。
3. **增量刷新：** 定时扫描（默认约 60s，自适应）+ 按 (mtime, size) 跳过未变文件；
   容忍 `.jsonl.zst` 并存和追加中的半行。全部只读。
4. **与已知线程关联：** 与 `provider_session_runtime.resume_cursor_json`（及阶段 2
   的映射表）比对，标出 `importedThreadId`，已导入的不再显示为"新发现"。
5. **新增 WS 契约：** `orchestration.listExternalSessions {provider?, cwd?}` 读缓存
   返回，可选变更推送。契约加在 `packages/contracts/src/orchestration.ts`。

### 阶段 2 —— 导入管线强化（扩展，不重写）

1. **去重 / 身份映射：** 新增持久化映射 `(provider, externalId) → threadId`（新
   migration；若 projection 生命周期允许，也可复活
   `projection_thread_sessions.provider_thread_id`）。重复导入同一会话 → 跳转到已
   有线程，不再复制。
2. **批量导入：** `importThreadRoute` 扩展为接受列表；单项失败互不影响。可选设置：
   发现即自动导入。
3. **标题：** codex 用 `thread/name` 或首条用户消息；claude 用 summary 条目或首条
   prompt。替换掉通用的 `Imported … <suffix8>`。
4. **cwd → project 匹配：** 会话 cwd 匹配不上任何现有 project 的 `workspaceRoot`
   时，自动创建 project（或先归入"未归档"分组，待用户确认）。保留
   `importThreadRoute.ts:135-219` 现有的 envMode/worktree 修补逻辑。
5. **历史保真（工作量最大，拆 2a/2b）：**
   - 2a：维持现有文本级映射（user/assistant）——会话先"能看能续"。阶段 0–2a 先
     交付。
   - 2b：把 codex 的 turn 结构映射为 `projection_turns`、item 映射为 activities
     （工具调用、推理、计划）；Claude 侧同样扩展 `mapClaudeSessionMessages`。
     `turnId` 非空后，导入的历史也能用 checkpoints/diffs。
6. **一切持久化都走 command/event 路径**（事件溯源约束，见 §2.1）。

### 阶段 3 —— Web UI

1. **发现面板：** 侧边栏加"发现的会话"区块，按 project 分组；每行带来源徽标
   （codex CLI / Desktop / claude CLI）、标题、更新时间；支持搜索、一键导入、批量
   导入。替换 `SidebarSearchPalette.tsx:582-597` 现在贴 UUID 的交互（贴 ID 保留为
   兜底入口）。
2. **外部 ID 可见：** 线程详情显示 provider 会话 ID，附"在 CLI 中继续"复制按钮
   （`codex resume <id>` / `claude --resume <id>`）。需要把阶段 2 的映射通过
   snapshot 契约暴露出来。
3. **可选的自动导入开关**，放在设置里。

### 阶段 4 —— 双向同步打磨

1. **删除语义对齐：** 删除 Synara 线程时可选调 codex `thread/archive`（把 rollout
   移入 `archived_sessions/`，非破坏性），而不是只删本地绑定。
2. **外部变更刷新：** 检测已导入会话的 `updatedAt`/mtime 变化（CLI 里又聊了），
   提供"重新同步"——经同一 command 路径做增量 `thread/read` /
   `getSessionMessages` 导入追加。
3. **文档：** 更新 AGENTS.md（`providerManager.ts`/`wsServer.ts` 的引用已过时），
   并在 `docs/` 加一篇简短的"会话存储与互通"说明。

## 4. 风险与对策

- **两家的格式都会漂移。** 对策就是只走官方 API；文件扫描兜底必须失败关闭
  （跳过 + 记日志），遇到不认识的结构绝不硬解。
- **`thread/list` 的开销**（上游 #22411）。后台扫描 + 缓存 + 分页；UI 只读缓存。
- **overlay 分裂。** 阶段 0 自愈是发现功能可信的前置；启动时加不变量检查并记
  日志。
- **`claude --resume` 的 cwd 限定。** 导入必须保证 cwd→project 映射准确，否则
  "回 CLI 继续"会找不到会话。
- **双重拥有。** 没有阶段 2 的去重，两个 Synara 线程可能绑定同一个 provider 会话
  并互相破坏 turn 流。去重必须先于任何自动导入交付。
- **事件溯源。** 导入绝不直接写 projection 行——`repairState` 会擦掉。
- **并发写。** CLI 进程向会话文件追加时没有跨进程锁（claude-code#54130）。只读
  容忍：最后的半行、从 `.zst` 还原回来的文件。

## 5. 建议顺序与工作量

| 顺序 | 阶段                          | 工作量          | 价值                         |
| ---- | ----------------------------- | --------------- | ---------------------------- |
| 1    | 阶段 0                        | 小（约 1 天）   | 让双向可信，是一切的前置     |
| 2    | 阶段 1 + 2a + 阶段 3 发现面板 | 中（约 3–5 天） | 核心体验：看到并接管所有会话 |
| 3    | 阶段 2b 历史保真              | 中–大           | 导入的完整时间线             |
| 4    | 阶段 4                        | 小–中           | 打磨项，独立可后置           |

阶段 0 是硬前置。阶段 1–2a–3 交付用户可见的功能；2b 和 4 可随后独立交付。

## 6. 本机环境备注（与本方案无关）

维护者机器上的 `codex` 是 mise shim，当前 `codex --version` 会直接挂起。本机跑
端到端验证前需要先排查 shim/配置，否则阶段 0 的验证无法本地执行。
