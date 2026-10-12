# pi-brainstorm

面向 [pi](https://github.com/earendil-works/pi-coding-agent) 的多 Agent 头脑风暴与辩论插件。

`pi-brainstorm` 让不同身份和提示词设定的 Agent 参与同一场讨论。差异来自角色视角，而不是底层模型。使用 `/brainstorm` 启动结构化讨论，使用 `/debate` 启动对抗辩论。

插件会把每个参与者的完整发言保存在 `.pi-meetings/...` 下的本地会议黑板中。黑板是实现亮点，不是主要卖点：它让主会话保持简洁，只展示短卡片、主持人总结、共识、分歧和最终结论，同时完整 transcript 仍然保存在磁盘上。

English README: [README.md](./README.md).

## 功能

- 多 Agent 头脑风暴：默认身份为 GPT-Progressive（追新探索者）、GPT-Localist（本地守成者）、GPT-Diagnostician（问题诊断者）、GPT-Critic（严苛质询者），每个参与者作为一个 headless Pi 子进程运行，使用各自的角色简报。
- 辩论 / battle 模式：Agent 会攻击、审视、反驳彼此的观点。
- 配置驱动：通过 YAML 添加、删除或自定义参与者。
- 支持按参与者指定模型与思考等级，未设置时继承主 Agent 的模型。
- 参与者完整发言以 Markdown 文件保存到 `.pi-meetings/`。
- 主会话中展示紧凑发言卡片，而不是粘贴长篇 transcript。
- 使用 JSONL 索引作为轻量级跨轮上下文入口。
- 无需任何 subagent 扩展：参与者由本扩展直接 spawn 并监管的 `pi --print` 子进程。

## 安装

推荐一行安装：

```bash
pi install npm:pi-brainstorm
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

`participants` 按 **`agentName`** 跨层合并：

| 你写下的内容 | 效果 |
| --- | --- |
| 已存在的 `agentName` | 逐字段覆盖该参与者；未提到的字段保留低层配置 |
| 新的 `agentName` | 新增一个参与者 |
| 已存在但你没提到的参与者 | 原样保留 |
| 某个 `agentName` 加上 `disabled: true` | 移除该参与者，并留下墓碑，低优先级文件无法再加回来 |

其他数组整体替换；对象字段深度合并。合并顺序确定（包 → 用户 → 项目），所以项目文件可以只覆盖一个参与者，而不必重写整个名单。

```yaml
# .pi/pi-brainstorm.yaml — 只改质询者的模型，其余保持不变
participants:
  - agentName: gpt-critic-brainstormer
    model: openrouter/z-ai/glm-4.6:xhigh

  - agentName: gpt-localist-brainstormer
    disabled: true
```

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
    # 可选：每个参与者的覆盖项
    model: anthropic/claude-sonnet-4-5   # provider/id[:thinking]；省略则继承主模型
    thinkingLevel: xhigh
    timeoutSeconds: 900
    disabled: false
```

如需完全替换默认参与者，在覆盖文件中定义完整的 `participants` 列表即可。

顶层选项：

- `thinkingLevel` — 每个子进程的默认思考等级（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`）。省略则继承主 Agent 的等级。
- `childTimeoutSeconds` — 单次子进程尝试的墙钟超时（秒，默认 `900`）。`subagentTimeoutSeconds` 是旧名，仍然可用。
- `maxParallel` — 一轮中同时运行的参与者数量（默认 `4`，上限 `16`）。
- `maxRetries` — 一轮内每个参与者的重试次数（默认 `2`，即总共 3 次尝试）。
- `piBinary` — 可选，指定 spawn 子进程时使用的 pi 可执行文件。默认先解析与本扩展同装的 pi 包入口，其次查找 `PATH` 上的 `pi`。
- `extensionPath` — 覆盖附加给子进程的 pi-brainstorm 扩展路径（高级选项）。

### 参与者模型

`model` 使用 pi 自己的格式 `provider/modelId[:thinking]`，解析方式与 `pi --print --model ...` 完全一致。模型 id 可以包含 `/`（`openrouter/z-ai/glm-4.6`），所以只有第一个 `/` 用于分隔 provider。

参与者只有在 provider 具备**存储型或环境变量凭据**时才会运行。进程内（process-local）认证会被前置检查拒绝，返回 `unavailable` 并说明原因，因此一轮不会卡在无法认证的子进程上。

### 参与者运行时

每个参与者会得到一份生成的**角色简报**，写入 `.pi-meetings/<会议>/roles/<agentName>.md`，并通过 `--append-system-prompt` 传入子进程，所以角色文本进入子进程的系统提示词，而不是被粘贴进任务。简报每轮重新生成，保存在会议目录里——它不是全局 Agent 目录，也不供用户编辑。

主持人不会编写参与者的提示词、角色、模型或工具列表：它只调用 `meeting_run_round` / `meeting_run_cycle`，由本扩展构建并监管子进程。

## 前置条件

`pi-brainstorm` **没有 subagent 扩展前置条件**。它自己 spawn 并监管参与者子进程，方式是启动 headless Pi 进程：

```text
pi --print --no-session --model <provider/id> --thinking <level> \
   --append-system-prompt .pi-meetings/<会议>/roles/<agentName>.md \
   --tools read,grep,find,ls,meeting_append_entry,meeting_read_index,meeting_read_entry \
   -e <路径>/extensions/brainstorm.ts -- "<本轮任务 + 黑板说明>"
```

实际含义：

- **模型解析交给 pi 本身。** 子进程会加载你的 settings 包，因此由扩展注册的 provider（代理或自定义 provider）解析方式与主 Agent 完全一致。
- **凭据必须是存储型或环境变量。** 子进程无法读取进程内 auth 回调、浏览器登录或临时 OAuth token。可以用 `pi --list-models` 查看 `Auth` 列：只有 `stored` 和 `env` 能运行参与者。`pi-brainstorm` 会前置检查这一项，并返回 `unavailable`，不会 spawn 一个无法认证的子进程。
- **子进程受 `--tools` 约束。** 每个子进程只获得 `read`、`grep`、`find`、`ls` 以及 `meeting_append_entry`、`meeting_read_index`、`meeting_read_entry`。主持人与 lab 工具留在主 Agent 侧。
- **超时是按尝试计算的墙钟秒数**，由本扩展强制（先 SIGTERM，再 SIGKILL）。
- 项目本地安装的场景下，附加扩展在子进程中加载可能需要项目信任（project trust）。

`~/.pi/agent/agents/` 下不会安装任何内容，也不会生成 agent markdown 文件。如果你用过 `pi-brainstorm` 0.5.x，可以删除之前生成的 `*-brainstormer.md` 文件。

## 命令

```text
/brainstorm <主题>
/brainstorm-from-file <session.yaml>
/brainstorm-participants [agentName]
/debate <主题>
/debate-from-file <session.yaml>
/brainstorm-lab <主题>
```

`/brainstorm` 启动交互式三轮多 Agent 头脑风暴。Round 1 和 Round 2 结束后，主持人应停止、总结本轮，并等待你的反馈或继续许可，再进入下一轮。

`/debate` 启动开放式多 Agent battle，直到收敛或用户介入为止。

`/brainstorm-lab` 启动 v2 lab 会话，包含 artifact 跟踪、edge 图、状态管理与 context pack。

`/brainstorm-participants` 打印当前生效的参与者名单：每人一行，包含 `displayName`、`agentName`、模型（或 `inherit main model`）、思考等级、超时、是否有辩论人格，以及被墓碑移除的名字和实际加载的配置层。传入 `agentName` 可只查看某一个参与者。

### 查看可用参与者

名单是所有配置层合并后的结果，所以 `/brainstorm-participants` 是确认当前项目里到底有哪些参与者的最快方式——它包含包默认、用户级和项目级覆盖，也包含 `disabled: true` 墓碑，而且不需要启动会话。主持 Agent 也可以通过 `meeting_list_participants` 工具获取同样的数据。


## 工作方式

```text
主持人 -> meeting_run_round / meeting_run_cycle
        -> 扩展 spawn headless pi 子进程（角色简报 + 本轮任务 + --tools 白名单）
子 Agent -> 用 meeting_read_index / meeting_read_entry 读取已有条目
子 Agent -> meeting_append_entry -> .pi-meetings/... 文件
子 Agent -> 短 WROTE_ENTRY 摘要 -> 结果（ok | failed | timeout | unavailable）
文件 watcher -> 短卡片 -> 主会话可见区域
主持人 -> 每轮 checkpoint / 共识 / 分歧 / 最终综合
```

黑板文件是会话事实源。主持人可以按需读取索引或具体条目，然后生成结构化总结。

## 工具

扩展注册一整套黑板工具：

- `meeting_run_round`（仅主持人）：运行一轮头脑风暴。每个参与者作为 headless Pi 子进程并行运行，自己读取已有条目，并写入完整发言。重试在工具内部完成。
- `meeting_run_cycle`（仅主持人）：只运行一个辩论者并等待它完成，保证每个辩论者都能看到之前的全部条目。
- `meeting_list_participants`（仅主持人）：列出生效名单，包含 `agentName`、`displayName`、模型、思考等级、超时、工作工具、墓碑名单，以及产生这些结果的配置层。可用 `meetingDir` 限定到某个会话。
- `meeting_rename`（仅主持人）：在 Round 1 开始前将会议目录重命名为人类可读的标题。
- `meeting_append_entry`：把参与者完整发言写入磁盘，只返回短引用。
- `meeting_read_index`：读取条目索引，包含 id、speaker、phase、summary、path。
- `meeting_read_entry`：在主持人或参与者需要时读取某条完整发言。
- `meeting_append_artifact`、`meeting_append_edge`、`meeting_read_artifacts`、`meeting_get_state`、`meeting_update_state`、`meeting_log_event`：支撑 v2 lab 模式（artifact / edge / state 跟踪）。

参与者只获得 `read`、`grep`、`find`、`ls` 以及 `meeting_append_entry`、`meeting_read_index`、`meeting_read_entry`，其余工具保留在主持人的主 Agent 中。

运行工具会为每个参与者返回一个状态：`ok`（已写入条目，并返回 entry id 与摘要）、`failed`、`timeout`，或 `unavailable`（模型无法验证或无法认证，未 spawn 子进程）。

## 文件结构

每次会话会在当前工作目录下创建 append-only 目录：

```text
.pi-meetings/YYYY-MM-DD-topic/
  manifest.json
  index.jsonl
  blackboard.md
  roles/
    gpt-critic-brainstormer.md
  entries/
    0001-gpt-progressive-round_1.md
    0002-gpt-localist-round_1.md
```

`blackboard.md` 是完整 transcript。`index.jsonl` 是紧凑索引。参与者全文放在 `entries/`，每轮传给子进程的角色简报放在 `roles/`。

## 安全边界

扩展会校验会议路径必须留在当前工作区的 `.pi-meetings/` 下，并拒绝符号链接形式的会议目录、entry 文件、index 文件和 blackboard 文件。entry 写入使用 exclusive creation，避免覆盖已有文件。

## 迁移说明

### 0.7.0 —— 参与者改为原生 Pi 子进程

`pi-brainstorm` 0.7 不再依赖 `@narumitw/pi-subagents`。如果你只为这个包安装过它，可以卸载：

```bash
pi remove npm:@narumitw/pi-subagents
```

- 编排改用 `meeting_run_round` / `meeting_run_cycle`；本包不再使用 `subagent_spawn`、`subagent_wait`，也没有具名 Agent 目录。
- 参与者的 `model:` 重新可用，`thinkingLevel` 会传给每个子进程。
- 角色文本通过 `--append-system-prompt` 传递，不再粘贴到任务里。
- 升级后请开启新的 Pi 会话，避免残留的工具调用仍请求已移除的工具名。

### 0.6.0 —— pi-subagents v3 实验

v0.6 面向 `@narumitw/pi-subagents` **v3**：没有 `subagent` 工具、没有具名 Agent 目录、不能按任务指定模型、也不能自定义系统提示词。该实验已回退；保留这段说明只是为了处理仍含有那些工具调用的历史会话。

## 开发

```bash
npm pack --dry-run
```

该扩展由 pi 的扩展加载器直接加载 TypeScript。运行时从 pi 引入的 `@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` 和 `typebox` 按 pi package 规范声明为 peer dependencies。

## License

MIT
