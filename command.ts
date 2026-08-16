/**
 * command.ts — DSH Minimal 的 TUI 命令（/dsh-minimal 配置菜单 + /dsh-init 锚定轮）。
 * 从 index.ts 抽出：依赖通过 CommandDeps 注入，不直接访问主函数内部状态。
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { DshConfig, DshModelConfig, ModelKind, RestoreTiming, SuffixPlacement, SystemInjection } from "./index";

/** 命令对主函数状态的依赖（index.ts 构造并传入）。 */
export interface CommandDeps {
	pi: ExtensionAPI;
	cfg: DshConfig;
	/** 是否正在锚定轮内。 */
	isAnchoring(): boolean;
	/** 新建默认模型配置。 */
	newConfig(): DshModelConfig;
	/** 应用配置并同步工具集。 */
	apply(kind: ModelKind): Promise<void>;
	/** 从 system prompt blocks 提取通用规则。 */
	extractGenericRules(blocks: string[]): string | undefined;
	/** 判断模型 kind（flash/pro）。 */
	modelKindOf(modelId: string | undefined): ModelKind | undefined;
	/** 触发锚定轮（设置 anchoring + 发送预设提示词）。 */
	initAnchor(): void;
}

export function registerCommands(deps: CommandDeps): void {
	const { pi, cfg, newConfig, apply, extractGenericRules, modelKindOf, isAnchoring, initAnchor } = deps;

	pi.registerCommand("dsh-minimal", {
		description: "DSH Minimal：按模型配置（开关/提示词/工具/重置）",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const notify = (text: string): void => {
				ctx.ui.notify(`[dsh-minimal] ${text}`, "info");
				pi.logger.info(`[dsh-minimal] command: ${text}`);
			};
			const pick = async (
				title: string,
				items: Array<{ label: string; description?: string }>,
			): Promise<string | undefined> =>
				ctx.ui.select(title, items, { helpText: "↑↓ 选择，Enter 确认，Esc 取消" });

			const describe = (m: DshModelConfig): string =>
				[
					m.enabled ? "开" : "关",
					`注入=${m.prompt.dshSystemInjection}`,
					`用户注入=${m.prompt.dshUserInjection ? "on" : "off"}`,
					`后缀=${m.prompt.ompSuffix}`,
					`规则=${m.prompt.ompRules ? "on" : "off"}`,
					`上下文=${m.prompt.contextFiles ? "on" : "off"}`,
					`MCP=${m.tools.mcp ? "on" : "off"}`,
					`时机=${m.tools.timing}`,
				].join(" | ");

			// Argument form: status / flash|pro on|off / reset.
			if (parts[0] === "status") {
				notify(`flash: ${describe(cfg.flash)} | pro: ${describe(cfg.pro)}`);
				return;
			}
			if ((parts[0] === "flash" || parts[0] === "pro") && (parts[1] === "on" || parts[1] === "off")) {
				const kind = parts[0] as ModelKind;
				cfg[kind].enabled = parts[1] === "on";
				notify(`${kind} 门控 ${cfg[kind].enabled ? "开启" : "关闭"}`);
				await apply(kind);
				return;
			}
			if (parts[0] === "reset") {
				cfg.flash = newConfig();
				cfg.pro = newConfig();
				notify("已重置为环境默认");
				await apply(modelKindOf(ctx.model?.id) ?? "flash");
				return;
			}

			// Esc closes the current dialog; 返回 walks up one level.
			const hasGenericRules = (): boolean =>
				extractGenericRules(ctx.getSystemPrompt()) !== undefined;

			const promptMenu = async (kind: ModelKind): Promise<void> => {
				const label = kind === "flash" ? "Flash" : "Pro";
				const m = cfg[kind];
				for (;;) {
					const sub = await pick("提示词设置", [
						{ label: "DSH 系统注入", description: `首轮系统提示词：当前 ${m.prompt.dshSystemInjection}` },
						{ label: "DSH 用户注入", description: `首条 user 消息前注入 DSH 块：当前 ${m.prompt.dshUserInjection ? "on" : "off"}` },
						{ label: "OMP 设定", description: `DSH 块附加到 OMP 提示词的位置：当前 ${m.prompt.ompSuffix}` },
						{ label: "OMP 规则", description: `OMP 规则库/rulebook（<generic-rules>）：当前 ${m.prompt.ompRules ? "on" : "off"}` },
						{ label: "上下文文件", description: `AGENTS.md/CLAUDE.md（<repo-rules>）：当前 ${m.prompt.contextFiles ? "on" : "off"}` },
						{ label: "返回", description: "回到模型菜单" },
					]);
					if (!sub || sub === "返回") return;
					if (sub === "DSH 系统注入") {
						const choice = await pick("DSH 系统注入（首轮系统提示词）", [
							{ label: "persona", description: "纯 DSH persona（推荐/默认）" },
							{ label: "role", description: "persona + OMP ROLE 段" },
							{ label: "policy", description: "persona + OMP TOOL POLICY 段" },
							{ label: "off", description: "不替换，首轮用完整 OMP 提示词 + DSH 块" },
						]);
						if (!choice) continue;
						m.prompt.dshSystemInjection = choice as SystemInjection;
						notify(`${label} 系统注入 → ${choice}`);
						await apply(kind);
						continue;
					}
					if (sub === "DSH 用户注入") {
						const choice = await pick("DSH 用户注入", [
							{ label: "on", description: "首条 user 消息前注入 DSH persona 块" },
							{ label: "off", description: "不注入" },
						]);
						if (!choice) continue;
						m.prompt.dshUserInjection = choice === "on";
						notify(`${label} 用户注入 → ${choice}`);
						await apply(kind);
						continue;
					}
					if (sub === "OMP 设定") {
						const choice = await pick("OMP 设定（DSH 块在 OMP 提示词上的位置）", [
							{ label: "both", description: "开头 + 末尾（默认/推荐）" },
							{ label: "start", description: "仅开头" },
							{ label: "end", description: "仅末尾" },
							{ label: "none", description: "不附加" },
						]);
						if (!choice) continue;
						m.prompt.ompSuffix = choice as SuffixPlacement;
						notify(`${label} OMP 设定 → ${choice}`);
						await apply(kind);
						continue;
					}
					if (sub === "OMP 规则") {
						const choice = await pick("OMP 规则（<generic-rules>）", [
							{ label: "on", description: "首轮提示词附加 OMP 规则库/rulebook" },
							{ label: "off", description: "首轮仅 DSH 内容（默认）" },
						]);
						if (!choice) continue;
						m.prompt.ompRules = choice === "on";
						if (choice === "on" && !hasGenericRules()) {
							notify(`${label} OMP 规则 → on（注意：当前提示词中未发现 <generic-rules>，暂无规则可注入）`);
						} else {
							notify(`${label} OMP 规则 → ${choice}`);
						}
						await apply(kind);
						continue;
					}
					if (sub === "上下文文件") {
						const choice = await pick("上下文文件（AGENTS.md/CLAUDE.md）", [
							{ label: "on", description: "首轮提示词附加 <repo-rules>（项目/用户上下文文件）" },
							{ label: "off", description: "首轮仅 DSH 内容（默认）" },
						]);
						if (!choice) continue;
						m.prompt.contextFiles = choice === "on";
						notify(`${label} 上下文文件 → ${choice}`);
						await apply(kind);
						continue;
					}
				}
			};

			const toolsMenu = async (kind: ModelKind): Promise<void> => {
				const label = kind === "flash" ? "Flash" : "Pro";
				const m = cfg[kind];
				for (;;) {
					const sub = await pick("工具设置", [
						{ label: "MCP", description: `恢复时是否包含 MCP 工具：当前 ${m.tools.mcp ? "on" : "off"}` },
						{ label: "恢复时机", description: `当前 ${m.tools.timing}` },
						{ label: "返回", description: "回到模型菜单" },
					]);
					if (!sub || sub === "返回") return;
					if (sub === "MCP") {
						const choice = await pick("MCP", [
							{ label: "on", description: "恢复完整工具时包含 mcp__*（用户 MCP 可用）" },
							{ label: "off", description: "恢复时排除 MCP 工具" },
						]);
						if (!choice) continue;
						m.tools.mcp = choice === "on";
						notify(`${label} MCP → ${choice}`);
						await apply(kind);
						continue;
					}
					if (sub === "恢复时机") {
						const choice = await pick("恢复时机", [
							{ label: "first-tool-call", description: "首次工具调用后立即恢复（默认/推荐）" },
							{ label: "first-agent-turn", description: "首轮结束后恢复" },
						]);
						if (!choice) continue;
						m.tools.timing = choice as RestoreTiming;
						notify(`${label} 恢复时机 → ${choice}`);
						await apply(kind);
						continue;
					}
				}
			};

			const modelMenu = async (kind: ModelKind): Promise<void> => {
				const label = kind === "flash" ? "Flash" : "Pro";
				const m = cfg[kind];
				for (;;) {
					const item = await pick(`${label}（deepseek-v4-${kind}）`, [
						{ label: "开关", description: `当前 ${m.enabled ? "开启" : "关闭"}` },
						{ label: "提示词设置", description: "DSH 注入 / OMP 设定 / OMP 规则" },
						{ label: "工具设置", description: "MCP / 恢复时机" },
						{ label: "重置", description: "恢复该模型环境默认" },
						{ label: "返回", description: "回到主菜单" },
					]);
					if (!item || item === "返回") return;
					if (item === "开关") {
						const choice = await pick(`开关（当前 ${m.enabled ? "开启" : "关闭"}）`, [
							{ label: "开启", description: `${label} 启用 DSH Minimal` },
							{ label: "关闭", description: `${label} 保持原生行为` },
						]);
						if (!choice) continue;
						m.enabled = choice === "开启";
						notify(`${label} 门控 ${choice}`);
						await apply(kind);
						continue;
					}
					if (item === "重置") {
						cfg[kind] = newConfig();
						notify(`${label} 已重置`);
						await apply(kind);
						continue;
					}
					if (item === "提示词设置") {
						await promptMenu(kind);
						continue;
					}
					if (item === "工具设置") {
						await toolsMenu(kind);
						continue;
					}
				}
			};

			for (;;) {
				const main = await pick("DSH Minimal 设置", [
					{ label: "状态", description: "查看两个模型的当前配置" },
					{ label: "Flash", description: `deepseek-v4-flash（当前 ${cfg.flash.enabled ? "开" : "关"}）` },
					{ label: "Pro", description: `deepseek-v4-pro（当前 ${cfg.pro.enabled ? "开" : "关"}）` },
					{ label: "重置全部", description: "两个模型恢复环境默认" },
				]);
				if (!main) return; // Esc closes; no UI returns undefined
				if (main === "状态") {
					notify(
						`flash: ${describe(cfg.flash)} | pro: ${describe(cfg.pro)} | generic-rules=${hasGenericRules() ? "有" : "无"}`,
					);
					continue;
				}
				if (main === "重置全部") {
					cfg.flash = newConfig();
					cfg.pro = newConfig();
					notify("已重置为环境默认");
					await apply(modelKindOf(ctx.model?.id) ?? "flash");
					continue;
				}
				if (main === "Flash" || main === "Pro") {
					await modelMenu(main === "Flash" ? "flash" : "pro");
					continue;
				}
			}
		},
	});

	pi.registerCommand("dsh-init", {
		description: "DSH Minimal：触发锚定轮（建立 we 轨迹后还原体验）",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (isAnchoring()) {
				ctx.ui.notify("[dsh-minimal] 锚定轮进行中，无需重复触发", "info");
				pi.logger.info("[dsh-minimal] dsh-init: already anchoring");
				return;
			}
			ctx.ui.notify("[dsh-minimal] 触发锚定轮…", "info");
			pi.logger.info("[dsh-minimal] dsh-init: anchoring");
			initAnchor();
		},
	});
}
