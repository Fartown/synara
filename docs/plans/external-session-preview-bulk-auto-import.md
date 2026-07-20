# 方案 —— 外部会话：免导入预览 / 按文件夹批量导入 / 已导入文件夹自动导入

> 状态：**已提案**（未实施）。2026-07-19。
> 前置：`docs/plans/external-session-discovery-cli-interop.md` 的阶段 0–4 已全部落地
> （发现、单条导入+去重+标题、全保真历史、Resync、删除归档、文件夹分组）。
> 本文档只做设计，不含代码改动。

## 1. 背景与现状缺口

发现面板目前每个会话只展示元数据（标题/时间/来源/文件夹分组），三个被反复问到的缺口：

1. **不能免导入看内容**——想看会话内容必须导入。
2. **不能批量导入**——一次只能点一个 Import。
3. **没有自动导入**——已导入的文件夹里后来产生的新会话，只能手动导入；已导入的会话新内容只能手动 Resync。

## 2. 总体设计原则（合理性约束）

- **读优先于写**：预览是纯只读，不产生任何线程/绑定/持久化；批量与自动导入复用现有单导入链路（去重、标题、cwd 匹配、全保真回放），不发明第二条写入路径。
- **幂等保底**：批量和自动导入都经过 `(provider, externalId)` 去重，任何重复触发只会命中 `alreadyImported`，不产生双线程。
- **最小惊讶**：自动导入只覆盖"用户已显式导入过"的文件夹（导入过一次 = 显式表达了对此文件夹的兴趣），绝不全局自动导入；并提供全局开关。
- **失败隔离**：批量/自动导入逐项 try/catch，单项失败不阻断其余，不无限重试（冷却机制）。
- **性能红线**：codex `thread/list` 有上游全量读问题（openai/codex#22411），后台扫描必须低频、复用 60s 缓存、绝不阻塞 UI；预览限幅返回，长会话不全量加载。

## 3. 功能 1：免导入预览

### 3.1 交互

- **入口**：发现面板中未导入会话的**行点击**（标题区）= 预览；Import 按钮语义不变。已导入行保持"点击 = 导航到线程"。
- **形态**：右侧**预览抽屉**（drawer，非模态），宽约 480–560px。理由：会话可能很长，侧边栏内联展开空间不足；模态会挡住发现面板，无法边看边挑下一条；抽屉可连续点选多条会话快速翻阅。
- **内容**：顶部 = 标题 + 来源徽标 + 所在文件夹 + 时间 + **主 CTA「导入」**（点击后走现有导入流程并关闭抽屉）+ 关闭按钮；正文 = 只读时间线（用户/助手消息 + 工具活动行，复用线程页的渲染组件，但隐藏 composer、pin/edit/copy-message 之外的交互）。
- **限幅**：默认加载**最近 30 个 turn**；顶部显示"仅显示最近 30 turns，共 N 个"提示。不做无限滚动（v1），长会话想看全部就导入。
- **状态**：加载中 skeleton；读取失败（文件被删/损坏/codex 不可用）显示内联错误，不影响面板其余部分。

### 3.2 技术

- **新 WS 方法** `orchestration.previewExternalSession { provider, externalId, cwd? }` → `{ turns: ThreadImportedTurn[], totalTurns: number, truncated: boolean }`。
  - codex：`CodexAppServerManager.readExternalThread`（discovery context，已存在），取 snapshot.turns，用 2b 的 `mapCodexSnapshotTurns` 映射，截取尾部 30 个 turn。
  - claude：SDK `getSessionMessages(externalId, { dir: cwd })`，用 `mapClaudeSessionTurns` 映射，同样截取。
  - **零持久化**：不 dispatch 任何 orchestration command，不写 binding，不启动 provider 会话；缓存仅 react-query 客户端侧（`staleTime` 60s，键 = provider+externalId）。
- **渲染**：`ThreadExternalSessionPreview.tsx`（新组件），消息/活动行复用现有 transcript 组件的展示子组件（`session-logic.ts` 的提取器已经吃 `toolCallId/data` 形状，2b 映射输出同构，无需新映射层）。
- 工作量：小（契约 + 路由 + 一个抽屉组件 + 复用映射）。

## 4. 功能 2：按文件夹批量导入

### 4.1 交互

- **入口**：发现面板每个分组（project 组 / folder 组）的组头右侧出现 **「全部导入」** 图标按钮，带数量徽标（= 组内"未导入"会话数）。无未导入项时不显示。
- **确认**：点击后弹出轻量确认（"将导入 N 个会话到 <project 名 / 新建 project：文件夹名>"），folder 组明确提示会**新建一个 project**（cwd = 该文件夹）。
- **过程**：按钮变进度态（"导入中 3/N"）；逐项串行进行；结束后 toast 汇总："成功 X，跳过（已导入）Y，失败 Z"，失败项在 toast 详情里列出原因；成功的每项自动带 Imported 态。
- **限制**：单批上限 50 个（超出提示先预览筛选），防止误操作把几百个历史会话一次性灌进来。

### 4.2 技术

- **新 WS 方法** `orchestration.importExternalThreads { items: Array<{ provider, externalId, cwd?, title? }> }` → `{ results: Array<{ externalId, threadId?, status: "imported"|"alreadyImported"|"failed", error? }> }`。
- 服务端串行执行，每项走与单导入**完全相同**的路径：去重检查 →（folder 组首批先建 project，一次）→ 创建线程 → startSession(resumeCursor) → `thread.history.import` 回放 → 标题。
  - 线程创建改为服务端驱动（现有单导入是客户端先 `thread.create` 再调 import；批量需要服务端代劳，复用 decider 的 `thread.create` command，projectId 由 cwd 匹配/新建结果给出）。
  - 单项失败：记录 `status: "failed"` + 原因，继续下一项；全部完成后统一返回。
  - provider 会话复用：codex 每条导入都要起 discovery session + thread/resume，串行天然限速；claude 走 SDK 读文件，开销低。
- **不做并发**：v1 严格串行（每批 ≤50），避免同时拉起一堆 provider 子进程。
- 工作量：中（批量路由 + 服务端线程创建编排 + 组头 UI + 进度状态）。

## 5. 功能 3：已导入文件夹自动导入

### 5.1 语义定义

- **"已导入文件夹"** = 存在一个有效 binding（codex/claude 外部会话已导入且线程未被删除）且该会话 cwd 等于此文件夹（workspaceRoot 归一化后相等）的目录。注意它**不是** project 的同义词：project 里手动导入过至少一条外部会话，这个 project 的目录才成为"已导入文件夹"。
- **自动导入范围**：已导入文件夹内、**后来发现**的、未绑定（`importedThreadId` 为空）的、交互来源的会话（codex 默认 sourceKinds 已排除 exec/subagent；claude `includeProgrammatic: false` 已排除 SDK/headless——**这条同时挡住了 Synara 自己产生的 claude 会话**；codex 侧 Synara 产生的会话都有 binding，被去重排除）。
- **不做**：不回溯自动导入历史存量（首次启用不扫荡——否则首次就是批量惊喜；只导入开关生效后**新出现**的会话）；不自动导入"未导入过任何会话"的文件夹。

### 5.2 交互

- **设置**：Settings → Providers 区新增全局开关「自动导入已导入文件夹的新会话」（默认**关**——自动建线程是强行为，opt-in 才符合最小惊讶；用户明确要求的功能由用户显式打开）。
- **可见性**：开启后，发现面板的已导入文件夹组头显示一个小的 "auto" 标记（表示此文件夹在自动导入覆盖范围内）；自动导入产生的线程与普通线程无异，title 照常。
- **反馈**：自动导入成功时在发现面板产生一次轻提示（toast 可选，默认静默写入列表——线程本来就该安静地出现在 project 下）；失败仅在 server log，冷却期内不再试（见下）。

### 5.3 技术

- **触发**：服务端后台定时器（默认每 5 分钟，可配置）+ 服务启动后 60s 首次扫描。复用 `listExternalSessions` 的发现结果（60s 缓存到期后自然刷新），**不为自动导入单独加重扫描频率**。
- **判定**：对每个已导入文件夹（由 bindings × 会话 cwd 推导），筛出未绑定且 `updatedAt > 该文件夹上次自动导入水位` 的会话，逐个走与批量导入相同的单导入路径（天然串行、天然去重）。
- **状态持久化**：新表（migration）`external_auto_import_state`：`folder_cwd PK, last_seen_updated_at, last_import_at, last_error, consecutive_failures, cooldown_until`。失败指数退避（5m → 15m → 1h → 6h 封顶），成功后清零。
- **设置**：`ServerSettings` 增加 `externalSessions.autoImportEnabled`（布尔，默认 false），改动即时生效（settings revision 机制已有）。
- 工作量：中（migration + 后台任务 + 设置 + 组头标记）。

## 6. 契约与数据模型变更汇总

| 项                                                  | 变更                                                        |
| --------------------------------------------------- | ----------------------------------------------------------- |
| `orchestration.previewExternalSession`              | 新 WS（只读预览，限幅 30 turns）                            |
| `orchestration.importExternalThreads`               | 新 WS（批量导入，≤50，逐项结果）                            |
| `external_auto_import_state` 表                     | 新 migration（水位/失败冷却）                               |
| `ServerSettings.externalSessions.autoImportEnabled` | 新设置项（默认 false）                                      |
| web                                                 | 预览抽屉组件；组头"全部导入"+进度；组头 auto 标记；设置开关 |

无破坏性变更：所有现有方法/行为保持不变。

## 7. 风险与合理性论证

- **自动导入的"惊喜成本"最高**：线程在用户没点任何东西时出现。对策：opt-in 默认关 + 只覆盖显式导入过的文件夹 + 不回溯存量 + 来源白名单（交互式）+ 去重幂等。四重限制下，剩下的惊讶正是用户要求的行为本身。
- **预览的性能**：codex `thread/read` 大会话可能 MB 级——服务端截尾 30 turns 再传，不在服务端缓存（ react-query 足够）；连续翻页式点击不会重复 spawn app-server（discovery session 复用）。
- **批量导入的资源压力**：严格串行 + 上限 50；codex 侧每条的 discovery spawn 复用既有 session，不会进程爆炸。
- **隐私**：三个功能读的都是本机文件，与现有发现功能同级；自动导入是 opt-in。
- **与 Resync 的边界**：自动导入只处理"新会话"，已导入会话的新内容仍归 Resync 管（手动）。未来若要把 Resync 也自动化，在同一水位表里加 per-thread 水位即可，不在本期范围。
- **删除语义连锁反应**：批量/自动导入的线程被删除时，codex 侧照常归档（现有行为），语义一致。

## 8. 测试方案（落地时执行）

- 单测：预览限幅/映射/只读（无 dispatch 断言）；批量逐项失败隔离/去重跳过/上限拒绝；自动导入判定（水位、排除项、冷却退避、开关即时生效）。
- UI 用例（并入现有 Playwright 套件）：P1 预览抽屉只读打开/导入 CTA；P2 folder 组全部导入（2 个种子）→ 两线程 + Imported + toast 汇总；P3 开启开关后新增 claude 种子 → 5 分钟内自动出现线程（测试时用可注入的扫描间隔缩短到秒级）；P4 未开启开关不自动导入。

## 9. 分期建议

| 期  | 内容                        | 工作量          |
| --- | --------------------------- | --------------- |
| 1   | 功能 1 免导入预览           | 小（约 1 天）   |
| 2   | 功能 2 按文件夹批量导入     | 中（约 2 天）   |
| 3   | 功能 3 已导入文件夹自动导入 | 中（约 2–3 天） |

三期相互独立，可按任意顺序实施；建议按 1 → 2 → 3，因为 2、3 共用"服务端驱动的单导入编排"这一中间件。

---

# 执行报告（2026-07-19，全部完成并通过）

## 实现

- **功能 1 预览**：`orchestration.previewExternalSession`（映射全量历史、截尾 30 turns、`totalTurns`/`truncated`、60s 缓存；构造上只读——handler 拿不到 engine/binding）；web 右侧 520px 预览抽屉（disclosure 动效、ESC 关闭、行点击切换、truncated 提示、导入 CTA 复用行内导入路径）。
- **功能 2 批量导入**：抽出共享导入核心 `externalSessionImport.ts`（单导入路由变为薄适配层，行为不变）；`orchestration.importExternalThreads`（≤50、严格串行、逐项状态、同 cwd 只建一次 project、失败清理空壳线程）；组头 "Import all · N" + 确认 + 进度 + toast 汇总。
- **功能 3 自动导入**：设置 `externalSessions.autoImportEnabled`（默认 false，UI 开关即时生效）；migration 070 `external_auto_import_state`（水位/失败冷却 5m→15m→1h→6h）；纯函数引擎 + 5 分钟周期任务（复用发现缓存与批量核心，首跑只播种水位不回溯）；组头 "auto" 标记。
- **副产修复**：`externalSessionImport.ts` 错误通道收窄的 typecheck 问题、web 两个 settings 测试 fixture 补字段。

## 验证

- **单测/全量**：server 2253 + web 2784 全绿；`bun fmt`/`lint`/`typecheck`（8/8）全绿。
- **真实 UI（Playwright，P 套件）**：
  - P1 预览：抽屉展示会话内容、只读（不建线程）、ESC 关闭（宽度归 0——innerText 含 overflow 隐藏内容，断言需测宽度）、抽屉内 Import CTA 建线成功。**全过**。
  - P2 批量：folder 组 Import all → 确认 → 建 project + 两会话全部 Imported；**故意截断的会话文件被容错导入**（partial 尾行被忽略）——容错性实证。**全过**。
  - P3 自动导入：Settings UI 开启开关 → 首扫只播种水位（DB 实证 `last_import_at=null`）→ 新种子会话在重启扫描中**自动成线**；旧种子不被回溯（no-backfill 实证）；组头 "auto" 标记显示。**全过**。
  - P4 默认关闭：开关关闭时新会话只出现在发现列表、绝不自动导入。**全过**。
- **测试环境教训（新增）**：claude 种子的 sessionId 必须是合法 UUID（`zzzz…` 会被 SDK listSessions 静默过滤）。

## 遗留/边界（诚实记录）

- 预览 v1 只读最近 30 turns，无无限滚动；更长内容请导入。
- 批量进度为总量态（"Importing N…"），无逐项进度通道（避免高频重扫 codex 上游）。
- 自动导入的 "auto" 标记为组级近似（组内任一会话已导入即显示），服务端判定以精确 cwd 为准。
- orca computer-use 因本机 TCC 抖动不可用期间，以上 UI 验证均由 Playwright 完成。
