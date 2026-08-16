# DeepSeek V4 过拟合缓解：问题分析与改进规划

> 状态：分析 / 规划阶段，**尚未开工**
> 日期：2026-08-16
> 参考实现：`参考/dsh-anchored-standard`（已实测验证的 DeepSeek Harness preset）

---

## 1. 结论摘要

1. 两个插件都在解决 DeepSeek-V4 系列的过拟合问题：`dsh-anchored-standard` 是 DSH 生态、经实测验证的 preset；`omp-dsh-minimal` 是 OMP 生态的简单模仿。
2. 缓解过拟合的**决定性关键点**只有少数几个，且权重悬殊（见 §2）。`omp-dsh-minimal` 遗漏了其中最关键的几个。
3. 经源码验证，OMP 的 `ExtensionAPI` **具备修复这些关键点的能力**（`registerTool` 可自定义工具 schema、`before_agent_start` 可改写 system prompt、`setActiveTools` 可控工具集）。方案可行，但有一个能力边界需实施时验证（§5、§7）。
4. **Shell 线（bash vs pwsh vs WSL）是"非问题"**，已排除（§4）：OMP 的 `bash` 工具是随包自带的 brush 内嵌引擎，天然 bash 语义，与 WSL、pwsh 均无关。

---

## 2. 缓解过拟合的关键点（来自 dsh-anchored 的实证）

| # | 关键点 | 实证依据 | 权重 |
|---|---|---|---|
| **K1** | **首请求工具 schema 身份**必须是官方 Minimal 那 2 个（`bash` + `str_replace_editor`） | issue #11：该 schema 在 adapter 默认 maxTokens(256000) 下 5/5 锚定（`we` 轨迹、`let me`=0）；任何 standard 系 schema（pwsh/read 等）11/11 落入 standard-like | **决定性** |
| **K2** | **剥离自动注入的上下文**（skill-catalog + agent-instructions） | issue #6：技能目录存在时 0/9 锚定，剥离后 ~81% | **决定性** |
| **K3** | **晋升后不 dump 全量工具**（resident set + 按需解锁） | 全量 25 工具 dump 会把轨迹拉回 standard-like（"后晋升回归"） | 高 |
| **K4** | 首请求输出预算 `maxTokens` | 1024 时也是主导变量（26/32 vs 0/5），但 Minimal schema 在 256000 无需 cap | 次要 / opt-in |
| **K5** | `promoteOn: either`（纯文字首答不困死） | 语义安全 | 低 |
| **K6** | 状态持久化 + compaction epoch | resume/reload 不丢阶段 | 低（健壮性） |

一句话：**K1 + K2 决定"首请求能不能锚定"；K3 决定"锚定后会不会掉回去"。** 其余是锦上添花。

---

## 3. omp-dsh-minimal 的问题清单（逐条）

### 问题 1（K1，决定性）—— 首请求工具 schema 身份未对齐 ❌

- 默认 roster 是 `full` = **24 个 OMP 内置工具**。首请求看到的是近乎全量工具，正落在 issue #11 里"standard-family schema 11/11 失败"的那一侧。
- 即便手动切 `base` 档（`bash, read, write, edit`，4 个），也**不是**官方 Minimal 的 `bash` + `str_replace_editor`：
  - `str_replace_editor` 在 OMP 生态**没有对应物**，用 `read/write/edit` 顶替，schema 身份变了；
  - 工具**描述文本**也不同 —— issue #11 强调锚定的是"schema 的字节级身份"（名称 + 描述 + 参数），不是"几个看起来相似的工具"。
- 结论：本插件从未复刻那 2 个工具的 schema，K1 从头没做对。

### 问题 2（K2，决定性）—— 无显式剥离 + 反向注入 ⚠️

- ✅ 对的：`ompRules: false`、`contextFiles: false`（默认不附加 `<generic-rules>` / `<repo-rules>`）。
- ❌ 缺失：**没有显式剥离逻辑**。OMP 宿主会向 system prompt 注入 `<available_skills>`（技能目录）和 AGENTS.md/CLAUDE.md 等 blocks，`omp-dsh-minimal` 只是"自己不附加"，**没有删除宿主已注入的 blocks**。
- ❌ 反向：`dshUserInjection: true`（默认开启）会**额外**在首条 user 消息前塞 `<<<dsh-minimal>>>` 标记块。DSH 版的做法是"只减不增"（剥离注入、绝不加注入），OMP 版方向相反。

### 问题 3（K3，高）—— 晋升后全量 dump ❌

- `restoreFullRoster` 在首次工具调用 / 首轮结束后**恢复全量工具**（含 MCP）。
- 这正是 dsh-anchored 实测发现的"后晋升回归"根因：全量 dump 会把轨迹拉回 standard-like。
- 没有 resident set 概念，没有 `dev_tool_search` 按需解锁。等于"首轮装样子 → 立刻全量"，前功尽弃。

### 问题 4（K4，次要）—— 无 maxTokens 旋钮 ❌

- 代码与 env 里没有任何输出预算控制。

### 问题 5（K5，低）—— promoteOn 语义 ⚠️

- `timing: first-agent-turn` 能避免"纯文字首答困死"，但默认值 `first-tool-call` 仍有困死风险；没有 `either` 语义。

### 问题 6（K6，低）—— 状态易失 + compaction 粗粒度 ⚠️

- 状态是内存布尔量，resume/reload 会丢；`session_compact` 只是粗粒度重置，没有 epoch 感知的"compaction 后核心工作集"。

---

## 4. Shell 线澄清（已排除，非问题）

用户曾担心"Windows 上用 bash 而非 pwsh / 用 WSL bash 会造成干扰"。经源码验证（`pi-shell-windows.rs`、`pi-shell-src.rs`、`pi_natives.win32-x64-baseline.node`）：

- OMP 的 `bash` 工具执行引擎是**随包自带的 brush 内嵌 bash 引擎**（Rust 实现，vendored brush-shell fork，模拟 GNU bash 5.2），**进程内执行，零 fork/exec**。
- 它**不查 PATH 上的 `bash.exe`**，所以系统里指向 WSL launcher 的 `WindowsApps\bash.exe` 完全不在执行链路上。
- `pi-shell-windows.rs` 只通过「注册表 `GitForWindows` + `where git`」找到 Git for Windows，把 `bin` 目录注入 brush 的 PATH（供 ls/sed/grep 等 MSYS2 工具用），与 WSL 无关。
- brush 会主动过滤 `BASH_VERSION`/`SHELL` 等外部 bash 环境变量，进一步隔离宿主 WSL 环境。

**结论：Shell 线从执行引擎到 PATH 注入都是自带 brush bash，WSL/pwsh 干扰不存在。无需任何改动。** 真正要补的是 K1 的"工具 schema 文本对齐"，而非"换成 bash"。

---

## 5. OMP ExtensionAPI 能力边界（研究结论）

来源：`sdk.ts`（`@oh-my-pi/pi-coding-agent`）+ 本插件 `index.ts` 已用 API。

| 能力 | API | 对方案的意义 |
|---|---|---|
| 注册自定义工具（含自定义 `description` + `parameters` + `execute`） | `api.registerTool(customToolToDefinition(tool))`，`CustomTool` 含 `name/label/description/parameters/strict/execute/hidden` | **K1 可行**：可注册 schema 与 DSH Minimal 逐字节一致的工具 |
| 按名字开关工具集 | `api.setActiveTools(names)` / `api.getActiveTools()` | **K1/K3 可行**：控制首轮与晋升后的工具集 |
| 改写 system prompt | `before_agent_start` 事件可 `return { systemPrompt: [...] }`（blocks 数组） | **K2 可行**：可过滤/剥离注入的 blocks |
| 改写消息列表 | `context` 事件可 `return { messages: [...] }` | K2 辅助 |
| 持久化状态 | `api.appendEntry(type, data)` + `ctx.sessionManager.getBranch()` | **K6 可行**：可持久化 config 与解锁状态 |
| 事件钩子 | `session_start/input/before_agent_start/tool_call/turn_end/session_compact/context/session_switch` | 阶段机驱动 |
| 注册命令 | `api.registerCommand(...)` | TUI 菜单 |

**待验证的能力边界（实施前必须确认）**：
1. `registerTool` 注册**同名 `bash`** 工具时，是覆盖内建工具还是冲突报错？若冲突，需改为"隐藏内建 bash + 注册自定义 bash（execute 委托内建）"。
2. `before_agent_start` 的 `event.systemPrompt` blocks 的具体结构：`<available_skills>`（技能目录）和 AGENTS.md/CLAUDE.md 各自对应哪个 block / 什么标识，以便精确剥离。
3. OMP 是否有等价于 DSH `agent/pre-step` 的"剥离已注入消息"钩子；若无，K2 的剥离只能作用于 system prompt blocks（可能已足够）。

---

## 6. 最优解决方案规划

### 方案总纲

对齐 dsh-anchored 的三段式，但适配 OMP 的 API 形态：

```
首请求：只暴露 2 个 schema 对齐的工具（bash + str_replace_editor）+ 剥离自动注入的 system prompt blocks
   ↓ 首个晋升信号（tool_call 或首条 assistant message，either）
晋升后：resident set（bash + str_replace_editor + 发现工具）+ 按需解锁，而非全量 dump
```

### P0 —— 对齐 K1（工具 schema 身份）【最高优先】

1. 用 `registerTool` 注册 2 个自定义工具，`description` + `parameters` 与 DSH Minimal 逐字节对齐：
   - `bash`：描述采用 DSH Minimal 的 persistent bash 描述（"Run commands in a bash shell / State is persistent across command calls…"）；`execute` 委托给 OMP 内建 bash 执行器（或直接调用）。
   - `str_replace_editor`：复刻 DSH Minimal 第二个工具（描述 + 参数 schema）；OMP 无此原语，需自行实现一个基于 `read`/`edit`/`write` 的等价执行器，**schema 文本对齐、执行语义近似**。
2. 首轮 `before_agent_start`：`setActiveTools(["bash", "str_replace_editor"])`，只暴露这 2 个。
3. 关键前置验证：`registerTool` 同名 `bash` 的覆盖/冲突行为（§5）。

### P0 —— 对齐 K2（显式剥离自动注入）

1. 首轮 `before_agent_start`：从 `event.systemPrompt` blocks 里**过滤掉** `<available_skills>`（技能目录）和 AGENTS.md/CLAUDE.md 注入 block。
2. **关闭 `dshUserInjection`**（默认改为 `false`），去掉反向注入的标记块。
3. 晋升后：恢复这些 blocks（对齐 DSH"从 request #2 恢复"）。
4. 前置验证：确认 system prompt blocks 里技能目录 / 指令文件的具体标识（§5）。

### P0 —— 对齐 K3（晋升后 resident set + 按需解锁）

1. 晋升后**不再 `restoreFullRoster`**，而是维持 resident set：`bash` + `str_replace_editor` + 一个发现工具。
2. 注册一个 `dev_tool_search` 类似的工具：按关键字搜索完整目录、按名解锁，解锁结果持久化（`appendEntry`），下次请求生效。
3. 状态从"内存布尔量"改为"可持久化"，支持 resume/reload（对齐 K6）。

### P1 —— 次要项

- **K4**：加 `bootstrapMaxTokens` 可选 env/config（供对照实验）。
- **K5**：`timing` 默认改为 `either` 语义（tool-call 或 assistant-message 先到者）。
- **K6**：compaction 后回到受控阶段 + 一个核心工作集（而非粗粒度重置）。

### 不做（YAGNI）

- 不重做 shell 线（§4，已证明非问题）。
- 不引入 DSH 的 cordis/`isolate` realm 那套架构 —— OMP 的事件钩子模型已够用，DSH 的 realm 是 DSH 特有的。

---

## 7. 实施顺序与风险

### 顺序

1. **验证能力边界**（§5 三项待确认）—— 这是阻塞项，决定 K1/K2 的具体实现方式。
2. **P0-K1**：注册 2 个 schema 对齐工具 + 首轮只暴露这 2 个。
3. **P0-K2**：剥离自动注入 + 关闭反向注入。
4. **P0-K3**：resident set + dev_tool_search 按需解锁 + 状态持久化。
5. **P1**：K4/K5/K6 补齐。

### 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| `registerTool` 不能覆盖内建 `bash` | K1 阻塞 | 改"隐藏内建 + 注册自定义 bash（委托执行）"；或确认是否有修改工具 schema 的 API |
| 无法精确识别/剥离技能目录与指令文件 block | K2 打折 | 先探明 block 结构；降级为"仅关闭 dshUserInjection + 保留 ompRules/contextFiles=false" |
| `str_replace_editor` 执行语义无法完全复刻 | K1 第二工具近似 | schema 文本对齐优先（锚定靠 schema），执行语义用 read/edit/write 近似 |
| 锚定效果在 OMP 上无法复现 | 方案整体 | 需对照实验（`verify` 类脚本导 JSONL 检查首请求 header），用 K4 maxTokens 旋钮做对照 |

---

## 8. 策略 A 验证结果（实测，2026-08-16）

### 实验设计

固定变量：同一编码任务 prompt + deepseek-v4-pro + reasoningEffort=max + 非交互 `omp -p`。
唯一变量：工具 schema 与 system prompt。

### 三组数据对比

| 指标 | baseline（24 工具 + 完整 SP） | K1（2 工具 + 完整 SP） | K1+K2（2 工具 + 极简 SP） |
|---|---|---|---|
| 首行 | "The task is simple…" | "The user wants me to…" | **"We need create…"** |
| `we` | 0 | 0 | **5** |
| `let's` | 0 | 0 | **1** |
| `let me` | 1 | 1 | **0** |
| thinking 词数 | 28 | 36 | 75 |

### K1+K2 首请求 thinking 全文（锚定铁证）

```
We need create fib.py in current directory, print first 10 Fibonacci numbers using a Python function, run it and confirm output. We need use tools. Let's check directory first maybe pwd and ls. Then create file. We can use bash or editor. Use str_replace_editor create. Then run python. Need to be careful Fibonacci first 10: usually 0,1,1,2,3,5,8,13,21,34. We'll make function returns list or prints. The file should print them using function. We'll run and confirm.
```

### 加固验证（3 次样本，确认稳定性）

同一 prompt + 同一 K1+K2 配置再跑 2 次，共 3 次样本：

| 样本 | 首行 | `we` | `let's` | `let me` | 词数 |
|---|---|---|---|---|---|
| 1 | "We need create fib.py…" | 5 | 1 | 0 | 75 |
| 2 | "We need to create fib.py…" | 2 | 1 | 0 | 36 |
| 3 | "We need create fib.py…" | 2 | 0 | 0 | 44 |

**3/3 全部锚定**：首行均为 "We need…"、`we` ≥ 2、`let me` = 0。对比 baseline 与 K1 均失败（`let me`=1、`we`=0、首行 standard-like），锚定稳定成立。

### 结论

1. **机械层 ✅**：K1 生效，首请求工具从 281 → 2（`bash` + `str_replace_editor`）。
2. **K1 单独 ❌**：只改工具 schema、不剥离 system prompt，仍是 standard-like（"The user wants me to…"）。
3. **K1+K2 联合 ✅**：2 工具 + 剥离 system prompt 到 DSH persona 极简，成功锚定（"We need" + `we`=5 + `let me`=0）。
4. **核心结论**：OMP 上能复现 DSH 的锚定效果，且 **K2（剥离 system prompt）是必要条件**——精确印证 dsh issue #6（有上下文注入 0/9 锚定，剥离后 ~81%）。

### 对方案的影响

- 假设成立，策略 A 验证通过，可进入完整实现。
- **修正优先级**：K2 不是"可选的次要项"，而是与 K1 同级的决定项。
- 发现 OMP 的 system prompt 是一个 **58927 字符的巨型块**（含 `<system-conventions>` + AGENTS.md + role/policy），剥离它到 DSH persona 极简是锚定的关键。
- 已跑 3 次样本确认稳定性（3/3 锚定），可进入完整实现。

## 9. 完整实现（2026-08-16）

### 实现内容（全部落在 `index.ts` + `test/index.test.ts`）

| 关键点 | 实现 |
|---|---|
| K1 | `registerTool` re-register `bash`（description 逐字节对齐 DSH Minimal + `invokeTool` 委托内建执行）+ 注册 `str_replace_editor`（node:fs 实现）；首轮 `rosterFor` 固定 `MINIMAL_TOOL_PAIR` |
| K2 | `before_agent_start` 首轮返回 `[DSH_PERSONA]`（剥离 58927 字符巨型 SP）；`dshUserInjection` 默认 `false` |
| K3 | `dev_tool_search` 工具（搜索 + 解锁 + `unlockedTools` 持久化 + `DEV_TOOL_UNLOCKABLE_INDEX` 索引）；晋升后 `restoreFullRoster` → `residentSet()`（bash + str_replace_editor + dev_tool_search + 已解锁），不再全量 dump |
| K6 | `COMPACTION_TOOLS` 核心工作集 + `compacted` 状态；compaction 后给 Minimal 工具对 + 核心工作集（read/write/edit/glob/grep/todo/ask） |
| 状态持久化 | `STATE_ENTRY_TYPE` + `persistState`/`restoreStateFromSession`；unlockedTools / 晋升 / compaction 状态 resume/reload 恢复 |
| 清理 | `fullTools`/`mergeIntoSnapshot` 死代码 → `wasRestricted` 布尔标志 |

### 验证状态

- `bun test`：149 pass, 0 fail。
- 端到端（`--extension index.ts` 跑 fib.py）：首行 "We need…"、`we`=2~4、`let me`=0，锚定成功，与验证脚本 3/3 结果一致；K6 + 状态持久化改动后回归测试仍锚定（`we`=3~4、`let me`=0）。
- K3 冒烟：晋升后模型连续 6 次 `bash` 调用完成多轮任务，未出现全量工具 dump，工具在 resident set 范围内。
- K3 解锁链路实测：**已跑通**。编码任务（crypto_price.py + 联网查 API）下，模型首轮锚定（"We need" + `we`=11 + `let me`=0）、调 bash×3，晋升后主动调 `dev_tool_search`（`query` + `toolNames:["web_search"]`）解锁联网。触发条件是**编码/动手型任务**（首轮调工具进入多轮 loop 才晋升）；纯信息查询任务首轮（2 工具、无 dev_tool_search）就直接文字回答「不能联网」结束，本就不走解锁流程。附带发现：锚定是任务类型相关的（编码任务锚定 "We need"，信息查询任务仍是 standard-like）。
- K4（maxTokens 旋钮）：**放弃**。OMP 无现成的首请求输出预算设置机制（config 仅有 `hindsight.recallMaxTokens`，与首请求无关；`before_provider_request` 改 payload 理论可行但 payload 结构未知）。且 dsh 实证已明确 Minimal schema 在 adapter 默认 maxTokens 下无需 cap 即可锚定——OMP 已用 Minimal schema 锚定，K4 的"对照实验"价值不足以匹配实现成本。

## 附：关键证据索引

- `dsh-anchored-standard` 实证：README「Results」「Why」、`preset/tool-bootstrap.mjs` 头部注释（issue #6/#11）。
- OMP shell 源码：`pi-shell-windows.rs`、`pi-shell-src.rs`（brush 引擎）、`sdk.ts`（`registerTool`/`customToolToDefinition`）。
- 本插件现状：`index.ts`（`DEFAULT_MINIMAL_TOOLS`、`restoreFullRoster`、`dshUserInjection`、`turn1PromptFor`）。
