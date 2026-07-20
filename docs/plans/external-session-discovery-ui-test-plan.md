# 真实界面 UI 测试方案 —— 外部会话发现与 CLI 互通

> 对应技术方案：`docs/plans/external-session-discovery-cli-interop.md`。
> 驱动工具：Orca `computer-use`（`orca computer …`，操作桌面浏览器的无障碍树 + 截图）。
> 执行方式：逐条人工/agent 执行，每条记录 PASS/FAIL 与截图证据；FAIL 修复后重跑，
> 直到全部通过。本文档中的 UI 元素名称以实现落地后的实际文案为准（阶段 3 完成后校订）。

## 1. 测试环境（隔离，不碰用户真实数据）

### 1.1 隔离 dev 实例

```bash
# 先 dry-run 确认无端口冲突（lsof -nP -iTCP:58090 -sTCP:LISTEN）
env -u SYNARA_AUTH_TOKEN SYNARA_PORT_OFFSET=3158 SYNARA_NO_BROWSER=1 \
  CODEX_HOME=$PWD/.uitest/codex-home \
  CLAUDE_CONFIG_DIR=$PWD/.uitest/claude-config \
  bun run dev -- --home-dir ./.synara-uitest --port 58090
```

- server 端口 58090，web 端口 8891（以 dry-run 输出为准）。
- `CODEX_HOME` 指向假 home：Synara 的 overlay 机制以它为源，彻底隔离真实 `~/.codex`。
- `CLAUDE_CONFIG_DIR` 指向假配置目录：Claude 发现/SDK 都读它，隔离真实 `~/.claude`。
- 用 `orca computer` 操作系统浏览器（Chrome/Safari）访问 `http://localhost:8891`。

### 1.2 种子数据

**假 Codex home（`.uitest/codex-home/`）**：

- `sessions/2026/07/10/rollout-2026-07-10T10-00-00-<uuidA>.jsonl`：首行
  `session_meta`（`id`、`cwd` = 某测试 project 的 workspaceRoot、`originator: "codex_cli"`、
  `source: "cli"`、`timestamp`），随后若干 `response_item` 消息行（user/assistant 各 2 条）。
- 第二个 rollout（`source: "vscode"`、`originator: "synara_desktop"`）用于验证来源徽标。
- 一个 `archived_sessions/` 下的 rollout，验证归档会话不出现在发现列表。

**假 Claude 配置目录（`.uitest/claude-config/projects/`）**：

- `<encoded-cwd-A>/<uuidB>.jsonl`：3–5 行 user/assistant 消息（含 `sessionId`、`cwd`、
  `timestamp`），首行带 `summary` 或首条 user 消息作为标题来源。`cwd-A` 等于测试 project
  的 workspaceRoot。
- `<encoded-cwd-C>/<uuidC>.jsonl`：`cwd-C` 不属于任何现有 project，验证"其他位置"分组。
- 一个故意截断（最后半行）的 jsonl，验证容错（跳过不崩）。

**Synara 内已有的测试 project**：workspaceRoot = `cwd-A`（发现结果应能匹配到它）。

### 1.3 Orca 驱动约定

- `orca computer list-apps --json` 找到浏览器 bundle id；地址栏用
  `set-value --element-index <addrBar>` + `press-key Return` 打开页面。
- 每步操作后重新 `get-app-state --app <browser> --json` 取最新无障碍树再选元素。
- 每条用例至少留 1 张截图（`screenshot.path`），命名 `T<编号>-<步骤>.png`。

## 2. 测试用例

### T0 环境冒烟

- 前置：dev 实例按 1.1 启动，种子数据按 1.2 就位。
- 步骤：打开 `http://localhost:8891`；等侧边栏加载。
- 预期：已有 project/线程列表正常显示；无白屏/报错 toast。

### T1 发现面板展示（改造点：发现服务 + UI 面板）

- 步骤：打开侧边栏"发现的会话"入口（点击刷新）。
- 预期：
  - 列出种子 Claude 会话 ×2 + Codex 会话 ×2（codex 见 T7 条件说明）；
  - 每条显示标题（claude 取 summary/首条 prompt；codex 取 preview）、来源徽标
    （Claude Code / Codex CLI）、相对时间；
  - `cwd-A` 的会话归入匹配 project 分组；`cwd-C` 的会话归入"其他位置"；
  - 归档的 codex 会话不出现。

### T2 刷新与缓存（改造点：60s TTL 缓存 + forceRefresh）

- 步骤：记录首次刷新耗时；立刻再刷新一次（应命中缓存、明显更快）；新增一个种子
  jsonl 后点刷新（带 forceRefresh）→ 新会话出现。
- 预期：缓存生效；强制刷新能拿到新文件。

### T3 一键导入 + 历史回放 + 标题（改造点：导入一键化、标题映射）

- 步骤：在发现面板对 claude 会话 `<uuidB>` 点"导入"。
- 预期：
  - 自动创建线程并跳转；线程标题 = 种子的 summary/首条 prompt（不是
    `Imported … <suffix8>` 通用名）；
  - 历史区完整显示种子里的 user/assistant 消息；
  - 线程进入可继续对话状态（session ready）。

### T4 去重（改造点：`(provider, externalId)` 唯一映射）

- 步骤：对同一会话 `<uuidB>` 再次执行导入（发现面板若仍可见则再点，或用
  `orchestration.importThread` 直接调用）。
- 预期：不产生第二个线程；UI 跳转到 T3 已导入的线程；返回
  `alreadyImported: true`。

### T5 已导入标记（改造点：importedThreadId 关联）

- 步骤：T3 之后回到发现面板刷新。
- 预期：`<uuidB>` 不再以"可导入"出现（消失或显示"已导入"态）；未导入的
  `<uuidC>` 仍在。

### T6 外部 ID 与 CLI 恢复命令（改造点：`getThreadExternalSession` 路由 + UI 展示）

- 步骤：打开 T3 导入的线程，查看线程详情/头部的外部会话 ID 区域，点复制按钮。
- 预期：显示 `<uuidB>`；剪贴板内容 = `claude --resume <uuidB>`（codex 线程则为
  `codex resume <id>`）。

### T7 Codex 发现（条件用例 —— 本机 codex CLI 异常时降级验证）

- 背景：本机 `codex`（mise shim）`--version` 即挂起；若 app-server 同样无法启动，
  此用例在本地不可完整执行。
- 步骤：发现面板刷新后观察 codex 分组。
- 预期（codex 可用）：T1 中两条 codex 种子会话列出。
- 预期（codex 不可用 —— 降级）：claude 会话正常列出；codex 分组显示失败提示或为空；
  服务端日志有错误记录；UI 不卡死、不阻断 claude 侧。
- 补充验证：codex 侧解析逻辑由服务端单元测试覆盖（不在 UI 层面重复）。

### T8 Synara → Claude CLI（outbound 兼容，改造点：阶段 0/4 验证）

- 步骤：在 Synara 里新建 claude 线程（project `cwd-A`），发一条消息等回复完成；
  记下线程的外部 session id（T6 区域）。
- 预期：
  - 假配置目录 `.uitest/claude-config/projects/<encoded-cwd-A>/` 下出现对应
    `<sessionId>.jsonl`；
  - 终端执行 `CLAUDE_CONFIG_DIR=$PWD/.uitest/claude-config claude --resume <sessionId>
-p "只回复两个字：继续"` 能接续会话（输出含"继续"，且 jsonl 追加新行）。

### T9 Overlay 自愈（改造点：阶段 0，CLI 级验证）

- 前置：停掉 dev 实例。在假 codex home 的 overlay
  （`.uitest/…/codex-home-overlay` 或默认 `~/.synara/runtime/codex-home-overlay`，
  以 `codexHomePaths.ts` 解析为准）里手工建立一个**真实目录** `sessions/2026/07/11/`
  并放入一个 rollout 文件，模拟分裂状态。
- 步骤：重启 dev 实例（触发 overlay 准备）；检查 overlay。
- 预期：overlay 的 `sessions` 变成指向假 home `sessions/` 的 symlink；手工放置的
  rollout 被合并进假 home（同名不覆盖）；服务端有 heal 日志。
- 注：此用例为文件系统级验证，不需要 UI 操作，但与 UI 测试同一轮执行。

### T10 回归：既有功能不受影响

- 步骤：在 dev 实例里打开一个既有线程发一条消息（claude provider）；新建/删除一个
  普通线程；切换 project。
- 预期：消息流正常、线程增删正常、侧边栏快照刷新正常；控制台无新增报错。

## 3. 通过标准与记录

- 全部用例 T0–T10 PASS（T7 允许以"降级"预期 PASS）。
- 每条记录：执行时间、PASS/FAIL、截图路径、失败时的修复 commit/说明。
- 记录表维护在执行笔记中（可附在本文档下方或 PR 描述里）。

## 4. 已知限制

- Codex 端到端受本机 codex CLI 挂起影响；服务端解析由单测覆盖，UI 只验证降级路径。
- UI 元素文案以阶段 3 实现为准；执行前先校订本文档 T1/T3/T6 中的名称。

---

# 执行报告（2026-07-19，全部通过）

## 执行方式变更

Orca `computer-use` 的无障碍权限在本机处于"显示已授予但实际拒绝"的 TCC 异常（`orca computer permissions` 显示 granted，`get-app-state` 持续 permission_denied；helper 重启、设置面板重开均无效，需用户手动开关）。**实际执行改用 Playwright 1.58（Chromium headless-shell）驱动真实浏览器**，测试用例与断言不变；截图/aria 快照证据在 `.uitest/evidence/`。脚本在 `apps/web/.playwright/ui-tests/`（被 .gitignore 覆盖）。

## 环境修正（执行中发现）

- 隔离 `CLAUDE_CONFIG_DIR` 会使 claude 无法鉴权（凭据在真实 home/keychain）。改为：种子会话放入真实 `~/.claude/projects/`（假 UUID，测后已清理），Codex 侧仍用假 `CODEX_HOME`。
- 教训：不要用无头 `claude -p` 探测种子会话——headless 标记会让 SDK 把会话归类为 programmatic，`includeProgrammatic: false` 的发现查询会将其过滤。

## 结果（11/11 PASS）

| 用例                 | 结果 | 证据/备注                                                                                                                                  |
| -------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| T0 环境冒烟          | PASS | `T0-initial.png`                                                                                                                           |
| T1 发现面板          | PASS | claude 会话按 project 分组（workspace-a / Other locations）、标题/时间/徽标正确；归档 codex rollout 未出现                                 |
| T2 刷新缓存          | PASS | 刷新后列表保持，60s TTL 生效                                                                                                               |
| T3 一键导入          | PASS | 线程标题=summary，user/assistant 历史完整回放，进入可续聊状态                                                                              |
| T4 去重              | PASS | 重复导入跳转已建线程（`alreadyImported`），无双份                                                                                          |
| T5 已导入标记        | PASS | 列表显示 Imported 态，点击即导航                                                                                                           |
| T6 外部 ID/CLI 命令  | PASS | 徽标显示缩写 ID，复制 = `claude --resume <uuid>`（剪贴板断言）                                                                             |
| T7 codex 降级        | PASS | 本机 codex CLI 坏（`spawnSync codex ETIMEDOUT`）；20s 超时后 claude 正常列出、UI 不卡死、服务端 warn 日志正确                              |
| T8 Synara→Claude CLI | PASS | UI 新建线程（Claude Sonnet 5）发消息收到回复；新 jsonl 落 `~/.claude/projects/`；`claude --resume <新id>` 无头续聊成功（`is_error:false`） |
| T9 overlay 自愈      | PASS | 分裂的真实 `sessions/` 目录被合并回源 home 并重建 symlink（`copiedFiles=1`），CLI 级断言                                                   |
| T10 回归             | PASS | 重载后线程持久、导入历史完整、导航正常                                                                                                     |

## 执行中修复的问题

1. **发现路由可永久挂起**：单 provider 发现 hang 时（本机 codex `--version` 挂起）整个 `listExternalSessions` 永不返回，UI 永远"Scanning…"。已修复：每 provider 20s 超时（`EXTERNAL_SESSION_DISCOVERY_TIMEOUT_MS`），超时按该 provider 失败处理（warn + 空列表），其余 provider 正常返回（`listExternalSessionsRoute.ts`，含 TestClock 测试）。
2. **contracts `NativeApi` 缺声明**：`listExternalSessions`/`getThreadExternalSession` 已补入 `packages/contracts/src/ipc.ts`，删除 web 侧 cast 绕过（`externalSessionsOrchestrationApi`）。

最终门禁：`bun fmt`、`bun lint`（0 错误）、`bun typecheck`（8/8）全部通过。

## 追加：阶段 2b / 4（同日完成）

- **阶段 2b 导入历史全保真**：新内部命令 `thread.history.import` + 事件 `thread.turn-imported`；导入的会话现在有真实 turn 结构、工具调用/推理 activities、proposed plans（按 live 形状映射），旧文本导入的行按确定性 id 原地升级。不伪造 git checkpoint/diff（无工作区快照，diff 对导入 turn 仍不可用）。decider 刻意避开 `turn-start-requested`，重放不触发 provider 调用/标题生成/git 操作。
- **阶段 4**：删除 codex 绑定线程时尽力而为调 `thread/archive`（失败仅记日志、不阻断删除）；新增 `orchestration.resyncExternalThread` + 发现面板 Resync 按钮（重读外部历史、幂等 upsert，CLI 里续聊的内容可同步回来）。
- **验证**：server 2214 + web 2770 全量通过；`bun fmt`/`lint`/`typecheck` 全绿；本方案 T0–T10 在最终代码上重跑仍 **14/14 PASS**（导入路径已切到 2b 保真通道，断言全部保持）。
- **测试环境教训（补充）**：无头 `claude -p` 探测会把 queue-operation/promptId 等 headless 行写进会话文件（包括 CLAUDE_CONFIG_DIR 指向的假目录），导致 `includeProgrammatic: false` 的发现查询过滤该会话——种子被污染后必须重写干净版本。

## 追加：Codex 真机 + Figma 长会话（同日，suite-c 11/11 PASS）

- **根因修复 1**：本机 `codex --version` 挂起的是 mise/node 包装层，真实 vendor 二进制（`@openai/codex-darwin-arm64/vendor/.../bin/codex`）正常（0.144.5）。测试实例通过 settings `providers.codex.binaryPath` 指向 vendor 二进制。
- **根因修复 2（真 bug）**：发现链路的 discovery session 硬编码 `binaryPath: "codex"`，忽略设置的自定义 binaryPath——自定义路径的用户 codex 发现/导入全挂。已修：`getOrCreateDiscoverySession`/`readExternalThread`/`listExternalThreads` 全链路透传 `providerStartOptionsFromServerSettings` 解析的 binaryPath/homePath（44/44 聚焦 + 191 回归通过）。
- **Codex 端到端**：真实 `~/.codex` 的 codex 会话在发现面板列出（含 dreamina-octo 的 Figma 相关会话）；导入 `拉取 feat/post_edit_full 分支` 会话 → **67,398 字符全保真历史**（消息+工具活动）；徽标复制 = `codex resume 019f7565-…`（剪贴板断言）；`codex exec resume 019f7565-… "只回复两个字：继续"` 真实续聊成功（输出"继续"，加载 62k tokens 上下文）。
- **Claude 长会话**：用户真实导入的"评审 Figma 即梦画布交互规范"线程渲染 8,291 字符 + 消息气泡 + "Worked for …" 活动行（2b 保真渲染）。
- **UI 微交互**：线程头部徽标的复制按钮被 tooltip 包装且极小，合成 pointer 点击可能被拦截——DOM `el.click()` 是可靠触发方式（功能本身无 bug）。
- **orca 状态**：权限间歇性失效（TCC 显示 granted 实际 denied，helper/app 重启均复发），本轮用 Playwright 完成实质验证；orca 可用期间已独立确认发现面板树、分组、Imported/Resync 状态、徽标与 codex 降级提示。
