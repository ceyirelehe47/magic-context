# Round 36 line D — 插件组每步输出 / 推理 token 约为基线 6 倍：原因调查

用户 2026-11-06 13:53 CST 要求。**只调查，不改产品代码**：没有改任何产品默认行为、断言、core 或上游 workflow。
新增的只有 bench 侧诊断开关（`scripts/e2e/cache-bench/proxy.mjs` 的 `BENCH_ABLATE`、
`dsh-cache-bench.yml` 的 `ablate_plugin` / `ablate_baseline` 输入），默认为空，空时代理行为与 B/C 线完全一致。

> **结论（已复现）**：多出来的输出几乎全是推理，原因是**适配层把整段对话（包括当前这一轮刚发出的工具调用）折叠成
> user 消息**（已知限制 1）。去掉 MC 系统段、6 个 ctx 工具和全部 §N§ 标签后，插件组仍为 401 / 345 token/步；
> 在基线组用代理模拟同样的折叠，基线升到 605 / 553 token/步。只折叠以前的轮次、当前轮保持原生 assistant/tool 时，
> 基线为 64 / 17 token/步；不加 note、只把角色压平（foldplain），基线也有 483 / 432。system 段、工具描述、标签、填充长度的贡献都在噪声范围内。

## 1. 已有 run 的数据（无新跑）

来源：cache-bench 42142782133（修复前，B 线）、42164389768 / 42166613496（修复后，C 线）的产物
`requests.jsonl`（provider 原始 usage：`completion_tokens`、`completion_tokens_details.reasoning_tokens`）。
步 = 第一次压缩前的主 agent 请求（同 analyze.py）；429 / 无 usage 的请求不计。

| run | group | runs | steps (usage) | out/step mean / median / p90 | reasoning/step mean / median / p90 | steps 1–14 out | steps 1–14 reasoning | steps 15+ out | steps 15+ reasoning | text (out−reasoning)/step | steps with reasoning=0 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 42142782133 | baseline | 3 | 42 | 55 / 44 / 93 | 7 / 0 / 21 | 55 / 44 / 93 | 7 / 0 / 21 | — | — | 48 | 35/42 |
| 42142782133 | plugin | 3 | 292 | 363 / 286 / 653 | 291 / 220 / 571 | 344 / 244 / 588 | 284 / 188 / 510 | 366 / 304 / 659 | 292 / 238 / 577 | 73 | 10/292 |
| 42164389768 | baseline | 3 | 42 | 55 / 44 / 73 | 7 / 0 / 25 | 55 / 44 / 73 | 7 / 0 / 25 | — | — | 48 | 34/42 |
| 42164389768 | plugin | 3 | 98 | 385 / 296 / 820 | 324 / 233 / 757 | 326 / 256 / 588 | 267 / 212 / 544 | 430 / 316 / 926 | 368 / 245 / 875 | 61 | 5/98 |
| 42166613496 | plugin | 3 | 96 | 347 / 293 / 606 | 286 / 244 / 556 | 315 / 308 / 507 | 259 / 252 / 457 | 373 / 278 / 708 | 307 / 222 / 636 | 62 | 9/96 |

读法：

* 差异在修复前后都在（C 线的 drop 门控没有改变它），9 次插件 run 全部如此，不是随机波动。
* **约 85 % 的多出输出是推理**：插件每步推理 ~290 vs 基线 ~7；可见文本只多 ~15 token/步（§N§ 前缀和
  "Reading p11 now." 这类旁白）。
* 基线 **83 % 的步骤推理为 0**（读文件那几步直接出 tool call），插件 **95 % 以上的步骤都在推理**。
* 前 14 步已经是 ~6 倍，之后还略升（上下文更长），所以不是"开头读系统提示"的一次性成本。
* 不是重复读文件：修复后 9 次插件 run 每个文件 1.19–1.58 步，基线 1.27（`deep.py` 统计）；修复前 143/113 步
  的 run 是 drop 失效造成的（B 线已解释），不影响每步输出的结论。

## 2. 请求体对比（静态，42164389768 run1：插件 bodies/20.json vs 基线 bodies/12.json）

| 项 | 基线 | 插件 |
|---|---|---|
| 采样 / 推理参数 | `stream`、`max_completion_tokens: 4096`、`store:false`，无 temperature / reasoning 参数 | **完全相同** |
| system 消息 | 2 598 字符 | 8 426 字符（多出 `## Magic Context` 段 ~5 800 字符，core `buildMagicContextSection` full 预设原文） |
| tools | 25 个，21 182 字符 | 31 个，34 442 字符（+ctx_expand 2 528、ctx_memory 2 178、ctx_note 3 076、ctx_reduce 1 548、ctx_search 2 327、todowrite 1 591） |
| 消息角色 | `s u u a u a t a t … a u`：assistant 带 `tool_calls`，**并带回 `reasoning_content`**，tool 结果是 `role: tool` | **除 system 外全部是 `user`**，0 条 assistant、0 条 tool |
| 工具调用的呈现 | 原生 tool_calls / tool 消息 | 每个工具弧折叠成一条 user 文本："Magic Context note: these tool calls already ran and finished … Do not run them again …" + §N§ 结果；**包括上一步刚发出的那次调用** |
| 模型之前的推理 | 每个 assistant 都带 `reasoning_content`（DeepSeek 交错思考，模型接着上一步的思路走，例如 "The checksum is P19-1-971820. Now read p02.txt."） | **全部丢失**（折叠进 user 文本时没有 reasoning 可放） |
| 注入 | — | 每条带 `§N§`；`<session-history>`、`<session-history-since>`、runtime-context 快照为单独 user 消息；system 段要求"每条有文本的回复以 §N§ 开头，N = 可见最大 tag + 1" |

关键观察：折叠（DSH-MAINTENANCE 已知限制 1，`agent/transcript.ts` walkDshLog + renderToolRecord v2）让模型每一步
都面对"一大串 user 消息、自己从没说过话、刚做的事被告知已经做完"的局面，同时拿不到上一步的 reasoning。
DeepSeek 在有 assistant 历史 + reasoning_content 时通常直接延续（基线 0 推理），在这里必须重新判断进度
（"已经读了哪些、下一个是哪个、tag 该写几号"），这与观察到的"几乎每步都推理 200–300 token"一致。

### 是否属于 core 设计（静态比对）

* `## Magic Context` 段（含 SELF_TAG_GUIDANCE "N = 可见最大 tag + 1"）是 **core 原文**：
  `packages/plugin/src/agents/magic-context-prompt.ts` `buildMagicContextSection`，适配层
  `agent/system-guidance.ts` 原样调用（full 预设，ctxReduceCallable=true）。上游 OpenCode 版用的是同一段文本。
* ctx_* 工具描述也来自 core（与 OpenCode 相同）。
* **折叠成 user 角色、丢 reasoning 是 DSH 适配层特有**：只存在于 `packages/dsh-plugin/src/agent/transcript.ts`；
  core / OpenCode 版就地给消息 part 加 tag，assistant / tool 角色和 reasoning part 保留（`packages/plugin` 中
  无 "these tool calls already ran" 文本）。原因是 DSH 不允许插件就地改写消息，只能 surface replace（限制 1）。
* 第 1 部分时的初步判断是「折叠为主因、静态注入为次要因素」；消融结果见第 3 节：折叠是主因（已复现），reasoning_content 丢失本身**不是**原因，静态注入的贡献测不出来。

## 3. 消融（bench 代理层改写，仅诊断）

`BENCH_ABLATE`（逗号列表）只改 kind=main 的请求，改动记入 requests.jsonl 的 `ablated` 字段；所有 run 另把响应流的
reasoning / text / tool_calls 写入 `resp/<n>.json`，用于看模型在想什么。

| 开关 | 含义 |
|---|---|
| `nosys` | 删掉 system 里的 `## Magic Context` 段（插件组） |
| `notools` | 删掉基线没有的 6 个工具（ctx_*、todowrite） |
| `notags` | 删掉消息里的 `§N§ ` 和 system 里的 self-tag 段 |
| `noreason` | 去掉 assistant 消息的 `reasoning_content`，角色不变（基线组） |
| `fold` | 在基线组模拟插件折叠：assistant（+其 tool 结果）全部变成 user，工具弧用插件 v2 的散文 note，无 reasoning |
| `pad` | 基线 system 追加 ~5 800 字符中性文本（与 MC 段同长） |

另外两个变体在第一批结果出来后加上（c7293d0ed）：

| 开关 | 含义 |
|---|---|
| `foldtail` | 同 `fold`，但最后一条 user 消息之后的工具弧（当前这一轮）保持原生 assistant/tool + reasoning，用来估计「当前轮不折叠」方案的效果 |
| `foldplain` | 同 `fold`，但去掉 "Magic Context note …" 那句话，只做角色扁平化 |

（foldplain 在 42173985186 run1 中出现了重复读取，模型自己说 p33 "repeated three times"。这与第 28 轮 v1 的现象一致。）

所有变体都用同一个任务、同一个模型（deepseek-v4.1-flash，100k 路由）、同一个 DSH rc.5，每次 run 都换新的 nonce、
新的 session 和新的 XDG 目录，跑到第一次压缩为止，每个变体 2 次。代码基于 a8e8e6b8e / c7293d0ed，产品代码是 C 线的
8cc2c4220 树。窗口内 provider 的 429 很多（例如 42172024788 baseline run2 有 37 个请求返回 429），429 的请求不计入。
42172028320 的插件组本来应该是对照组，但 workflow 表达式 `a && b || c` 在 `ablate_plugin` 为空时取到了基线组的
`pad`，所以它实际跑的是「插件 + pad」。这个问题在 c7293d0ed 改成在 bash 里选择；这组数据仍然有效，只是含义是插件 + pad。

### 消融结果

| run | group (ablate) | runs | steps (usage) | out/step mean / median / p90 | reasoning/step mean / median / p90 | steps 1–14 out | steps 1–14 reasoning | text (out−reasoning)/step | steps with reasoning=0 |
|---|---|---|---|---|---|---|---|---|---|
| 对照（第 1 节，3 个 run 共 9 次） | plugin | 9 | 486 | ~365 | ~295 | 315–344 | 259–284 | 61–73 | 24/486 |
| 对照（第 1 节，2 个 run 共 6 次） | baseline | 6 | 84 | 55 | 7 | 55 | 7 | 48 | 69/84 |
| [42172021344](https://github.com/ceyirelehe47/magic-context/actions/runs/42172021344) | plugin (nosys) | 2 | 72 | 370 / 286 / 586 | 310 / 194 / 542 | 250 / 193 / 491 | 194 / 140 / 447 | 59 | 4/72 |
| [42172024788](https://github.com/ceyirelehe47/magic-context/actions/runs/42172024788) | plugin (nosys,notools,notags) | 2 | 72 | **401** / 256 / 792 | **345** / 210 / 656 | 386 / 199 / 594 | 337 / 151 / 550 | 56 | 3/72 |
| [42172028320](https://github.com/ceyirelehe47/magic-context/actions/runs/42172028320) | plugin (pad) | 2 | 69 | 344 / 266 / 550 | 273 / 196 / 491 | 336 / 264 / 501 | 277 / 204 / 450 | 70 | 7/69 |
| [42172021344](https://github.com/ceyirelehe47/magic-context/actions/runs/42172021344) | baseline (noreason) | 2 | 26 | 52 / 44 / 60 | 6 / 0 / 9 | 52 / 44 / 60 | 6 / 0 / 9 | 46 | 22/26 |
| [42172028320](https://github.com/ceyirelehe47/magic-context/actions/runs/42172028320) | baseline (pad) | 2 | 28 | 56 / 58 / 64 | 7 / 0 / 18 | 56 / 58 / 64 | 7 / 0 / 18 | 48 | 16/28 |
| [42172024788](https://github.com/ceyirelehe47/magic-context/actions/runs/42172024788) | baseline (fold) | 2 | 23 | **605** / 370 / 1359 | **553** / 274 / 1356 | 605 / 370 / 1359 | 553 / 274 / 1356 | 52 | 2/23 |
| [42173981151](https://github.com/ceyirelehe47/magic-context/actions/runs/42173981151) | baseline (foldtail) | 2 | 28 | **64** / 44 / 134 | **17** / 0 / 30 | 64 / 44 / 134 | 17 / 0 / 30 | 48 | 22/28 |
| [42173985186](https://github.com/ceyirelehe47/magic-context/actions/runs/42173985186) | baseline (foldplain) | 2 | 22 | **483** / 402 / 858 | **432** / 340 / 814 | 483 / 402 / 858 | 432 / 340 / 814 | 50 | 0/22 |

各变体都确认了改写确实生效：requests.jsonl 的 `ablated` 字段记录了实际改动，例如 `["nosys","notools(-6)","notags(9)"]`、
`fold(10)`、`foldtail(9/12)`。nosys + notools + notags 时，最后一个请求体里 system 为 2 598 字符（和基线相同）、
工具 25 个、`§` 出现 0 次。

### 模型在想什么（`resp/<n>.json`，原文摘录）

插件组（nosys，42172021344 run1）：

* #12 "…But there's a Magic Context note: these tool calls already ran and finished … Only p09 is shown in §14. Wait — the note says calls for p09 ran, but only p09 result is shown? Let me re-read. …"
* #30 "…the note says the tool calls already ran and finished. However, the merged results only include p25 fully … Maybe the remaining p26-p32 results are missing/truncated. …"
* #45 "…I've already read p33, p34, p35 (results merged). I need to read p36 … Let me first do ctx_reduce for old outputs? The system reminder says 23 spent outputs still unstamped … So reductions already done. …"

基线 + fold（42172024788 run2）：

* #5 "…But the system injected "Magic Context note" saying these tool calls already ran and finished, with results merged for p01 and p02 … Hmm, this is a conflict. The user explicitly asked to read each file with the read tool, one read call per step. But the injected note says they already ran. …"

基线 + foldplain（42173985186 run1，没有 note，只做角色扁平化）：

* #34 "The user's messages have a strange structure: they repeat the instruction batches but never actually provided the read results … the tool result already appears for p33 (repeated three times) …"

基线（原生历史，带 reasoning_content）：例如 "The checksum is P19-1-971820. Now read p02.txt."，大多数步骤推理为 0。

也就是说，模型每一步都在重新整理进度：读了哪些、note 为什么说已经做完、结果是不是被截断了、要不要再读一次。
它没有在琢磨 §N§ 编号或 ctx_reduce 规则；ctx_reduce 只在 nudge 出现时偶尔被想到（#45）。

## 4. 结论

| 因素 | 证据 | 贡献 | 证据等级 |
|---|---|---|---|
| **把当前轮的工具弧折叠成 user 文本（角色扁平化 + 「已经做完」的 note）** | 插件去掉所有静态注入后仍为 345 推理/步；基线 + fold 为 553；基线 + foldtail 为 17 | **几乎全部**（~290 / ~295 推理 token/步） | **已复现**（双向） |
| reasoning_content 不回传 | 基线 + noreason：6 推理/步（对照 7） | ≈ 0 | 已复现（无效应） |
| MC 系统段（~5.8k 字符） | 插件 nosys：310（对照 ~295）；基线 + 同长度 pad：7 | ≈ 0（在噪声内） | 已复现（无效应） |
| 6 个 ctx 工具描述、§N§ 标签 / self-tag 规则 | 插件 nosys + notools + notags：345 | ≈ 0（在噪声内） | 已复现（无效应） |
| 「已经做完、不要再跑」的 note 措辞 | 基线 + foldplain（没有 note，只做角色扁平化）：432，与 fold 的 553 同一量级 | 不是主因：**只要角色扁平化就会出现** | 已复现 |
| 以前轮次的折叠 | 基线 + foldtail：17（对照 7） | 很小（+10 /步） | 已复现 |

* **是否属于 core 设计**：不属于。提示文本和工具描述都是 core 原文，但消融显示它们不是原因。原因是 DSH 适配层的
  surface 折叠（已知限制 1，DSH 不允许插件就地改写消息，只能 surface replace）。上游 OpenCode 版会就地给 part 加
  tag，并保留 assistant / tool 角色，所以按设计不会出现这种情况（**静态推断**：没有在 OpenCode 上实测）。
* 当前插件 run 中，前缀是只追加的（C 线结果是 0 次分叉），这正是因为每一步都把刚到的工具弧立即折叠进去。
  缓存友好和推理开销是同一个设计的两面。

## 5. 改进方案（**未实施**，需用户批准）

价格按 DeepSeek flash 高峰价：命中 $0.006/M、未命中 $0.30/M、输出 $1.20/M（低峰价都减半，比例不变）。修复后，插件组
每步成本约 $0.00125（9 次 run 中 $0.00117–0.00141），其中输出占 31–40 %（每步约 $0.00045）。如果推理回到基线水平
（foldtail 约 64 输出 token/步），每步输出成本会降到约 $0.00008，**每步省约 $0.00037，约占插件每步成本的 29 %**。
在这个 bench 里，每次 run（约 33 步）约省 $0.012（$0.041 → 约 $0.029）。

| 方案 | 做法 | 预计输出节省 | 额外缓存成本 | 功能影响 / 风险 |
|---|---|---|---|---|
| **A. 当前轮不折叠，下一条用户消息到来时再折叠** | 最后一条真实 user 消息之后的工具弧保持原生 assistant/tool + reasoning；下一轮开始时再折叠并打 tag | 约 −300 token/步（foldtail 实测 64 / 17） | 每轮一次前缀改写（重写上一轮的工具弧）：foldtail 命中率 86.7 % → 81 %，每步未命中成本 +$0.00029。在这个 bench 里（每个结果约 2k token）净省只有约 6 %；工具结果越小、每轮步数越多，越划算。盈亏平衡点约为平均每个工具结果 1.2k token | 当前轮里的结果没有 §N§，ctx_reduce 无法指向它们（它们本来大多在 protected 范围内，而且 drop 也只在 ride 时落地）。很长的单轮（几十次工具调用）会积累未打 tag 的原生结果，需要确认 pressure-truncation / force 档能处理原生节点 |
| **A′. 只在 reclaim ride 时折叠**（与 C 线 drop 门控相同的时机） | 原生节点一直保留到下一次 ride（historian 发布、/compact、force 档等，这些本来就会改写前缀），ride 时一次性折叠并打 tag | 与 A 相同或更多（两次 ride 之间全是原生历史，接近基线 7） | **≈ 0**（复用已有的改写） | 两次 ride 之间的输出不能被 ctx_reduce 标记，只能交给 historian / ride 处理。§N§ 编号要改成 ride 时分配。改动面最大（transcript walk、tag 分配、coordinator），需要新的单测和 e2e |
| B. 改 note 措辞 | 例如不写 "Do not run them again"，改为中性的「以下是你刚才调用的结果」 | **≈ 0 到很小**：foldplain 去掉 note 后仍有 432 推理/步，措辞不是原因 | 0 | 不建议。第 28 轮的教训：v1（不写目标）会让模型重复读同一个文件；v0 / v27 格式会被模型照抄（限制 21）。措辞方案容易反复 |
| C. 去掉或精简 MC 系统段 / 工具描述（DSH 版精简提示、light 预设） | — | **≈ 0**（nosys / notools / notags 已证伪） | 输入每步少约 2k token（几乎都命中缓存，约 $0.00001/步） | 会损失 ctx_* 的使用指导，不建议仅为了省输出而做 |
| D. 向 DSH 上游提需求 | 允许插件就地变换 tool result / 保留角色的 surface replace | 从根本上消除 | 0 | 依赖上游，周期不可控。可以和 A / A′ 并行 |

建议：如果要动，先做 **A′**（和 C 线的 ride 门控同一套时机，不增加缓存成本），A 可以作为较小改动的过渡方案。两者都要
先补 RED 测试，再用 cache-bench（`BENCH_ABLATE` 为空）和 e2e 验证，并且只改适配层。


## 附：文件

* 每步数据（8 个 run 的全部 bench run，含 429 步，status 字段区分）：[d-output-tokens-steps.jsonl](d-output-tokens-steps.jsonl)
* 统计脚本：[d-scripts/table.py](d-scripts/table.py)（本文各表）、[d-scripts/deep.py](d-scripts/deep.py)（重复读取 / 文本 token），
  [d-scripts/art.sh](d-scripts/art.sh)（下载 run 产物，产物保留 7 天）
* 代理开关：`packages/dsh-plugin/scripts/e2e/cache-bench/proxy.mjs`（`BENCH_ABLATE`），workflow 输入
  `ablate_plugin` / `ablate_baseline`（默认为空 = 与 B/C 线完全相同）
