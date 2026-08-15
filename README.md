# @deepslateqaq/omp-dsh-minimal

Oh My Pi 扩展：为 DeepSeek-V4 模型启用 DeepSeek Harness 的「极简模式」提示词，激活 V4 系列模型的隐藏脑子。

启用插件后，插件会在检测到 Flash/Pro 模型后按照设置替换提示词，并限制第一次工具调用的工具列表，以达到激活效果。
被禁用的工具会在第一次工具调用后结束。

> **关于 DeepSeek-V4-Flash 启用 omp-dsh-minimal**
>
> 本插件虽然专为 DeepSeek-V4-Pro 设计，但实际测试中发现 DeepSeek-V4-Flash 在「极简模式」下也有较大提升，且会出现
> 类似于 DeepSeek-V4-Pro 激活后的 CoT 风格。原因未知。

## 安装

用 OMP 自带的插件管理从 npm 安装：

```sh
omp plugin install @deepslateqaq/omp-dsh-minimal
```

安装后重启会话，扩展模块才会加载；用 `omp plugin list` 可查看已安装插件。

## 命令

- `/dsh-minimal`：交互式菜单，按模型配置开关、提示词、工具和恢复时机
- `/dsh-minimal status`：查看两个模型的当前配置
- `/dsh-minimal flash on|off` / `/dsh-minimal pro on|off`：切换模型门控
- `/dsh-minimal reset`：恢复环境默认

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `DSH_MINIMAL_DISABLE=1` | 完全禁用 |

其余配置通过 `/dsh-minimal` 菜单按 flash / pro 分别调整。

## 开发

```sh
bun test
```

## License

[GPL-3.0](./LICENSE)
