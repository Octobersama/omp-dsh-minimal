# PRDBench 测试任务状态（中断，待续跑）

> 更新：2026-08-17。测试因 API 余额/连接中断，记录当前状态供以后重跑。

## 背景

用 PRDBench 题目（真实复杂软件项目）验证「omp-dsh-minimal 默认自动锚定」对任务完成质量的影响。之前三道简单题机械验收几乎都满分、无区分度，换成 PRDBench 后能拉开差距。

## 方案

- **题目**：PRDBench 题目 1-30（餐厅供应链 / 美股分析 / 套餐管理 / 数据预处理 / Huffman 等，均为「从零构建 Python 系统」）。
- **配置**：2 个 —— A 无插件（`--no-extensions`）、B 插件+init（`-e index.ts` + prompt 前拼 `INIT_ANCHOR_PROMPT`）。
- **轮次**：每题目每配置 1 轮 = 30 × 2 = 60 轮。
- **验收**：完整验收（`detailed_test_plan.json` 的 unit_test + shell_interaction + file_comparison），关键词启发式近似 Agent-as-a-Judge。
- **统计口径**：剔除每配置总分 min/max 各 1。
- **环境隔离**：venv（`.venv`）+ 显式 `--model deepseek-v4-pro` + `--auto-approve` + session workarea 过滤，与宿主机 omp 配置/Python 互不干扰。

## 当前进度（6 轮有效，54 轮未跑）

| 配置 | 题目 | we | letme | anchored | 机械分 |
|---|---|---|---|---|---|
| A | 1 | 0 | 1 | ❌ | 1/20 |
| B | 1 | 2 | 0 | ✅ | 17/20 |
| A | 2 | 0 | 1 | ❌ | 17/24 |
| B | 2 | 2 | 0 | ✅ | 17/24 |
| A | 3 | 0 | 1 | ❌ | 0/23 |
| B | 3 | 0 | 1 | ❌ | 0/23 |

初步观察：A 稳定不锚定（we=0/letme=1），B 在题目 1-2 锚定（we=2/letme=0）、题目 3 未锚定（随机性）。机械分差距任务相关（题目 1 差距大 1 vs 17，题目 2 无差距，题目 3 都失败）。样本太小，不足以定论。

## 中断原因

1. API 余额不足（`402 Insufficient Balance`）——题目 3 起全部失败。
2. 充值后重试，又遇 `cli-proxy-api` 被停止（`Cannot connect`）——题目 3 B 卡住。
3. 用户 token 用完，主动停止（跑完题目 3 的 A/B 后）。

## 数据 / 脚本位置（仓库 `omp-dsh-bench`）

| 项 | 路径 |
|---|---|
| 有效数据 | `results/results_prd.csv`（6 轮） |
| 产出留存 | `results/artifacts/<配置>-<题目>/`（src/tests/README） |
| 题目 | `tasks/prd/1..30/`（PRD.md + evaluation/，已从 PRDBench 复制） |
| 单轮脚本 | `run_round_prd.ps1`（复制→omp→提取→验收→记录→保留产出） |
| 验收脚本 | `verify_prd.mjs`（关键词启发式 + pytest） |
| 提取脚本 | `extract.mjs`（锚定词 + anchored 布尔） |
| 批量脚本 | `run_all_prd.ps1`（30 题×A/B）、`run_retry2_prd.ps1`（题目3B 起） |
| 隔离环境 | `.venv/`（pytest + pandas + numpy + openpyxl + matplotlib） |
| 参考基准 | `../PRDBench/`（原始 50 题 + 评测框架） |

## 重跑方法

```powershell
# 1. 确认 API 有余额 + cli-proxy-api 正常（端口 8317 监听）
# 2. 续跑剩余轮次（题目 3B 起，共 55 轮）
$bench = "C:\Users\35181\Documents\Work\omp-dsh-bench"
Start-Process -FilePath "pwsh.exe" `
  -ArgumentList "-NoProfile","-File","$bench\run_retry2_prd.ps1" `
  -WorkingDirectory $bench -WindowStyle Hidden
# 3. 查进度
Get-Content "$bench\results\run_retry2.log" -Tail
# 4. 全部完成后，补主观分（读 results\artifacts\ 代码）+ 统计报告
```

若要全部重跑（含题目 1-2），用 `run_all_prd.ps1` 并先清空 `results_prd.csv`。

## 待办（续跑后）

- 主观分：读 `results/artifacts/` 逐份打分（50 分）。
- 统计：按配置汇总机械分 + 主观分，剔除 min/max，对比 A vs B。
- 报告：`report.md`。
