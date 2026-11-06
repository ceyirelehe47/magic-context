# 原生角色方案（native roles）：由插件改变 DSH 构造模型请求的方式，不动 core

第 36 轮 E 线，2026-11-06。用户 18:12 CST：「多看看 magic context 在 opencode 中是怎么做的」「我们不动 magic context core。可以靠插件改变 dsh 的逻辑」。

本文只是**设计和调研**。产品代码没有改动；spike 原型只在本地分支 `r36e`（worktree `/workspace/work/mc-e`），没有 push。
core（`packages/plugin`）只读，`node_modules` 只读。

证据等级的写法：

* **已复现**：在本地真实 `@deepseek-ai/dsh-session` Session 上用单文件测试跑过（见 §5）。
* **静态**：读源码得出，没有运行。
* 文件行号：core 以 `87434df01` 为准；DSH 以 rc.5 的 `packages/dsh-plugin/node_modules/@deepseek-ai/*/lib/index.js` 为准，
  alpha.3 / rc.1 取自 `/workspace/work/r30-dsh/<ver>/<pkg>/package/lib/index.js`。

> **结论**：DSH rc.5 / alpha.3 / rc.1 都已经内置了 OpenCode 那种「原位改写、角色不变」需要的原语，适配层没有用上：
>
> 1. **单个 `tool/result` 节点的 surface replace**：只能替换恰好一个当前 tool/result 节点，而且只能改 `content`
>    （`dsh-session` `assertToolResultRewrite`，rc.5 L394–411）。官方插件 `@deepseek-ai/dsh-compaction-tool-result-pruner`
>    就是这么剪工具结果的。被替换节点留在原位置，前面的 assistant `tool_calls` 不动，角色仍是 tool。
> 2. **单个 `user/message` 节点的 replace**：没有额外限制，可以原位给用户文本加 §N§、插 temporal marker、改成 `[dropped §N§]`。
> 3. **`compaction/prune` 影子计价事件**：紧挨在 replace 前面追加，token-meter 就会从压力里减掉被替换内容的价钱
>    （`dsh-token-meter` L190–300）。适配层的 replace 现在都不带这个事件，所以 meter 不会重新计价。
>    这正是第 31 轮查到的 C3 根因（historian 提前触发）。
> 4. `SessionStore.registerMessageProjection`：插件自己定义事件类型，可以原位改写任何角色的消息，assistant 文本也行。
>    这是公开 API，但要求插件常驻；插件卸载后，用过它的 live session 会拒绝继续派生消息。
>
> 这四点的相关代码在三个版本里**字节相同**（§2.8）。推荐**方案 N**：用 1+2+3 做「逐节点原生改写」，不再折叠成 user；
> historian 发布时仍用一个 user/message 覆盖整段区间（OpenCode m[0] 和 DSH 自带压缩都是这个形态）。
> assistant 文本不再加 §N§，改由 historian 覆盖（这是与 OpenCode 唯一保留的偏差）。
> 预期效果是推理回到基线水平（约 17 token/步，D 线 foldtail 实测 64/17），每步省约 29 % 成本；命中率不降，因为改写仍只在
> reclaim ride 上落地，而且只从被改写的那个节点开始失效。另外 C3 的 meter 漂移也会顺带修掉。
>
> spike（§5，本地分支 `r36e-spike`，未 push）在真实 rc.5 Session 上 8/8 通过：角色序列和 tool_call 配对不变；
> 给新结果打 tag 不改变已发送的前缀；drop 只改那一条 tool 消息；重放结果字节相同；真实 TokenMeter 对原生 drop
> 减掉 3046→50 token，不带影子价的 replace 则保持 3046 不变。

---

## 1. OpenCode 版 MC 的请求管线（core，只读）

入口：`experimental.chat.messages.transform` → `createTransform(deps)`（`packages/plugin/src/hooks/magic-context/transform.ts` L771）。
OpenCode 每次请求前都会从自己的库里**重新构建**原生消息数组（`MessageLike = { info: {role,…}, parts: [...] }`），
transform 在这个数组上**原地修改 part**，修改结果不写回宿主消息库。可重放性靠 MC 自己的 SQLite（tags、pending_ops、
dropped 状态、m0/m1 缓存、reasoning watermark 等）：每次 pass 都从原始消息出发，**确定性地重放**全部已提交的决定，
所以同一状态下每次产出的字节都一样。

### 1.1 每次请求的顺序（主路径，非 rust-mode）

| # | 环节 | 位置 | 做什么 |
|---|---|---|---|
| 0 | 会话状态 / 调度决定 | `transform.ts` L800–1500；`transform-context-state.ts` | 读 session_meta、上次 usage，算 contextPercentage、`schedulerDecision`（execute / defer）、`cacheExpired`（`computeHardCacheExpired`），以及 95 % 阻断和 80 % 紧急阈值 |
| 1 | ctx_reduce 可用性 | `ctx-reduce-availability.ts`；`transform.ts` L1170–1240 | 冻结本会话 ctx_reduce 是否可用。不可用时 `skipPrefixInjection`，§N§ 和 nudge 全部不出现 |
| 2 | historian 决定 | `transform.ts` L2300–2360；`compartment-trigger.ts` | 决定本 pass 是否启动或等待 historian，在 tagMessages 之前做 |
| 3 | temporal marker | `temporal-awareness.ts` `injectTemporalMarkers`；`transform.ts` L2536–2550 | 按时间间隔在 user 文本前插 gap 标记（决定持久化，重放字节相同） |
| 4 | **tagging** | `tag-messages.ts` `tagMessages` L689；`transform.ts` L2572 / L2629 | 给每个 text part 和 tool part 分配或复用 tag id。§N§ 前缀写在 text part（L1188）和 **tool output**（L1292）上，**不改 role、不合并消息**。同时收集 `reasoningByMessage`，并建 `TagTarget`（drop / truncate 的写入口） |
| 5 | reasoning 重放 | `transform.ts` L2780–2820；`reasoning-removal.ts` | 按 watermark 把旧的 reasoning part **neutralize**（替换成 `[cleared]`，或从线上去掉 inline thinking），所在消息不删 |
| 6 | compartment 阶段（historian 摘要替换） | `transform-compartment-phase.ts` `runCompartmentPhase` L152；`inject-compartments.ts` | historian 已发布的 compartments 渲染成 `<session-history>…</session-history>`，**写进 m[0]**：第一条消息的第一个 text part 前面，或在头部 `unshift` 一条 synthetic **user** 消息（`renderCompartmentInjection` L826–866）。被覆盖的原始消息从数组头部**整段删除**（`cutCoveredPrefix` L433） |
| 7 | **apply ops**（drop / flushed） | `transform-postprocess-phase.ts` `runPostTransformPhase` L2056 → `applyPendingOperations`（`apply-operations.ts` L488）、`applyFlushedStatuses` L807 | 只在 reclaim ride 允许时执行（L2689 `reclaimRidePermitted`）。工具 drop 有三种模式：`skeleton_real`（保留调用和真实参数，output 改成 `[dropped §N§]`）、`full`（调用和结果都删掉）、`skeleton_stripped`（`applyNewToolDrop` L100–160）。文本 drop 把 text 改成 `[dropped §N§]`（`buildReplacementContent` L66）。已提交的 drop 每个 pass 都重放（`applyPersistedToolDrop`） |
| 8 | heuristic cleanup / emergency | `heuristic-cleanup.ts`、`emergency-drop.ts`；postprocess L3036–3250 | 去重、system-injection strip、force band 紧急 drop。同样走 TagTarget 原位写 |
| 9 | caveman（实验） | `caveman*.ts`；postprocess L3191–3340 | 按年龄压缩旧的 user / assistant 文本，原位改 |
| 10 | m[0] / m[1] 渲染 | postprocess L3824–3930 | soft+（defer）：m[0] 和 m[1] 字节相同；soft（execute / bust）：m[1] 重渲染；hard（TTL、system、tools、model 变化）：m[1] 折叠进 m[0] 重新物化（`m0m1-taxonomy.test.ts` L6–15） |
| 11 | sentinel / neutralize | postprocess L3930–4020 | 重放以前 neutralize 过的 dropped 或 system-injected 消息（空壳，role 不变） |
| 12 | nudge | `ctx-reduce-nudge.ts`（Channel 1：写在 tool output 尾部）；`note-nudger.ts`；postprocess L4289 | 提示文字追加到**已有** part 的尾部，不新增角色 |
| 13 | todo synthesis | postprocess `applyTodoSynthesis` L365 / L4316 | 在头部插 synthetic todo 锚点 |
| 14 | 最终表示 | `finalizeMessageRepresentation` L1973 / L4952 | 按 provider 定空内容和 reasoning 的序列化方式 |
| 15 | system 注入 | `system-prompt-delivery.ts`、`system-prompt-hash.ts` | MC 系统段经 system prompt 下发，hash 变了就算 hard bust 信号 |
| 16 | cache-busting 信号与门控 | `cache-busting-signals.ts`（`canConsumeDeferredOnThisPass`、`MaterializationPassSignals`、ride 信号）；`fold-execution-gate.ts`（`foldExecutesThisPass = foldDue && materialized`）；`execute-reclaim.ts` | 只有已经付出 cache bust 的 pass（historian 发布、hard fold、force、flush、TTL 过期）才允许把 drop 等改写落地 |

### 1.2 不变量

* **字节稳定**：defer pass（没有新决定）的输出与上一 pass 字节相同。所有改写都是「状态 → 字节」的纯函数，每次重放
  （`apply-operations.ts` L52–66 注释：drop 占位符刻意固定为 `[dropped §N§]`，曾因预览变体导致缓存灾难）。
* **前缀只在 ride 上改写**：新 drop 和 m[1]→m[0] 折叠只在 §1.1 #16 的信号下执行，否则排队等待（`pending_ops`）。
  新内容只追加在尾部；新 tool output 加 §N§ 不算改写前缀，因为它还没被发出过。
* **角色和结构不变**：除了 m[0] 头部（historian 摘要、todo）以外，transform 不新建、不合并、不改 role。
  工具调用和工具结果保持 OpenCode 原生的 tool part（assistant 侧带 call 和 state.output），provider 层序列化成原生的
  assistant `tool_calls` + `tool` 消息。
* **reasoning**：只 neutralize，不删除消息。Anthropic 签名 thinking 有专门的保持和冻结逻辑
  （`signed-thinking-hold.ts`、`strict-thinking-prefix.ts`），DeepSeek 不涉及。
* **当前轮**：一律原生，只会给新 output 加 §N§；protected tail 内不 drop（`protected-tail-boundary.ts`）。

### 1.3 historian 发布后旧区间变成什么

被覆盖的消息从请求里**删除**（L433），摘要作为**user 角色**的 `<session-history>` 文本放在 m[0]：
优先并进已有的第一个 user text part，否则新建一条 synthetic user 消息。新发布的 compartments 先作为 m[1] 增量出现，
等到 hard bust 才折叠进 m[0]。

### 1.4 「压缩」和 m0/m1 折叠

* **压缩**在 OpenCode 里指宿主自己的 compaction（`/compact`、自动压缩）。MC 用 compaction marker 接管
  （`compaction-marker-manager.ts`），在宿主压缩边界上重新锚定 m[0]，historian 摘要取代宿主摘要。
* **m0/m1 折叠**：m[0] 是冻结的头部（摘要、记忆、文档），m[1] 是自上次物化以来的增量。fold = 把 m[1] 并进 m[0]，
  只在 hard 信号或 `foldExecutesThisPass` 时执行。

### 1.5 DSH 适配层与 OpenCode 的偏差

| 环节 | OpenCode | DSH 适配层（`packages/dsh-plugin`） | 影响 |
|---|---|---|---|
| 消息来源 | 每次从宿主库重建，transform 结果不持久 | DSH surface 是持久的事件日志，改写必须变成 `session.append(…, {surfaceOp:"replace"})` 事件（`coordinator.ts` L1–27） | 适配层要把「重放」变成「只追加一次改写事件」，由 outbox/CAS 保证幂等 |
| **工具调用和结果** | 原生 assistant tool_calls + tool | `transcript.ts` `walkDshLog` L680–800：tool-call assistant 节点会**一直挂起**，等结果到达后，与结果一起**折叠成一条 synthetic user 消息**（`synth-user-*`）。coordinator 再用**一个 user/message replace 覆盖整段** [assistant .. tool results] | **已知限制 1**。当前轮也被折叠，模型每步重新推一遍进度。D 线：推理 ~295 vs 7 token/步，每步成本多约 29 % |
| §N§ 在工具结果上 | 写在 tool output | 写在折叠后 user 文本里的工具结果段 | 角色错误 |
| 工具 drop | `skeleton_real` / `full` / `skeleton_stripped`，原位 | 折叠后的 user 文本里改字 | 同上；改写整条折叠消息，不只是那一个结果 |
| 文本 §N§ / drop | text part 原位 | 同一个折叠 replace | user 文本的处理本来就是 user 角色，但会和工具一起被整段替换 |
| reasoning | neutralize part | 视图里保留 reasoning part 供计划（L336–370），折叠后 reasoning 不再回传 | 次要（D 线 noreason 消融：无效应） |
| temporal marker | 原位 prepend 到 user 文本 | 插入型 op 并进 `start` 节点（coordinator L24–27） | 等价 |
| historian | m[0] user 文本 + 删除被覆盖段 | 一个 user/message replace 覆盖已摘要的区间 | **形态等价**（DSH 自带的 `dsh-compaction-basic` 也是 user/message replace，见 §2.4） |
| m0/m1 | 头部冻结 + 增量 | 知识基线消息（`__dshKnowledgeBaseline`）+ 摘要 replace | 近似；本方案不改 |
| token 计价 | 宿主每次重算 | replace 不带 `compaction/prune`，meter 的 O(1) fold 对 replace 记 0 delta（`dsh-token-meter` L254–270 注释） | **C3 根因**：压力偏高，historian 提前触发 |
| drop 落地时机 | ride | C 线 `drop-gate.ts` 复用 core 的 ride 判定 | 已对齐（C 线 8cc2c4220） |
| nudge / caveman / emergency | 有 | 部分阶段尚未接入（`transcript.ts` L26–28） | 本方案不涉及 |

---

## 2. DSH 侧可用的扩展点（rc.5 为主，兼顾 alpha.3 / rc.1）

### 2.1 `dsh-session`：surface 规则

* surface 是一组按模型可见顺序排列的事件 seq。只有 5 种事件类型能进入 surface：`system/message`、`developer/message`、
  `user/message`、`assistant/message`、`tool/result`（`SURFACE_EVENT_TYPES`，rc.5 L156–162）。模型请求的消息就是
  `Session.deriveMessages()`（L1650–1690），它按 surface 节点逐个派生，并应用已登记的 message projection。
* replace 的通用规则（`planSurfaceEvent` L425–458）：`surfaceOp:{op:"replace",startSeq,endSeq}` 用一个新节点替换
  [start..end] 这段**连续**的当前节点。`sourceEventSeqs` 必须包含每一个被遮蔽的节点（`assertSourceEventReferences` L314–332）。
* **`assistant/message` 不能带 `sourceEventSeqs`**（L316），所以 **assistant 不能作为 replace 的产物**：
  插件没法插入或替换出 assistant 节点。
* **`tool/result` 作为 replace 时**（`assertToolResultRewrite` L394–411）：只能遮蔽**恰好一个**节点，被遮蔽节点必须是
  `tool/result`，而且除 `message.content` 以外的数据必须深度相等（callId、isError、turn、step 都不能变）。
  结论：**插件可以原位改写单个工具结果的内容，角色和配对保持不变。**
* `user/message` 作为 replace：除来源覆盖和 system 头部保护（L412–423）外没有别的限制，可以单节点原位改写。
* surface 节点 0 是 system 时只能由 system 替换。
* 证据：静态 + 已复现（§5 R1–R5）。

### 2.2 `dsh-session`：message projection（插件自定义的原位改写）

* `SessionStore.registerMessageProjection(projection)`（rc.5 L1729；d.ts `types/index.d.ts` L383–391）：
  插件为自己的事件类型注册一个纯函数 `project(event, ctx) → Map<seq, Message>`。该事件进入日志时
  （`planSurfaceEvent` L429–439 → `applySurfacePlan` L470），对应 seq 的消息会被原位换成新的 Message，
  **节点成员不变**，`contentGeneration += 1`，`deriveMessages` 就会重建。
* 能做到 OpenCode 的全部原位改写，**包括 assistant 文本**；契约要求「保持消息身份」，但运行时不校验 role。
* 风险：
  * 必须在 SessionStore 上注册（`ctx.sessions`）；`Session.create/fromRestore` 只会拿到注册时已有的 projection（L1810、L1829）。
  * 插件卸载后，**用过它的 live session** 不只是拒绝派生，**连下一次普通 append 都会抛错**
    （`_assertProjections` L583–584 在 `validateNext` 里执行：「restore the session with its owning plugin」，spike R6 已复现）。
    也就是说，会话进行中禁用或热重载插件，会让 agent loop 卡死。
    重新 restore 时，如果该事件是 ignorable plugin record，找不到 projection 就被忽略，内容退回原文（L301、L429–440）。
  * 持久化的事件类型：`appendPluginRecord`（L1272–1297）产生 `plugin:*` ignorable 记录，但注释说明只有 DSH 仓库内
    `packages/experimental/` 可以调用（仓库自检门）。用 `session.append` 写自定义的非 ignorable 类型，在
    session-log 写入和读取时的行为没有验证。
  * meter 不对 projection 计价（只认 `compaction/summary|prune` + replace），压力会漂移。
* 证据：静态 + spike 已复现（§5 R6）。

### 2.3 `dsh-agent`：loop 事件

* `agent/pre-step`（waterfall，d.ts `runtime-types.d.ts` L300–310）：可以拒绝这一步，或替换**本步进入的 inbox 消息**
  （只能是 UserMessage）。适配层现在就在这里跑 context plane。**它不能改历史消息**，但在这里 append surface 事件是合法的
  （适配层现有的 replace 就是这么做的，而且请求会读到）。
* `agent/request`（waterfall，L312–330）：只能换 `LlmCallConfig`；注释写明「this waterfall cannot mutate messages」。
* 证据：静态（d.ts 注释）+ 现有适配层在 pre-step append replace、请求生效（已复现，第 10–36 轮 e2e / bench）。

### 2.4 `dsh-compaction` / `dsh-compaction-basic` / `dsh-compaction-tool-result-pruner`

* `compaction/prune`（`dsh-compaction` `types.d.ts` L84–99）：影子计价事件，带 `shadowedRange`、`shadowedSeqs`、
  `shadowedTokenCount`，**必须紧挨在 replace 之前同步追加**。
* `dsh-compaction-basic` 发布摘要的形态（rc.5 L634–660）：`compaction/summary` 加上一个 **user/message replace** 覆盖
  [start..end]。这和 MC historian 的形态一样。
* 官方 pruner（rc.1 `dsh-compaction-tool-result-pruner/lib/index.js` L130–190，rc.5 未随 MC 安装）：对每个超长工具结果做
  `compaction/prune` + `tool/result` replace（`surfaceOp` 单节点，`sourceEventSeqs:[seq]`，数据只换 `message`）。
  **这就是方案 N 要用的同一套原语，DSH 自己的插件在用。**
* 证据：静态。

### 2.5 `dsh-token-meter`

* 压力用 O(1) fold（rc.5 L240–300，`foldSurfaceProjection`）：append 加上新节点的价；replace 消耗紧挨着的
  `compaction/summary|prune` 声明的影子价；**没有影子价的 replace 记 0 delta**，「possible drift」。
* 适配层所有 replace 都不带影子价，所以压力只增不减，第 31 轮 C3 的根因就在这里。方案 N 每次 replace 前都追加
  `compaction/prune`，`shadowedTokenCount` 用 `ctx.tokenMeter.estimateMessage(original)` 计算（与 pruner 相同）。
* 证据：静态。

### 2.6 `dsh-llm`：provider 层

* `llm/stream`（waterfall，`dsh-llm` d.ts `types/index.d.ts` L33–45）：loop 构造的请求是 **deep-frozen**，注释写明
  「its content is a pure function of the session log … listeners read it, never rewrite it」。listener 可以不调 `next()`
  而自己产出 chunk，但请求内容就和日志对不上了，meter、回放、fork 也会跟着不一致。
* `registerAdapter(providers, adapter)`（L262）：理论上可以包一层 provider adapter，在序列化前改消息，但这样会占用
  provider 路由，和用户配置的 provider 冲突，还要逐个 provider 适配。
* 证据：静态。**两条都不推荐**（违反 DSH 的可重放契约）。

### 2.7 cordis

* `cordis` 4.0.5 / 4.1.0：service override（`ctx.provide` / 同名 Service 后注册）在技术上可以替换 `sessions` 或 `llm` 服务，
  但这些都是 DSH 核心服务，替换后等于 fork DSH，升级时必坏。**不推荐**，没有深入。

### 2.8 多版本对比

`assertToolResultRewrite`、`assertSourceEventReferences`、`planSurfaceEvent` 三个函数在 rc.5、alpha.3、rc.1 的
`dsh-session/lib/index.js` 中 md5 相同（`b37a144e…`、`971418fe…`、`3d36ac21…`）。三个版本都有 `registerMessageProjection`；
三个版本的 token-meter 都认 `compaction/prune`。DSH master（`fcc0ad4621`）**未核对**，实施前应在 `dsh-ref-eval.yml` 跑道上加 RED 测试确认。

---

## 3. 候选方案对比

| | **N：逐节点原生改写（推荐）** | **P：message projection** | **A′：只在 ride 时折叠（D 线）** | **A：当前轮不折叠（D 线）** | **X：llm/stream 或 adapter 拦截** |
|---|---|---|---|---|---|
| 做法 | 视图不再折叠。tool/result 用单节点 tool/result replace 加 §N§ 或改 `[dropped §N§]`；user 文本用单节点 user/message replace；每个 replace 前追加 `compaction/prune`；historian 仍是区间 user/message replace | 注册 projection；每个 pass 把差异写成一个插件事件，原位改写任意消息 | 仍然折叠，但只在 reclaim ride 上折叠 | 当前轮保持原生，下一条用户消息到来时再折叠 | 发请求前在 provider 层改消息 |
| 角色保留 | 是（assistant / tool 原生） | 是 | 否（ride 之间原生，ride 后又变成 user） | 历史轮否，当前轮是 | 是 |
| 与 OpenCode 等价程度 | 高。偏差：assistant 文本不加 §N§、不原位 drop；`full` drop 改为 skeleton | 最高 | 低 | 中 | 高，但违反契约 |
| 用到的 DSH API | `session.append` 的 tool/result、user/message replace，`compaction/prune`（全是已发布 schema，官方 pruner 在用） | `registerMessageProjection`（公开），事件类型持久化路径（未验证或仅限 experimental） | 现有 | 现有 | 违反 `llm/stream` 契约 |
| 升级风险 | 低。依赖的校验规则就是官方 pruner 依赖的规则 | 中到高。插件卸载或热重载后，live session 连普通 append 都会被拒（R6）；`appendPluginRecord` 受仓库自检限制 | 低 | 低 | 高 |
| 改动面 | `transcript.ts` 视图（不折叠，改为与 pi 视图相同的 tool-result 消息形态）、op 几何（每条脏消息一个 op，按角色选事件类型）、`coordinator`（按角色 append，加 prune）、outbox 记录 op kind、`compat/dsh-0.1/session.ts` 加两个 helper。中等 | 视图同 N，加 projection 注册和事件 | 小 | 小到中 | — |
| C 线 drop 门控 | 不变（仍只在 ride 落地）；一次 ride 落多个单节点 replace，缓存只从最早被改的节点开始失效 | 不变 | 不变 | 不变 | — |
| historian | 不变（区间 user/message replace；区间不能拆开 tool 配对，复用现有逻辑） | 不变 | 不变 | 不变 | — |
| pressure 截断 | 改成 tool/result replace（截断只改 content，符合校验） | projection | 不变 | 不变 | — |
| ctx_reduce 标记 | §N§ 在 tool 内容和 user 文本上，与 OpenCode 相同。assistant 文本没有 tag，模型看不到也就不会去 reduce | 全部 | 在折叠文本里 | 历史轮在折叠文本里 | — |
| meter / C3 | **修复**（每个 replace 都有影子价） | 不修（projection 不计价） | 不修 | 不修 | — |
| 每个工具结果多几个事件 | +2（prune + replace，加 tag 时） | +1 | — | — | — |
| 旧会话 | 已经折叠的段保持折叠（assistant 节点无法再造出来），新节点按原生处理；historian 会逐步覆盖旧段 | 同 N | — | — | — |
| soak / e2e 影响 | R14（按 shadowedSeqs 判折叠）、C3、I1/I2（折叠格式模仿，限制 21 会**消失**）、R10 要重新确认；场景的断言多数与形态无关 | 同 N | 小 | 小 | — |
| 多版本 | rc.5 / alpha.3 / rc.1 字节相同（§2.8） | 同 | — | — | — |

为什么不选 P：N 已经覆盖了 bench 里所有重要的改写（工具结果占绝大多数 token），P 多出来的只有 assistant 文本这一块，
代价是插件常驻要求、未验证的持久化路径，以及 meter 漂移。可以把 P 留作以后给 assistant 文本用的增量（§4 第 7 步，可选）。

为什么不选 A / A′：仍然把历史压平成 user 角色。D 线的 foldplain 消融说明，**只要角色被压平**推理就会涨（483/432），
A′ 也只是把这件事推迟到 ride 之后。

---

## 4. 推荐方案 N：实施步骤

1. **RED 测试**（新文件 `agent/native-roles.test.ts`，真实 Session）：
   * R-a：一个工具轮 + 一个进行中的工具轮，pre-step 之后 `deriveMessages()` 的角色序列与没有插件时相同
     （user, assistant[tool-call], tool, assistant, user, assistant[tool-call], tool），callId 一一对应；
   * R-b：给新结果打 tag 前后，所有更早消息的序列化字节相同；
   * R-c：在 ride 上 drop 一个旧结果，只有那一条 tool 消息变成 `[dropped §N§]`，它之前的前缀字节相同，后面的消息也不变；
   * R-d：每个 replace 之前都紧挨一个 `compaction/prune`，`shadowedSeqs` 等于被遮蔽节点；
   * R-e：现有已折叠的会话可以继续工作（混合形态）；
   * R-f：restore（从事件重放）后 surface 与 live 相同。
2. `compat/dsh-0.1/session.ts`：新增 `replaceToolResultContent(session, seq, content, shadowPrice)` 和
   `replaceUserMessage(session, seq, message, shadowPrice)`，都先 append `compaction/prune`。
3. `transcript.ts`：去掉 tool-call 挂起和折叠（`pendingAssistant` / `flushSynthetic` 路径），tool/result 映射成独立的
   tool-result 消息（core 的 tagTranscript 已支持 pi 的这种形态）。每条消息记录自己唯一的节点 span。
   op 改为「每条脏消息一个 op」，带上 `role`。assistant 消息上的改写一律丢弃（不加 tag 前缀），并记一行日志计数。
4. `coordinator.ts`：按 op.role 选择 append 的事件类型，CAS 和 outbox 不变（outbox 增加 `kind` 列，或在 payload 里带上）。
5. drop 模式：DSH 无法结构性删除调用，通知 core 走「host 不能结构性移除」分支（`applyNewToolDrop` 注释 L94–98），
   统一为 skeleton。需要确认适配层 TagTarget 的 `drop()` 怎么报告，必要时在适配层的 target 实现里强制 skeleton。
6. `pressure-truncation.ts`：截断工具结果时改走 `replaceToolResultContent`。
7. （可选、后续）assistant 文本：用 projection 实现原位 §N§ / drop，前提是先验证插件卸载后的降级路径。
8. 开关：新增配置 `dsh.native_roles`（默认关），先在 bench 上对比，确认后再改默认值。旧会话不迁移。

### 验证计划

* 单文件测试：上面的 R-a…R-f；`transcript*.test.ts`、`coordinator.test.ts`、`drop-gate*.test.ts`、`pressure-truncation*.test.ts`、
  `fold-format.test.ts`（预期要改断言：折叠格式不再出现，需要用户批准）。
* push CI：dsh-plugin 全量、contracts-dsh（alpha.3 / rc.1）。
* cache-bench（slot `cache-7` 起，用户批准后）：插件组 3 次，`native_roles=on`。预期：
  * 推理 ≈ 17 token/步（D 线 foldtail 64/17；基线 55/7）。上限按 ≤ 60 判；
  * 第一次压缩前命中率 ≥ C 线的 94 %（drop 仍只在 ride 落地；新节点打 tag 发生在首次发送前，不改前缀）；
  * 每步成本比 C 线低约 29 %（≈ −0.37 m$/步）；
  * 前缀分叉只出现在 ride 步。
* e2e（用户批准后）：rc.5 一次、alpha.3 一次；重点看 C3（meter 修复后应转为稳定 PASS）、R14、I1/I2、R10。
* soak：用户决定是否需要。

---

## 5. spike 结果（已复现，rc.5）

位置：本地分支 `r36e-spike`（commit `01c690952`，**未 push**），基于 `87434df01`：

* `packages/dsh-plugin/src/agent/native-rewrite.spike.ts`：原型，约 130 行。提供 `replaceToolResultContent`、
  `replaceUserMessageText`（都先追加 `compaction/prune`）、`nativeTagPass`（给 tool/result 和 user 文本加 §N§）、
  `nativeDropToolResult`（改成 `[dropped §N§]`），以及一个只用于比较的 chat 序列化 `toChatWire`
  （本地没有安装 DSH 的 provider adapter，所以没有拿真实请求体比，见下文）。
* `packages/dsh-plugin/src/agent/native-roles.spike.test.ts`：单文件测试，**8/8 通过**
  （`bun test src/agent/native-roles.spike.test.ts`，6.0 s）。Session 用真实的 `@deepseek-ai/dsh-session` 0.2.1-rc.5，
  事件构造复用 `crash-recovery.helpers.ts` 的 `toolTurn` / `tailToolCall`。

| # | 测试 | 结果 |
|---|---|---|
| R1 | 一个已完成的工具轮 + 一个进行中的工具轮，做 tag pass | 角色序列保持 `user, assistant+calls, tool, assistant, user, assistant+calls, tool`；`tool_call_id` 仍是 call-1 / call-2；tool 内容变成 `§N§ BODY…`；surface 节点数仍为 7 |
| R2 | 请求 k 之后，模型又发起一个工具轮，pre-step k+1 只给新节点打 tag | 请求 k 的全部消息**字节相同**，只在尾部多出 3 条 |
| R3 | 对已打 tag 的旧结果做 drop | **只有**那条 tool 消息变成 `{"role":"tool","tool_call_id":"call-1","content":"[dropped §N§]"}`，其余 6 条字节相同，角色序列不变 |
| R4 | 每个 replace 的前一个事件 | 都是 `compaction/prune`，`shadowedRange` 和 `shadowedSeqs` 与 replace 一致，`shadowedTokenCount > 0` |
| R4b | 校验器的边界 | tool/result replace 改 `isError` 时被拒（「may change only content」）；覆盖 2 个节点时被拒（「exactly one current node」）；assistant/message 作为 replace 被拒（「cannot carry sourceEventSeqs」） |
| R5 | 从持久事件日志重放（restore / fork） | 重放后的模型输入与 live 字节相同 |
| R6 | 方案 P：message projection | 可以原位改写 **assistant** 文本，角色不变；不带 projection 重放时，自定义事件被忽略，内容退回原文（不报错）；**移除 projection 后，live session 下一次普通 append 就抛错** |
| R7 | **真实 TokenMeter** 的 `contextBreakdown` fold（与 `token-meter-projection.contract.test.ts` 同样的捕获方式） | 带 prune 的原生 drop：messageTokens 3046 → **50**；不带影子价的 replace：**3046 → 3046**（0 delta，被替换的大内容仍按原价计入）。C3 的 meter 漂移已复现，方案 N 的写法能修掉 |

没有做的：

* **bench 代理录请求体**：需要 dispatch cache-bench，而 D 线的 `foldtail` 消融（当前轮保持原生 assistant/tool，
  64 / 17 token/步）已经在真实 DeepSeek 请求上测过「原生角色」的效果，再跑一次不能改变结论，按约束不 dispatch。
  实施后的验证 bench 见 §4。
* **alpha.3 / rc.1 上运行 spike**：三个版本的相关函数 md5 相同（§2.8），只做了静态核对。
* **core 管线接到原生视图上**：没有改 `transcript.ts`。core 的 `tagTranscript` 本来就支持 pi 那种「工具结果是独立消息」
  的形态（`pi-plugin/src/transcript-pi.ts`），这一点是静态推断；实施时由 §4 的 R-a…R-f 验证。

## 6. 需要用户决定的事项

1. 是否按方案 N 实施（只改适配层，先放在 `dsh.native_roles` 开关后面，默认关）。
2. assistant 文本不再加 §N§、不再原位 drop（与 OpenCode 的唯一保留偏差）是否可以接受；还是要求后续用方案 P 补上
   （代价：插件热重载或禁用时，live session 会卡死）。
3. `full` drop 统一改为 skeleton（保留调用和真实参数，结果改成占位符）是否可以接受。
4. 实施后，`fold-format.test.ts` 等测试里「折叠格式」相关断言需要改写（行为变了，不是放宽），是否批准。
5. 验证用的 bench（slot `cache-7` 起）、e2e 和 soak 是否批准运行。
6. C3：方案 N 顺带修了 meter 漂移，与第 34 轮「C3 等上游修复」的决定不同，是否同意由我们这边修。

## 7. pi 参考（第 36 轮 F 线，2026-11-06）

详见 [`pi-plugin-comparison.md`](./pi-plugin-comparison.md)。对方案 N 的修订：

1. **写模型照 `pi-plugin/src/transcript-pi.ts`**。pi 的 core 视图同样把 toolResult 并进后面的（合成）user，但每个 part 回指一条源消息，
   `commit()` 按源消息写回，所以角色不变。DSH 现在照的是 pi 的只读模型 `read-session-pi.ts`，还多折了 assistant tool-call 节点，
   并按视图消息合并成一个跨节点 replace。§4 第 3 步改为：`walkDshLog` 只去掉 `pendingAssistant` 折叠；`RecordingPart` 记住源节点 seq；
   op 按源 seq 分组，事件类型由源节点角色决定；assistant 节点上的 part 在 setter 层返回 false。
2. **删掉 §4 第 5 步**。`RecordingPart` 没有 `remove`，core `cannotRemove()` 为真，`planNewToolDrop` 自动选 `skeleton_real`
   （spike F2/F3 已复现）。换成一条约束：native 模式下 tool_use part 的 `setToolInput` / `setText` / `replaceWithSentinel`
   返回 false（F4 已复现：此时旧 full 重放只改结果节点）。
3. **assistant 文本仍会分配 tag**（F4 已复现），字节上没有 §N§。建议 native 模式下不分配（把 kind 报成非 taggable），待用户决定。
4. **tag scheme 标志**：去掉 assistant 折叠会改变曾吸收 assistant 文本的 user 消息的文本 tag 键（`pendingFoldTextCount`），
   参照 pi `pi_stable_id_scheme`（PARITY §8）在 session_meta 记标志、会话创建时冻结，只对新会话生效；可与 §4 第 8 步的开关合并。
5. core 不需要 dsh 分支：pi 的特殊需求全部通过 `Transcript` 的可选能力（`remove?`、`canRemove?`、`requiresToolArcSkeleton?` 等）表达。
6. 不借鉴：LKG / served-array ledger（DSH surface 本身持久）、splice 删除、Responses 原生信封逻辑。

改动量（静态估计）：core 0；适配层比原估计少一到两成，主要省在不用另写 drop 模式路径、不用重新设计 core 面对的视图形态。

spike：本地分支 `r36e-spike` commit `f5763b6c1`（未 push），`packages/dsh-plugin/src/agent/pi-mapping.spike.test.ts` 5/5。

新增待决事项（接 §6）：

7. 是否按本节修订方案 N。
8. assistant 文本 tag：不分配（推荐）还是分配但保证 no-op。
9. tag scheme：只对新会话生效（推荐）还是一次性迁移旧会话。
