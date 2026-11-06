# pi-plugin 兼容做法调研：给 DSH 方案 N 的参考

第 36 轮 F 线，2026-11-06。用户 18:42 CST：「可以再看看pi那边的兼容」。

本文只是**调研**。`packages/plugin`（core）和 `packages/pi-plugin` 只读，产品代码没有改动。
小验证放在本地分支 `r36e-spike`（commit `f5763b6c1`，**未 push**）的
`packages/dsh-plugin/src/agent/pi-mapping.spike.test.ts`，5/5 通过（`bun test src/agent/pi-mapping.spike.test.ts`，3.1 s）。

证据等级：**已复现** = 上面这个单测跑过；**静态** = 读源码得出，没有运行。
行号以 `31164b5f3`（origin/dsh-integration）为准；pi-plugin 版本 `0.49.35`。

> **一句话结论**：pi-plugin 能保留角色，靠的不是视图，而是**提交几何**。它的 core 视图同样把 toolResult
> 折进后面的（合成）user 消息，但每个 part 都带着指回**一条源消息**的指针，`commit()` 按源消息逐条写回，
> 所以宿主看到的 assistant / toolResult 角色不变。DSH 适配层照搬的是 pi 的**读模型**
> （`read-session-pi.ts`，给 historian 用、从不写回），还额外把 assistant 的 tool-call 节点也折了进去，
> 然后按**视图消息**合并成一个 replace 写回。方案 N 应该直接照 pi 的**写模型**（`transcript-pi.ts`）来做：
> 视图可以基本保留，改的是「part → 源节点 seq」的指针和「按源节点分组出 op」。
> 另外，core 已经有一套按能力协商的接口（part 上有没有 `remove` / `canRemove`），DSH 不实现 `remove`，
> core 就会自动选 `skeleton_real`。方案 N §4 第 5 步「通知 core 走 skeleton 分支」因此不需要做（已复现）。

---

## 1. pi 给插件的钩子

| 钩子 | 位置 | 能做什么 | 证据 |
|---|---|---|---|
| `pi.on("context", (event) => { messages })` | 注册：`pi-context-refusal.ts` L789（外面包了 budget/拒绝 fence）；管线：`context-handler.ts` `registerPiContextHandler` L4267、`runPipeline` L8859，返回 `{ messages: outputMessages }` L7034 | 每次调 LLM 前拿到完整 `AgentMessage[]`，**返回一个新数组**作为本次请求。结果**不写回** JSONL，所以每个 pass 都从原始数组出发、重放持久化的决定（PARITY §5）。可以改任意角色的任意内容，也可以删消息（splice）或插消息 | 静态 |
| `pi.on("tool_result")` | `index.ts` L2853 | 工具结果**落盘前**改它的 content。Channel 1 nudge 就是在这里往 `toolResult.content[]` 追加一个 TextContent，随 JSONL 持久化，「免费 sticky」（PARITY §9） | 静态 |
| `pi.on("session_before_compact")` | `index.ts` L2885 | 返回 `{cancel:true}` 取消 Pi 原生压缩，由 MC 自己管边界（PARITY §4） | 静态 |
| `pi.sendMessage({customType, display:false}, {deliverAs:"steer", triggerTurn:true})` | PARITY §9 | Channel 2 隐藏 nudge：自定义消息，`convertToLlm` 交给模型，TUI 不显示 | 静态 |
| `appendCompaction()` | PARITY §4 | MC 在需要物化的 pass 上把压缩标记写进 Pi 的 JSONL | 静态 |
| `session_start / agent_start / before_agent_start / agent_end / message_end / tool_execution_* / session_tree / session_shutdown / session_before_switch` | `index.ts` L1994–3232；`context-handler.ts` L4306 | 生命周期、usage 压力（`message_end`）、分支切换重建索引 | 静态 |

**和 DSH 的根本区别**：pi 的 `context` 钩子是「临时变换」，和 OpenCode 的 `messages.transform` 同一类；
DSH 的 surface 是**持久事件日志**，改写只能 append replace 事件（方案 N §2）。所以 pi 的「每 pass 重放」在 DSH 上
变成「只追加一次改写，由 outbox/CAS 保证幂等」。这条偏差 DSH 已经在处理，不是新问题。

## 2. MC 在 pi 上的做法

### 2.1 适配层（shim）：`transcript-pi.ts`

* `createPiTranscript(source, sessionId, entryIds, options)` L171：实现 core 的 `Transcript` 接口
  （`packages/plugin/src/shared/transcript.ts`）。core 管线（tagTranscript、apply-operations、heuristic cleanup、
  caveman……）只认这个接口，不碰 pi 的类型。
* **视图归一化**（文件头 L15–37，`buildTranscriptView` L356）：
  * assistant 消息 → 一条视图消息（text / thinking / toolCall part）；
  * 连续的 `toolResult` → 作为 `tool_result` part **并进紧跟的 user 消息**；后面没有 user 时，生成合成 user，
    id 为 `synth-user-<首个 toolResult entryId>`（`createSyntheticToolResultUserMessage` L519）。
  * 这是它**唯一**的形态归一化。
* **写回**（文件头 L39–50，`commit()` L276–345）：每个 part 代理带着回指针（源数组下标 + content 下标）；
  setter 只改 `working` 副本并把**源消息下标**标脏；`commit()` 只重建脏的源消息，写回 `source[idx]`。
  并进 user 视图的 toolResult part 写回的是**原来那条 `toolResult` 消息**，角色不变。
* 结论：视图里折叠，提交时拆开，按源消息逐条写回。

### 2.2 打 tag、drop

* tag：core `tagTranscript`（`shared/tag-transcript.ts` L344）在视图上跑。pi 的 assistant text part 的
  `setText` 正常写（`createPiAssistantPart` L733–777），所以 **pi 会给 assistant 文本加 §N§**（spike F1b 已复现）。
* tool drop（core `apply-operations.ts` `applyNewToolDrop` L100 → `planNewToolDrop` L116–160）：
  * part 上有 `remove()`，`canRemove()` 不为 false → `full`：调用和结果一起删（`markToolRemoval`，`commit()` 里过滤，
    `finalizeToolRemovals()` 再把空消息 splice 掉）。spike F1a 已复现。
  * `canRemove()` 为 false → core 的 `cannotRemove()`（`tag-transcript.ts` L1306）为真 → `skeleton_real`：调用保留**真实参数**，
    只把结果改成 `[dropped §N§]`。pi 什么时候返回 false：assistant 带 OpenAI Responses 原生信封
    （`providerPayload.type="openaiResponsesHistory"`），且信封里找不到这个 call（`native-replay-pi.ts`
    `canRemoveNativeToolCall` L330）。spike F1b 已复现。
  * `requiresToolArcSkeleton`（视图消息上的可选字段，`transcript.ts` L207）：旁边有原生 reasoning 时强制 skeleton。
* 文本 drop：`replaceWithSentinel` 原位改成 `[dropped §N§]`（L906）。toolCall 的 sentinel 只改 `arguments`，
  保留 id/name/thoughtSignature，避免配对报错（L885–905 注释）。

### 2.3 historian / compartment、m0/m1

* `inject-compartments-pi.ts`：复用 core 的 `prepareCompartmentInjection`，渲染后写回 pi 形态。
  m0、m1 是**两条合成 user 消息**，插在开头的 system 条目之后（L2650–2685、`injectM0M1Pi` L2771）；
  已被覆盖的原始消息从头部 splice 掉（`trimPiMessagesToBoundary` L872，每个注入 pass 都执行，与 JSONL 压缩标记无关）。
* 宿主压缩：取消 Pi 原生压缩，自己写 `appendCompaction` 标记，下一个物化 pass 消费（PARITY §4）。
* m1 重算门控：`executedWorkThisPass || rematerialized`（PARITY 第二个 §10；`context-handler.ts` L10343、L11862）。
* DSH 现状（`knowledge-gate.ts` L396）同样是 m0/m1 两条独立合成 user，**已经对齐**。

### 2.4 reasoning、nudge、cache 门控

* reasoning（PARITY 第一个 §10，`reasoning-replay-pi.ts`）：旧 thinking 置空并去掉 `thinkingSignature`，
  靠 pi 各家序列化器丢掉空 thinking；redacted 块原样保留；最新一条 assistant 保持原生。
* nudge（PARITY §9）：决策、文案全在 core；Channel 1 在 `tool_result` 钩子里写进工具结果内容（持久化）；
  Channel 2 用 `sendMessage(..., steer)`。note-nudge 和 auto-search 提示追加到 user 消息。
* cache 门控：与 OpenCode 共用 core 的 scheduler、`isCacheBusting`、reclaim ride 判定；placeholder 发现只在
  history-refresh pass 上做，因为 pi 是 splice 删除，同一 pass 内删会塌掉刚 drop 的轮（PARITY §2）。
* 宿主没有持久化变换结果，所以 pi 另外有 **LKG**（`pi-lkg.ts`，core `lkg-*`，PARITY §26：SQLite 忙时重放上一次
  成功的请求）和 served-array ledger（`served-array-ledger.ts`，诊断用）。

### 2.5 和 core 的接口

* 复用：`tagTranscript`、`applyPendingOperations` / `applyFlushedStatuses` / `applyNewToolDrop`、heuristic cleanup、
  `prepareCompartmentInjection` 和渲染、ctx-reduce-nudge 的决策和文案、scheduler / ride 信号、storage 全部。
* **core 里没有按 `harness === "pi"` 分支的变换管线**。pi 特有的需要都做成了 `Transcript` 接口上的**可选能力**：
  `remove?` / `canRemove?`（L181、L184）、`requiresToolArcSkeleton?`、`rawByteSize?`、`imageTokens?`、`hasUserAnswer?`。
  core 按「有没有这个能力」决定走哪条路。
* `getHarness()` 分支只出现在外围：`compaction-marker-manager.ts` L471/L625（只有 opencode 走）、
  `lkg-persist.ts` L364（rust host）、`window-geometry.ts` L216（pi 的窗口规则）、
  `prompt-surface-runtime.ts` L121–123（dsh 已经和 opencode2 同组）、`model-resolution.ts` L36（omp 回落到 pi 配置）。
  另有 pi 命名的 core 模块（`pi-content-decisions.ts`、storage 的 `adoptPiFallback*`；DSH 的 `transcript.ts` 已在用
  `adoptPiFallbackToolOwnerTag`）。
* `HarnessId` 已含 `"dsh"`（`shared/harness.ts` L26，我们在 `8e40ba126` 加的，类型层面）。
* 结论：**DSH 可以完全沿用同一套接口**——实现 `Transcript`，通过可选能力表达「做不到什么」，不需要 core 加 dsh 分支。

### 2.6 与 OpenCode 的偏差（PARITY.md 的「有意偏差」）

和本题相关的几条：placeholder 删除而不是放 sentinel（§2）；pi 自己接管压缩（§4）；每 pass 从 JSONL 重建（§5）；
`synth-user-*` 折叠和 `pi_stable_id_scheme` 迁移（§8：v25 一次性强制 execute，把 tag 键从 `pi-msg-<index>` 换成真实
entry id）；transform 决定晚一个 prompt 绑定（§8a）；nudge 投递方式不同（§9）；reasoning 置空而不是 `[cleared]`（§10）；
LKG 共享（§26）；OMP 的 provider 签名导致整段 system 无法字节对齐（§35）。

**assistant 文本的 §N§ / drop**：pi 一般都能改（宿主数组是临时的）。唯一的「不能改」先例是 OpenAI Responses 原生信封：
`rewriteNativeAssistantTexts`（`native-replay-pi.ts` L149–235）在 `commit()` 里把 assistant 文本的修改同步进
`providerPayload.items`，**如果差别只是开头的 `§N§ ` 标签就跳过**（L175–180），原生字节不变，实际发出去的
Responses 请求里 assistant 文本**没有 §N§**，DB 里的 tag 照常存在；找不到唯一的 id/phase 匹配时也跳过并记日志。
另一类先例是工具调用：信封里匹配不到就 `canRemove=false`，退到 skeleton（§2.2）。静态（label 跳过）+ 已复现（skeleton）。

### 2.7 测试、e2e、已知限制

* 单测：`packages/pi-plugin/src` 下约 320 个 `*.test.ts`（含 `transcript-pi.test.ts`、`native-replay-pi.test.ts`、
  `context-handler.test.ts` 1 万行）。
* e2e：`packages/e2e-tests/tests/pi-*.test.ts` 等 14 个，跑 `pi --mode rpc` 子进程 + 本地 mock Anthropic/Responses
  （`e2e-tests/README.md` L3–8、L106–129）。`HOST-SCENARIO-MATRIX.md`（2026-09-19 复核）：Pi 在 tagging、drops、
  cache invariants/stability、historian、long-running 等都是 pass；declared-divergence 有 deferred compaction marker、
  dropped-input guard、overflow recovery、session isolation、subagent、thinking-block safety、notice-loop。
* 已知限制（PARITY）：决定晚一个 prompt 绑定（§8a）；protected tail 的 true-raw 只对 text 和 tool I/O 对齐（维护段 §8）；
  compartment 的日期属性要求 OpenCode 时间戳（维护段 §9）；OMP 签名使整段 system 无法字节对齐（§35）。
  CHANGELOG 没有逐条核对。

## 3. 消息模型对比

| | OpenCode | pi | DSH（rc.5） |
|---|---|---|---|
| 宿主消息 | `{info, parts}`；工具调用和结果在**同一个** assistant tool part（`state.input/output`），provider 层再拆 | `UserMessage` / `AssistantMessage`（text、thinking、toolCall）/ `ToolResultMessage`（role `"toolResult"`，`toolCallId`） | surface 节点：`system/message`、`developer/message`、`user/message`、`assistant/message`（content 里有 `tool-call` 块）、`tool/result`（source.callId，content 为 text 块） |
| 变换结果 | 临时，不写回 | 临时，返回新数组 | **持久**，append replace 事件 |
| 能否改 assistant | 能 | 能（Responses 信封有限制） | **不能**（assistant 不能作为 replace 产物；projection 可以但有卸载风险，见 native-roles-plan §2.2） |
| 能否删调用 | 能 | 能（信封匹配不上时不能） | **不能** |
| 改单个工具结果 | 能 | 能 | 能：单节点 `tool/result` replace，只改 content |
| 改 user 文本 | 能 | 能 | 能：单节点 `user/message` replace |
| 稳定 id | `msg_*`、`prt_*` | `SessionEntry.id`（v25 起） | event seq |
| core 视图里的工具结果 | 下一条 user 的 tool part | 下一条 user / `synth-user-*` 的 tool_result part（回指源 toolResult） | 当前：`synth-user-*` 里，**连同 assistant tool-call 一起折叠**（`transcript.ts` `walkDshLog` L688–914 的 `pendingAssistant`） |
| 提交粒度 | part 原地 | **每条源消息** | 当前：**每条视图消息**合并成一个跨多个节点的 user/message replace（`transcript.ts` L13–24、`MutationOp` L144） |

## 4. pi-plugin vs OpenCode vs DSH（当前 / 方案 N）

| 环节 | OpenCode | pi | DSH 当前 | DSH 方案 N（含本文修订） |
|---|---|---|---|---|
| 工具结果角色 | 原生 | 原生（视图折叠，按源写回） | **折叠成 user** | 原生（同 pi：视图折叠，按源节点写回） |
| §N§ on 工具结果 | 有 | 有 | 在折叠文本里 | 有（tool/result replace） |
| §N§ on user 文本 | 有 | 有 | 有（随折叠整段替换） | 有（user/message replace） |
| §N§ on assistant 文本 | 有 | 有（Responses 信封只差标签时不写） | 在折叠文本里 | **无**；tag 仍会分配（F4），需决定是否改成不分配 |
| 新 tool drop | full / skeleton_real / skeleton_stripped | full；信封不匹配 → skeleton_real | 折叠文本里改字 | **skeleton_real，由 core 自动选择**（part 无 `remove`，F2/F3 已复现） |
| 旧 full drop 重放 | 删除 | 删除 | 折叠文本 | `drop()` 的 sentinel 兜底；assistant part 只读 → 只改结果节点（F4 已复现） |
| 文本 drop | 原位 | 原位 | 折叠文本 | user 文本原位；assistant 文本不能 |
| historian | m0 user + 删覆盖段 | m0/m1 两条 user + splice | 区间 user/message replace + m0/m1 两条 user | 不变 |
| reasoning | `[cleared]` / 不清 | 置空 + 去签名 | 视图保留，折叠后不回传 | 不涉及（DeepSeek 无签名） |
| Channel 1 nudge | 写进 tool output | 写进 toolResult content（持久） | `agent.inject` | 可选：写进 tool/result 内容（见 §5.4，未验证） |
| 失败兜底 | LKG | LKG + served ledger | surface 持久本身就是兜底 | 不变 |
| meter | 宿主重算 | 宿主重算 | replace 无影子价（C3） | `compaction/prune` 影子价 |

## 5. 对方案 N 的修订建议

### 5.1 可以直接借鉴的（按收益排序）

1. **写模型照 `transcript-pi.ts`，不要照 `read-session-pi.ts`**。DSH `transcript.ts` 文件头写的是
   「Mirrors the Pi adapter's mapping semantics (`pi-plugin/read-session-pi.ts`)」：那是 historian 的只读模型，
   折叠无所谓，因为从不写回；而且它也**没有**把 assistant 折进去（`read-session-pi.ts` L26–37）。
   方案 N 的 §4 第 3 步可以改成：
   * `walkDshLog` 只去掉 `pendingAssistant` 折叠：assistant（含 tool-call）各自成一条视图消息；
     `tool/result` 节点继续按 pi 规则并进后面的 user 或 `synth-user-*`。core 看到的形态就是 pi 的形态，tagTranscript
     和 apply-operations 已经在 pi 上长期跑（F2/F3 用同样的形态在 core 上跑通）。
   * 每个 `RecordingPart` 记住自己的**源节点 seq**（pi 的回指针）；`deriveMutationPlan` 按源 seq 分组出 op，而不是按视图消息。
     op 的事件类型由源节点角色决定：tool → `tool/result` replace，user → `user/message` replace。
   * assistant 节点上的 part **在 setter 层就拒绝**（返回 false），而不是事后丢弃 op。core 把 false 当作「没改」，
     状态与字节就不会不一致。
2. **drop 模式不用通知 core**：DSH 的 `RecordingPart` 本来就没有 `remove`，core 的 `cannotRemove()` 为真，
   `planNewToolDrop` 自动选 `skeleton_real`（F2/F3 已复现：`{result:"truncated", mode:"skeleton_real"}`，只出 tool 节点的 op）。
   **方案 N §4 第 5 步可以删掉**，换成一条约束：native 模式下 tool_use part 的 `setToolInput` / `setText` /
   `replaceWithSentinel` 一律返回 false（否则 `truncate()`、edit-marker 和旧 `full` 重放会往参数里写标记，变成 assistant op）。
   F4 已复现：assistant part 只读时，旧 full 重放只改结果节点。
3. **能力协商而不是 harness 分支**：DSH 要表达的「不能改 assistant、不能删调用」全部用 `Transcript` 的可选能力表达，
   core 不需要 `harness === "dsh"` 分支，符合「不动 core」。
4. **tag 键迁移照 `pi_stable_id_scheme` 的先例**（PARITY §8）：去掉 assistant 折叠后，曾经吸收过 assistant 文本的
   user 消息，其文本 tag 键 `${viewId}:p${N}` 的 N 会变（`pendingFoldTextCount`，`transcript.ts` 约 L1731），
   已发出的 user 文本会拿到新的 §N§，触发一次前缀改写和 tag 漂移。建议：在 session_meta 记一个
   「native scheme」标志，**会话创建时冻结**，只对开关打开后新建的会话生效（方案 N 已写「旧会话不迁移」，这里把它变成可检查的标志）。
   工具 tag 按 callId 键，不受影响。（静态）

### 5.2 新发现的问题

* **assistant 文本仍然分配 tag**（F4 已复现：`a-11:p0`、`a-13:p0` 两行 message tag，字节上没有 §N§）。影响（静态推断）：
  tag 号被占用；token 记账和 heuristic / caveman 可能选中这些 tag，产生写不进去的 op，或者 tag 被标成 dropped 而字节没变，
  压力估算偏低。两种处理：
  * (a) native 模式下把 assistant text part 的 kind 报成非 taggable（例如 `structural`），不分配 tag；
  * (b) 保留分配，参照 pi 对 Responses 信封的做法（tag 存在、标签不上线），再加 RED 测试保证这些 tag 上的 drop / caveman 都是 no-op，
    且不会被计入「已回收」。
  我倾向 (a)，更简单；但要先确认 protected tail 和 tail-hygiene 的 T 值不依赖 assistant 文本 tag。

### 5.3 改动量估计（静态）

* core：0。
* 原方案 N §4 第 3 步（重写视图 + op 几何）缩小为：`walkDshLog` 去掉 `pendingAssistant` 分支（L688–914 内约十几处），
  `RecordingPart` 加 `seq` 和只读开关，`deriveMutationPlan` 的分组键从视图消息改为源 seq。core 面对的视图形态与 pi 相同，
  tagTranscript 和 apply-operations 无需适配。
* 第 5 步删除；第 2、4、6 步不变（helper、coordinator 按角色 append + prune、pressure truncation 走 tool/result replace）。
* 新增：tag scheme 标志（第 8 步的开关可以和它合并）、assistant text 的 (a)/(b) 处理。
* 粗略看，适配层改动比原估计少一到两成，主要省在「不用另写 drop 模式路径」和「不用重新设计视图形态」。没有实际写代码，数字只是量级。

### 5.4 可选，未验证

* Channel 1 nudge 改成 pi 的做法：写进工具结果自身的内容，而不是 `agent.inject` 另起一条消息。前提是 DSH 有工具结果落盘前的钩子，
  或者接受一次 tool/result replace。本轮没有查 DSH 的工具钩子。

### 5.5 不借鉴的

* LKG、served-array ledger：pi 需要它们是因为变换结果不持久；DSH 的 surface 本身就是持久的上一次结果。
* placeholder splice 删除、调用的结构删除：DSH 不能删节点。
* Responses 原生信封相关逻辑：DeepSeek 不涉及。

### 5.6 DSH 适配层里和 pi-plugin 重复的部分

* `commands.ts`、`tools.ts`、`nudge.ts`、`dreamer.ts`（facade）、`embed.ts`、`system-guidance.ts`、`knowledge-gate.ts`、
  `historian.ts` 文件头都写了「Mirrors / parity with Pi」。它们和 pi 一样是 core 之上的薄包装，**无法直接复用 pi-plugin**：
  pi-plugin 只发布 `dist`（`package.json` `files`），依赖 `@earendil-works/pi-coding-agent` 的 `ExtensionAPI` 运行时类型，
  不是库。能复用的层就是 core，DSH 已经在用。
* 真正「重造了而且造偏了」的只有 transcript 的写模型（§5.1 第 1 条）。

## 6. spike 结果（已复现，本地 `r36e-spike` `f5763b6c1`，未 push）

文件：`packages/dsh-plugin/src/agent/pi-mapping.spike.test.ts`（从源码 import pi-plugin 的 `createPiTranscript`，只读）。

| # | 测试 | 结果 |
|---|---|---|
| F1a | pi 真实 `createPiTranscript` + core `tagTranscript` + `applyNewToolDrop`，无原生信封 | `mode=full`，调用和 toolResult 都被删 |
| F1b | 同上，assistant 带 Responses 信封但找不到该 call | `cannotRemove()=true`，`mode=skeleton_real`；调用参数仍是 `{path:"a.ts"}`；toolResult 变成 `[dropped §N§]`；assistant 文本有 §N§ |
| F2/F3 | DSH 风格最小适配器：每个 part 回指一个源节点；assistant part 只读；没有 `remove` | tag 后只有 user（10、14）和 tool（12、16）节点出 op，内容带 §N§；drop 由 core 自动判为 `skeleton_real`，只改 tool 节点 12；没有任何 assistant op |
| F4 | 同一适配器，旧 `full` drop 走 `drop()` 重放 | 返回 `removed`（sentinel 兜底），只改 tool 节点 12，没有 assistant op |
| F4b | 统计 tags 表 | assistant 文本仍分配 message tag（`a-11:p0`、`a-13:p0`），见 §5.2 |

没做的：没有把这个适配器接到真实 DSH Session 上（E 线 spike R1–R7 已验证 DSH 侧的单节点 replace，两边合起来覆盖方案 N 的
两端，但中间的 `walkDshLog` 改造没有写）；没有跑 bench / e2e。

## 7. 需要用户决定的事

1. 方案 N 是否按本文修订：写模型照 pi（视图去掉 assistant 折叠、part 回指源节点、按源节点出 op），删掉「通知 core 走 skeleton」这一步。
2. assistant 文本的 tag：(a) native 模式下不分配（推荐），还是 (b) 分配但保证 no-op。
3. tag scheme 标志：只对开启后新建的会话生效（推荐），还是参照 pi v25 做一次性强制 execute 迁移旧会话（会有一次 cache bust）。
4. Channel 1 nudge 是否要改成写进工具结果内容（需要另查 DSH 工具钩子）。
