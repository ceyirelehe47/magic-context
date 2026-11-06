# Round 36 line D — 插件组每步输出 / 推理 token 约为基线 6 倍：原因调查

用户 2026-11-06 13:53 CST 要求。**只调查，不改产品代码**：没有改任何产品默认行为、断言、core 或上游 workflow。
新增的只有 bench 侧诊断开关（`scripts/e2e/cache-bench/proxy.mjs` 的 `BENCH_ABLATE`、
`dsh-cache-bench.yml` 的 `ablate_plugin` / `ablate_baseline` 输入），默认为空，空时代理行为与 B/C 线完全一致。

> 状态：**第 1 部分（已有数据 + 静态比对）已完成**；第 2 部分（消融）见文末，随 run 结果补齐。

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
* 初步判断（**静态推断，待消融验证**）：主因是折叠（角色扁平化 + reasoning_content 丢失），系统段 / 工具描述是次要因素。

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

（结果见下节，待补。）
