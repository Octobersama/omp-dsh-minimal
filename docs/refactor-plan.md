# index.ts 重构计划

> 基于代码质量审查（code-review-maintainability）发现的两个 P0 + 两个 P1 问题。
> 目标：行为不变的前提下，删除死代码、分解上帝函数、收紧类型边界。
> 每阶段完成后跑 `bun test`，通过后单独提交。

## 现状

- `index.ts` 987 行，`dshMinimal` 函数独占 ~768 行。
- roster 三档（base/mid/full）在 K1 固定 `MINIMAL_TOOL_PAIR` 后已是死代码。
- 3 个工具注册、状态机、持久化、TUI 命令四类职责内联在一个函数里。
- 23 处 `any` 掩盖类型契约。

## 阶段 1：删除 roster 三档死代码（最小风险、最大收益）

**目标**：删除整个「base/mid/full」概念。

改动：
- 删 `DEFAULT_MINIMAL_TOOLS`、`BASE_TOOLS`、`MID_TOOLS`。
- 删 `PresetMode`、`RosterTier` 类型。
- `PRESETS` 删 `tools` 字段，只保留 `prompt`（6 个 mode 仍兼容 `DSH_MINIMAL_MODE`）。
- 删 `seedRoster` 及 `cfg[kind].tools.roster = seedRoster`。
- 删 `DshModelConfig.tools.roster` 字段、`defaultModelConfig` 的 `roster`、`restoreConfigFromSession` 的 roster 恢复。
- 删 `/dsh-minimal` 菜单「OMP 扩展工具（full/base/mid）」选项。
- 测试：删 `PRESETS` describe、roster tiers 断言，改 `readCsv` 测试的 fallback。

验证：`bun test` 全绿。

## 阶段 2：抽出工具注册到 `tools.ts`

**目标**：3 个工具注册 + str_replace_editor 执行器脱离 `dshMinimal`。

改动：
- 新建 `tools.ts`：导出 `registerMinimalTools(pi, hooks)`，内含 3 个 `registerTool`。
- `str_replace_editor` 的 execute switch-case 抽成纯函数 `executeStrReplaceEditor(params, cwd)`。
- 描述常量（`MINIMAL_BASH_DESCRIPTION`、`STR_REPLACE_EDITOR_DESCRIPTION`、`DEV_TOOL_UNLOCKABLE_INDEX`、`MINIMAL_TOOL_PAIR`、`RESIDENT_DISCOVERY_TOOLS`、`COMPACTION_TOOLS`、`INIT_ANCHOR_PROMPT`）随工具一起移到 `tools.ts`。
- `dshMinimal` 改为 `registerMinimalTools(pi, { onUnlock })`，`unlockedTools` 状态留在主函数、通过 hook 回调。

验证：`bun test` 全绿（测试 import 改为从 `tools.ts`）。

## 阶段 3：抽出状态机

**目标**：`anchoring`/`compacted`/`wasRestricted` 三个布尔 + 转换集中到一个 `AnchorState`。

改动：
- 新建轻量状态对象（或直接在主函数内聚合成一个可读的状态块）。
- 事件处理器只调用状态对象的转换方法（如 `state.promote()`、`state.compact()`），不再散落裸布尔赋值。

验证：`bun test` 全绿。

## 阶段 4：抽出 TUI 命令到 `command.ts`

**目标**：`/dsh-minimal` 巨型菜单 + `/dsh-init` 脱离 `dshMinimal`。

改动：
- 新建 `command.ts`：导出 `registerCommands(pi, ctx)`，内含两个命令。
- `/dsh-minimal` 的三层嵌套 `for(;;)` 菜单（promptMenu/toolsMenu/modelMenu）独立成函数。

验证：`bun test` 全绿。

## 阶段 5：收紧类型边界 + 处理 dshUserInjection 语义

改动：
- 三个工具定义显式参数 interface（`BashParams`、`StrReplaceEditorParams`、`DevToolSearchParams`），`execute` 用窄化断言替代全程 `any`。
- `getAllTools` 包一层显式返回类型。
- 处理 `dshUserInjection`/`context` 注入/`firstTurnArmed`/`userMessageInjected`：默认 false 且与「仅手动锚定」语义冲突，评估后删除或重定义触发点。

验证：`bun test` 全绿。

## 完成标准

- `index.ts` 从 987 行显著下降（目标 < 500 行）。
- 每个新模块职责单一、可独立扫描。
- 行为不变（端到端锚定 + 解锁链路回归测试仍通过）。
- 每阶段独立提交，`git log` 可追溯。
