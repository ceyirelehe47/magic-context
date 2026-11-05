# dsh-magic-context

Magic Context 的 DeepSeek Harness（DSH）适配。作为 DSH 插件 bundle
（Host / Agent / Client 三面），加载共享的 Magic Context SQLite
（`harness='dsh'` 行隔离），注册 `ctx_*` 工具、`/ctx-*` 命令、知识注入、
historian/dreamer 调度、Magic 压缩，以及 **DSH 设置页中的 Magic Context 分区**
和输入框旁的 **Magic Context 上下文用量环**。

> 社区维护的下游发行版，位于 https://github.com/cortexkit/magic-context（MIT）
> 的 fork：https://github.com/ceyirelehe47/magic-context 的 `dsh-integration`
> 分支。与官方 Magic Context 或 DeepSeek 无隶属关系。维护说明见
> `docs/DSH-MAINTENANCE.md`。

兼容版本：DSH **0.2.1-rc.5**（默认）、**0.2.2-alpha.3** 和 **0.2.2-rc.1**，仅限这三个精确版本
（peer 依赖为 `0.2.1-rc.5 || 0.2.2-alpha.3 || 0.2.2-rc.1`；DSH 插件管理器和 `doctor` 会拒绝其他版本，
例如 0.2.2-rc.2 或 0.2.2）。DSH 0.2.2-* 本身要求 node ≥ 24.9.0。0.2.2-rc.1 自第 30 轮起在分支上声明；
发行 tag `dsh/0.49.35-dsh.5` 只声明 0.2.1-rc.5 和 0.2.2-alpha.3。Magic Context core **0.49.35**（共享 schema，见 `docs/dsh/FEATURES.md`）。

## 安装

本包尚未发布到 npm，需从 fork 的 `dsh-integration` 分支构建：

```sh
git clone -b dsh-integration https://github.com/ceyirelehe47/magic-context.git
cd magic-context
bun install
cd packages/dsh-plugin
bun run build
bun pm pack            # 生成 dsh-magic-context-<version>.tgz
```

把生成的包装进 DSH profile（`dsh plugin --profile <name> add <tgz 路径>`——
`dsh plugin` 会把参数转发给 profile 目录下的 pnpm——或把解包后的目录放进该
profile 的 `node_modules/dsh-magic-context`），然后接线：

```sh
dsh-magic-context setup  --profile web                 # 首次：在生成的 magic-standard 模式中启用 Magic
dsh-magic-context setup  --profile web --all-presets   # 或：在所有内置模式中启用（standard、ptc、minimal、cordis）
dsh-magic-context setup  --profile web --preset standard,ptc
dsh-magic-context setup  --profile web --disable-preset ptc
dsh-magic-context doctor --profile web                 # 各 preset 启用状态 + 用量环状态
```

`setup` 把 bundle 加入 `dsh.profile.bundles`，并在
`$DSH_HOME/profiles/<name>/cordis.patch.yml` 中写入一个受管块：对每个启用的
agent preset 禁用 `compaction-basic`、挂载 `magic-compaction` + `magic-agent`；
在 profile 范围内把内置 `token-meter` 行换成 `magic-meter`。扁平
（headless/tui）profile 只有一个伪 preset `root`。首次还会创建
`~/.config/cortexkit/magic-context.jsonc`（不会覆盖已有文件）。修改 preset 后
请重启 DSH（或开新会话）。

## 设置

Magic Context 读取共享的 `magic-context.jsonc`（项目
`.cortexkit/magic-context.jsonc` > 用户 `~/.config/cortexkit/…`），与 OpenCode、
Pi 用同一个文件。在 DSH 中，**设置 → Magic Context** 可以按 profile 实时覆盖
部分字段（启用开关、historian 模型、headless 回合末等待、执行阈值、按模型阈值、
保护 token 数）。

**优先级：DSH 覆盖 > `magic-context.jsonc` > core 默认值。** 未设置的字段继承
jsonc；DSH 不会写 jsonc。修改写入当前 profile 的 `cordis.patch.yml`
（`- id: magic-host` 行），下一个 agent step 生效，无需重启。

## 上下文用量环

输入框的用量环显示 **Magic Context** 的上下文占用：达到 MC 执行阈值变黄，
接近强制阈值变红；点击查看详情（阈值、system/tools/对话占比、compartments 与
historian 状态、待执行 drop、知识 token、nudge）并可跳转到设置分区。原生 DSH
用量环由 `setup` 隐藏：真实 token meter 仍在运行（`tool-result-pruner` 等插件依赖
其 `tokenMeter` 服务），只是它的 `contextPressure` 投影改名为
`magicContextPressure`，因此只渲染 MC 的环。

## 卸载

对每个已启用的 preset 执行 `dsh-magic-context setup --profile <name>
--disable-preset <preset>`（移除受管块），再从 profile 中移除 bundle。共享
SQLite 与 `dsh_*` 适配表**有意保留**（跨 harness 数据）。

## 许可证

MIT。上游版权声明见 `THIRD_PARTY_NOTICES.md` 与 `NOTICE`。
