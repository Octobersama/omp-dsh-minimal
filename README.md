# omp-dsh-minimal

> 本仓库 fork 自 [@deepslateqaq/omp-dsh-minimal](https://github.com/deepslateqaq/omp-dsh-minimal)（原版），在此之上实现了「默认自动锚定」机制。

Oh My Pi 扩展：为 DeepSeek-V4 模型启用 DeepSeek Harness 的「极简模式」。通过首轮「剥离 system prompt + 2 工具」触发 V4 系列的「We need」协作式思维链（锚定），晋升后恢复能力并按需解锁工具。

## 与原版的区别（fork 改动）

- **默认自动锚定**：新 session 未晋升时自动进入锚定轮（首请求 2 工具 + 剥离 system prompt），无需手动触发；原版仅 `list files` 预热、且默认不锚定。
- **dev_tool_search 仅晋升后开放**：按需解锁工具，避免「后晋升回归」（全量工具 dump 会把轨迹拉回 standard-like）。
- **`/dsh-init` 改为动手型预热**：写-读-删闭环（`.dsh-anchor-check.txt`），触发 we 锚定且不干扰项目资产；原版是「list files」信息查询型，不锚定。
- **删除 `dshUserInjection`**：反向注入 DSH 块的功能（与「只减不增」精神相悖）。
- **代码重构**：拆分 `tools.ts` / `command.ts`，删除 roster 三档死代码，状态持久化（`unlockedTools` / `promoted` / `compacted`）。

## 工作原理

三段式（对齐 dsh-anchored-standard 的 anchor → promotion → resident catalog）：

1. **锚定（首请求）**：session 开始未晋升时 `anchoring=true`，首请求暴露 2 工具（`bash` + `str_replace_editor`）+ 剥离 system prompt 到 DSH persona（`You are a helpful software engineer assistant.`）→ 触发「We need」协作式轨迹。
2. **晋升（首条工具调用）**：首个 durable 工具调用后，恢复完整 system prompt + resident set（`bash` + `str_replace_editor` + `dev_tool_search` + 已解锁）。
3. **按需解锁**：`dev_tool_search` 按关键字搜索完整工具目录、按名解锁，解锁结果持久化（resume/reload 恢复）。

## 实测效果

### 三道简单题（从零构建 / 修 bug / 重构，每配置 12 轮剔除 min/max 后 10 轮）

| 配置 | 锚定率 | avg we | avg let me |
|---|---|---|---|
| 无插件（baseline） | 0% | 0.3 | 2.7 |
| 插件（默认自动锚定） | 90% | 1.1 | 0.1 |

- **锚定率大幅提升**：0% → 90%，`let me` 从 2.7 降到 0.1。
- **分数无明显变化**：机械验收几乎满分（35/36），主观分接近（45.6~46.5）——锚定改变的是「轨迹形态」，而非「产出质量」。

### 新题（PRDBench，因 token 不足只测了前 3 题，样本量太小）

| 题目 | 无插件机械分 | 插件机械分 |
|---|---|---|
| 1 餐厅供应链 | 1/20 | 17/20 |
| 2 美股分析 | 17/24 | 17/24 |
| 3 套餐管理 | 0/23 | 0/23 |

题目 1 上插件（锚定）机械分 1 → 17 差距显著；题目 2 无差距；题目 3 都失败。**样本量太小（共 6 轮），不能说明问题**，需充值后续跑剩余 54 轮（续跑方法见 `docs/prdbench-test-status.md`）。

## 安装

```sh
# 从本仓库源码安装（fork 版）
git clone https://github.com/Octobersama/omp-dsh-minimal.git
omp plugin link ./omp-dsh-minimal
```

安装后重启会话生效；`omp plugin list` 查看已安装插件。

> 如需原版（无默认自动锚定），用 `omp plugin install @deepslateqaq/omp-dsh-minimal`。

## 命令

- `/dsh-minimal`：交互式菜单，按模型配置开关 / 提示词 / 工具 / 恢复时机
- `/dsh-minimal status`：查看两个模型的当前配置
- `/dsh-minimal flash on|off` / `pro on|off`：切换模型门控
- `/dsh-minimal reset`：恢复环境默认
- `/dsh-init`：触发锚定轮（动手型预热：写-读-删 `.dsh-anchor-check.txt`，触发 we 锚定 + 晋升）

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `DSH_MINIMAL_DISABLE=1` | 完全禁用 |

其余配置通过 `/dsh-minimal` 菜单按 flash / pro 分别调整。

## License

[GPL-3.0](./LICENSE)（与原版相同）
