# pi-brainstorm

面向 [pi](https://github.com/earendil-works/pi-coding-agent) 的多 Agent 头脑风暴与辩论插件。

`pi-brainstorm` 让不同身份和提示词设定的 Agent 参与同一场讨论。差异来自角色视角，而不是底层模型。使用 `/brainstorm` 启动结构化讨论，使用 `/debate` 启动对抗辩论。

插件会把每个参与者的完整发言保存在 `.pi-meetings/...` 下的本地会议黑板中。黑板是实现亮点，不是主要卖点：它让主会话保持简洁，只展示短卡片、主持人总结、共识、分歧和最终结论，同时完整 transcript 仍然保存在磁盘上。

English README: [README.md](./README.md).

## 功能

- 多 Agent 头脑风暴：默认身份为 GPT-Progressive（追新探索者）、GPT-Localist（本地守成者）、GPT-Diagnostician（问题诊断者）、GPT-Critic（严苛质询者），每个参与者作为一个 subagent 任务运行，使用各自的角色提示词。
- 辩论 / battle 模式：Agent 会攻击、审视、反驳彼此的观点。
- 配置驱动：通过 YAML 添加、删除或自定义参与者。
- 参与者完整发言以 Markdown 文件保存到 `.pi-meetings/`。
- 主会话中展示紧凑发言卡片，而不是粘贴长篇 transcript。
- 使用 JSONL 索引作为轻量级跨轮上下文入口。
- 基于 `@narumitw/pi-subagents` v3（`subagent_spawn` / `subagent_wait`）。

## 安装

推荐一行安装：

```bash
pi install npm:@narumitw/pi-subagents && pi install npm:pi-brainstorm
```

只安装本包：

```bash
pi install npm:pi-brainstorm
```

通过 GitHub 安装：

```bash
pi install git:github.com/Jarcis-cy/pi-brainstorm@v0.4.3
```

本地开发安装：

```bash
pi install /Users/jarcis/Project/pi-brainstorm
```

## 配置

参与者通过 YAML 定义。插件按以下顺序加载配置（后者覆盖前者）：

1. 包默认配置：`config/default.yaml`（随包发布）
2. 用户级覆盖：`~/.pi/agent/pi-brainstorm.yaml`
3. 项目级覆盖：`.pi-brainstorm.yaml` 或 `.pi/pi-brainstorm.yaml`

数组（如 `participants`）整体替换；对象字段深度合并。

### 添加新参与者

创建 `~/.pi/agent/pi-brainstorm.yaml`（用户级）或 `.pi-brainstorm.yaml`（项目级）：

```yaml
participants:
  - displayName: GPT-Analyst
    agentName: gpt-analyst-brainstormer
    description: 细致入微的分析师，用于多 Agent 讨论。
    roleTitle: 细致分析师
    rolePrompt: |
      你是多 Agent 头脑风暴中的分析顾问。擅长细致入微的论证和长篇分析。用中文回答。
    whatYouDo:
      - 提供细致、深入的逐点分析
      - 识别细微差别和边缘情况
      - 撰写结构清晰的长篇论证
    debatePersona:
      label: THE ANALYST
      prompt: |
        DEBATE MODE. You are THE ANALYST. Dissect every argument with precision. Find the weakest link in every chain of reasoning. Use Chinese.
    brainstormRole: 细致分析师
    # 可选：每个参与者的思考等级与执行超时
    # thinkingLevel: xhigh
    # timeoutSeconds: 900
```

如需完全替换默认参与者，在覆盖文件中定义完整的 `participants` 列表即可。

顶层还支持以下选项：

- `thinkingLevel` — 传给 `subagent_spawn` 的默认思考等级（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`）。省略则继承主 Agent 的等级。
- `subagentTimeoutSeconds` — 任务执行超时（秒，默认 `900`）。
- `subagentWaitTimeoutSeconds` — `subagent_wait` 等待超时（秒，默认 `900`）。
- `extensionPath` — 覆盖附加给子 Agent 的 pi-brainstorm 扩展路径（高级选项）。

> 旧字段 `model:` 仍可加载但会被忽略：pi-subagents v3 的子 Agent 始终继承主 Agent 的模型。

### Subagent 运行时

`pi-brainstorm` 不再生成 agent 文件。参与者的角色文本会注入到 `subagent_spawn` 的 task 中，子 Agent 通过附加本扩展获得黑板工具。`~/.pi/agent/agents/` 下无需安装任何内容；之前生成的 `*-brainstormer.md` 文件可以删除。

## 前置条件

`pi-brainstorm` 通过 `@narumitw/pi-subagents` **v3** 编排参与者，该包注册 `subagent_spawn` / `subagent_wait` 工具。使用 `/brainstorm` 或 `/debate` 前，请先单独安装：

```bash
pi install npm:@narumitw/pi-subagents
```

`@narumitw/pi-subagents` 会把每个参与者任务作为隔离的 Pi 子进程运行。它是运行时前置条件，不随 `pi-brainstorm` 打包。

v3 运行时**没有 `subagent` 工具，也没有具名 Agent 目录**。因此 `pi-brainstorm` 改为使用自包含任务进行委派：参与者角色文本来自你的 YAML 配置，子 Agent 通过附加本扩展获得黑板工具。

影响 `pi-brainstorm` 工作方式的 v3 行为：

- `subagent_spawn({ task, tools, extensions, thinkingLevel?, timeout? })` 立即返回 `jobId`，任务在后台运行；用 `subagent_wait({ jobId })` 等待结果。
- 终态为 `completed`、`partial`、`failed`、`timed_out`、`cancelled`。
- 子 Agent 继承主 Agent 的模型。**没有按任务指定模型的覆盖能力**；请用 YAML 定义角色，而不是为每个参与者选择底层模型。
- 子 Agent **不会**继承主 Agent 的扩展工具。`pi-brainstorm` 会附加自身扩展，并且只暴露 `meeting_append_entry`、`meeting_read_index`、`meeting_read_entry`。
- 超时单位为**秒**（旧的 `PI_SUBAGENT_TIMEOUT_MS` 环境变量不再适用）。参与者全文应写入 `.pi-meetings/...`，主会话只应看到短的 `WROTE_ENTRY` 摘要和主持人综合。

项目本地安装的场景下，附加扩展在子进程中加载可能需要项目信任（project trust）。

## 命令

```text
/brainstorm <主题>
/debate <主题>
```

`/brainstorm` 启动交互式三轮多 Agent 头脑风暴。Round 1 和 Round 2 结束后，主持人应停止、总结本轮，并等待你的反馈或继续许可，再进入下一轮。

`/debate` 启动开放式多 Agent battle，直到收敛或用户介入为止。


## 工作方式

```text
主持人 -> subagent_spawn(task) -> 子 Agent 通过 meeting_* 工具读写黑板
子 Agent -> meeting_append_entry -> .pi-meetings/... 文件
子 Agent -> 短 WROTE_ENTRY 摘要 -> subagent_wait 结果 -> 主持人上下文
文件 watcher -> 短卡片 -> 主会话可见区域
主持人 -> 每轮 checkpoint / 共识 / 分歧 / 最终综合
```

黑板文件是会话事实源。主持人可以按需读取索引或具体条目，然后生成结构化总结。

## 工具

扩展注册一整套黑板工具：

- `meeting_rename`（仅主持人）：在 Round 1 开始前将会议目录重命名为人类可读的标题。
- `meeting_append_entry`：把参与者完整发言写入磁盘，只返回短引用。
- `meeting_read_index`：读取条目索引，包含 id、speaker、phase、summary、path。
- `meeting_read_entry`：在主持人或参与者需要时读取某条完整发言。
- `meeting_append_artifact`、`meeting_append_edge`、`meeting_read_artifacts`、`meeting_get_state`、`meeting_update_state`、`meeting_log_event`：支撑 v2 lab 模式（artifact / edge / state 跟踪）。

会话中的子 Agent 只通过附加扩展获得 `meeting_append_entry`、`meeting_read_index`、`meeting_read_entry`，其余工具保留在主持人的主 Agent 中。

## 文件结构

每次会话会在当前工作目录下创建 append-only 目录：

```text
.pi-meetings/YYYY-MM-DD-topic/
  manifest.json
  index.jsonl
  blackboard.md
  entries/
    0001-gpt-progressive-round_1.md
    0002-gpt-localist-round_1.md
```

`blackboard.md` 是完整 transcript。`index.jsonl` 是紧凑索引。参与者全文放在 `entries/`。

## 安全边界

扩展会校验会议路径必须留在当前工作区的 `.pi-meetings/` 下，并拒绝符号链接形式的会议目录、entry 文件、index 文件和 blackboard 文件。entry 写入使用 exclusive creation，避免覆盖已有文件。

## 从 2.x 迁移

`pi-brainstorm` v0.6 面向 `@narumitw/pi-subagents` **v3**。如果你从 2.x 升级，请注意 v3 移除了 `subagent` 工具、具名 Agent 目录、按任务指定模型以及自定义系统提示词。`pi-brainstorm` 已相应更新：

- 编排改用 `subagent_spawn` + `subagent_wait`，不再使用 `subagent`。
- 参与者角色文本注入 spawn task；生成的 agent 文件已移除。
- 子 Agent 通过 `extensions: [{ path, tools }]` 获得黑板工具。
- 参与者配置中的 `model:` 会被忽略；请用 `thinkingLevel` 控制推理深度。

升级后请开启新的 Pi 会话，避免残留的工具调用仍请求已移除的工具名。

## 开发

```bash
npm pack --dry-run
```

该扩展由 pi 的扩展加载器直接加载 TypeScript。运行时从 pi 引入的 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` 和 `typebox` 按 pi package 规范声明为 peer dependencies。

## License

MIT
