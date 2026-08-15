/**
 * omp-dsh-minimal — DeepSeek Harness "Minimal" (极简模式) for Oh My Pi.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// The DSH persona, kept verbatim.
export const DSH_PERSONA = "You are a helpful software engineer assistant.";

// Used to keep the block idempotent across prompt rebuilds.
export const DSH_MARKER = "<<<dsh-minimal>>>";
export const DSH_CLOSE_MARKER = "<<< /dsh-minimal >>>";

export const CONFIG_ENTRY_TYPE = "io.omp.dsh-minimal.config";

// Full OMP built-in roster.
export const DEFAULT_MINIMAL_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
	"ask",
	"eval",
	"glob",
	"grep",
	"computer",
	"task",
	"hub",
	"todo",
	"web_search",
	"security_scan",
	"ast_grep",
	"ast_edit",
	"debug",
	"github",
	"lsp",
	"browser",
	"checkpoint",
	"rewind",
	"mimo_tts",
	"mimo_stt",
	"inspect_image",
];

// DSH's own tools projected onto OMP.
export const BASE_TOOLS = ["bash", "read", "write", "edit"];

// Base plus the mid-tier extras.
export const MID_TOOLS = ["bash", "read", "write", "edit", "eval", "glob", "grep", "task"];

export type PresetMode = "a0b0" | "a1b0" | "a2b0" | "a0b4" | "a0b5" | "a1b5";
export type RestoreTiming = "first-tool-call" | "first-agent-turn";
export type SystemInjection = "off" | "persona" | "role" | "policy";
export type RosterTier = "base" | "mid" | "full";
export type SuffixPlacement = "none" | "start" | "end" | "both";
export type ModelKind = "flash" | "pro";

export const PRESETS: Record<PresetMode, { prompt: SystemInjection; tools: RosterTier }> = {
	a0b0: { prompt: "persona", tools: "base" },
	a1b0: { prompt: "role", tools: "base" },
	a2b0: { prompt: "policy", tools: "base" },
	a0b4: { prompt: "persona", tools: "full" },
	a0b5: { prompt: "persona", tools: "mid" },
	a1b5: { prompt: "role", tools: "mid" },
};

export interface DshModelConfig {
	enabled: boolean;
	prompt: {
		dshSystemInjection: SystemInjection;
		dshUserInjection: boolean;
		ompSuffix: SuffixPlacement;
		ompRules: boolean;
		contextFiles: boolean;
	};
	tools: {
		roster: RosterTier;
		mcp: boolean;
		timing: RestoreTiming;
	};
}

export type DshConfig = Record<ModelKind, DshModelConfig>;

export function defaultModelConfig(): DshModelConfig {
	return {
		enabled: true,
		prompt: {
			dshSystemInjection: "persona",
			dshUserInjection: true,
			ompSuffix: "both",
			ompRules: false,
			contextFiles: false,
		},
		tools: {
			roster: "full",
			mcp: true,
			timing: "first-tool-call",
		},
	};
}

export const DEFAULT_MODEL_PATTERN = "deepseek-v4-(flash|pro)";

const FLASH_RE = /deepseek-v4-flash(-0731)?/i;
const PRO_RE = /deepseek-v4-pro(-0813)?/i;

const env = (name: string): string | undefined => process.env[name];

export function readCsv(value: string | undefined, fallback: string[]): string[] {
	if (!value) return fallback;
	const parsed = value
		.split(",")
		.map(part => part.trim())
		.filter(part => part.length > 0);
	return parsed.length > 0 ? parsed : fallback;
}

export function mergeToolNames(base: readonly string[], extra: readonly string[]): string[] {
	return [...new Set([...base, ...extra])];
}

export function buildDshBlock(): string {
	return `${DSH_MARKER}\n${DSH_PERSONA}\n${DSH_CLOSE_MARKER}`;
}

export function assembleSystemPrompt(
	blocks: string[],
	placement: SuffixPlacement = "both",
	dshBlock: string = buildDshBlock(),
): string[] | null {
	if (placement === "none") return [...blocks];
	if (blocks.some(block => block.includes(DSH_MARKER))) return null;
	const systemPrompt = [...blocks];
	if (placement === "start") {
		systemPrompt.unshift(dshBlock);
	} else if (placement === "both") {
		systemPrompt.unshift(dshBlock);
		if (systemPrompt.length > 1) {
			systemPrompt[systemPrompt.length - 1] += `\n\n${dshBlock}`;
		}
	} else if (systemPrompt.length === 0) {
		systemPrompt.push(dshBlock);
	} else {
		systemPrompt[systemPrompt.length - 1] += `\n\n${dshBlock}`;
	}
	return systemPrompt;
}

export function matchesModel(modelId: string | undefined, pattern: string = DEFAULT_MODEL_PATTERN): boolean {
	if (!modelId || modelId.length === 0) return false;
	return new RegExp(pattern, "i").test(modelId);
}

export default function dshMinimal(pi: ExtensionAPI): void | Promise<void> {
	if (env("DSH_MINIMAL_DISABLE") === "1") return;

	const here = dirname(fileURLToPath(import.meta.url));
	const roleTemplate = join(here, "templates", "persona+role.txt");
	const policyTemplate = join(here, "templates", "persona+policy.txt");

	// Runtime config (env seeds; /dsh-minimal overrides).
	const modeSeed = (env("DSH_MINIMAL_MODE") ?? "a0b4") as PresetMode;
	const seedPrompt: SystemInjection = modeSeed in PRESETS ? PRESETS[modeSeed].prompt : "persona";
	const seedRoster: RosterTier = modeSeed in PRESETS ? PRESETS[modeSeed].tools : "full";
	const seedTiming = (env("DSH_MINIMAL_TIMING") ?? "first-tool-call") as RestoreTiming;
	const seedSuffix = (env("DSH_MINIMAL_POSITION") ?? "both") as SuffixPlacement;
	const cfg: DshConfig = {
		flash: defaultModelConfig(),
		pro: defaultModelConfig(),
	};
	for (const kind of ["flash", "pro"] as const) {
		cfg[kind].prompt.dshSystemInjection = seedPrompt;
		cfg[kind].prompt.ompSuffix = seedSuffix;
		cfg[kind].tools.roster = seedRoster;
		cfg[kind].tools.timing = seedTiming;
	}
	const promptOnly = env("DSH_MINIMAL_PROMPT_ONLY") === "1";
	const toolsOverride = env("DSH_MINIMAL_TOOLS");
	const turn1OverridePath = env("DSH_MINIMAL_TURN1_SYSTEM");

	const modelKindOf = (modelId: string | undefined): ModelKind | undefined => {
		if (!modelId) return undefined;
		if (FLASH_RE.test(modelId)) return "flash";
		if (PRO_RE.test(modelId)) return "pro";
		return undefined;
	};

	const rosterFor = (kind: ModelKind): string[] => {
		if (toolsOverride) return readCsv(toolsOverride, DEFAULT_MINIMAL_TOOLS);
		const tier = cfg[kind].tools.roster;
		return tier === "base" ? BASE_TOOLS : tier === "mid" ? MID_TOOLS : DEFAULT_MINIMAL_TOOLS;
	};

	const promptCache = new Map<string, Promise<string[]>>();
	const readTemplate = (file: string): Promise<string[]> => {
		let cached = promptCache.get(file);
		if (!cached) {
			cached = readFile(file, "utf8")
				.then(content => [content.trim()])
				.catch(error => {
					pi.logger.warn(`[dsh-minimal] cannot read template ${file}: ${String(error)}`);
					return [DSH_PERSONA];
				});
			promptCache.set(file, cached);
		}
		return cached;
	};

	// OMP's own always-apply rules.
	const extractGenericRules = (blocks: string[]): string | undefined => {
		for (const block of blocks) {
			const match = block.match(/<generic-rules>[\s\S]*?<\/generic-rules>/);
			if (match) return match[0];
		}
		return undefined;
	};

	// Project/user context files.
	const extractRepoRules = (blocks: string[]): string | undefined => {
		for (const block of blocks) {
			const match = block.match(/<repo-rules>[\s\S]*?<\/repo-rules>/);
			if (match) return match[0];
		}
		return undefined;
	};

	const turn1PromptFor = async (kind: ModelKind, blocks: string[]): Promise<string[]> => {
		if (turn1OverridePath) return readTemplate(turn1OverridePath);
		const p = cfg[kind].prompt;
		if (p.dshSystemInjection === "off") {
			return assembleSystemPrompt(blocks, p.ompSuffix) ?? blocks;
		}
		const parts: string[] = [];
		if (p.dshSystemInjection === "persona") {
			parts.push(DSH_PERSONA);
		} else if (p.dshSystemInjection === "role") {
			parts.push(...(await readTemplate(roleTemplate)));
		} else if (p.dshSystemInjection === "policy") {
			parts.push(...(await readTemplate(policyTemplate)));
		}
		if (p.ompRules) {
			const rules = extractGenericRules(blocks);
			if (rules) parts.push(rules);
		}
		if (p.contextFiles) {
			const files = extractRepoRules(blocks);
			if (files) parts.push(files);
		}
		return parts;
	};

	// Per-session state.
	let fullTools: string[] | null = null;
	let firstTurnEnded = false;
	let firstToolCallDone = false;
	let firstTurnArmed = false;
	let userMessageInjected = false;

	const applyRoster = async (names: string[], reason: string): Promise<void> => {
		await pi.setActiveTools(names);
		pi.logger.debug(`[dsh-minimal] ${reason}: roster=${names.join(",")}`);
	};

	// Keep a snapshot of the full roster, honoring the MCP toggle.
	const mergeIntoSnapshot = (kind: ModelKind): void => {
		const current = pi.getActiveTools().filter(name => cfg[kind].tools.mcp || !name.startsWith("mcp__"));
		fullTools = fullTools === null ? current : mergeToolNames(fullTools, current);
	};

	const inPureDshPhase = (kind: ModelKind): boolean =>
		!firstTurnEnded && (cfg[kind].tools.timing === "first-agent-turn" || !firstToolCallDone);

	const restoreFullRoster = async (kind: ModelKind, reason: string): Promise<void> => {
		mergeIntoSnapshot(kind);
		if (fullTools !== null) await applyRoster(fullTools, reason);
	};

	// Persist config for resumed sessions.
	const persistConfig = (): void => {
		try {
			pi.appendEntry(CONFIG_ENTRY_TYPE, { flash: cfg.flash, pro: cfg.pro });
		} catch (error) {
			pi.logger.warn(`[dsh-minimal] persist config failed: ${String(error)}`);
		}
	};

	// Restore the last persisted config.
	const restoreConfigFromSession = (ctx: {
		sessionManager: { getBranch: () => Array<{ type?: string; customType?: string; data?: unknown }> };
	}): void => {
		const bool = (value: unknown, fallback: boolean): boolean =>
			typeof value === "boolean" ? value : fallback;
		const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
			typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== CONFIG_ENTRY_TYPE) continue;
			const data = entry.data as Partial<DshConfig> | undefined;
			if (!data || typeof data !== "object") continue;
			for (const kind of ["flash", "pro"] as const) {
				const saved = data[kind] as Partial<DshModelConfig> | undefined;
				if (!saved || typeof saved !== "object") continue;
				const merged = defaultModelConfig();
				merged.enabled = bool(saved.enabled, merged.enabled);
				merged.prompt.dshSystemInjection = oneOf(
					saved.prompt?.dshSystemInjection,
					["off", "persona", "role", "policy"] as const,
					merged.prompt.dshSystemInjection,
				);
				merged.prompt.dshUserInjection = bool(saved.prompt?.dshUserInjection, merged.prompt.dshUserInjection);
				merged.prompt.ompSuffix = oneOf(
					saved.prompt?.ompSuffix,
					["none", "start", "end", "both"] as const,
					merged.prompt.ompSuffix,
				);
				merged.prompt.ompRules = bool(saved.prompt?.ompRules, merged.prompt.ompRules);
				merged.prompt.contextFiles = bool(saved.prompt?.contextFiles, merged.prompt.contextFiles);
				merged.tools.roster = oneOf(
					saved.tools?.roster,
					["base", "mid", "full"] as const,
					merged.tools.roster,
				);
				merged.tools.mcp = bool(saved.tools?.mcp, merged.tools.mcp);
				merged.tools.timing = oneOf(
					saved.tools?.timing,
					["first-tool-call", "first-agent-turn"] as const,
					merged.tools.timing,
				);
				cfg[kind] = merged;
			}
		}
	};

	// Apply the minimal roster before the first prompt is built.
	pi.on("session_start", async (_event, ctx) => {
		restoreConfigFromSession(ctx);
		const kind = modelKindOf(ctx.model?.id);
		if (promptOnly || !kind || !cfg[kind].enabled) return;
		try {
			await applyRoster(rosterFor(kind), "session_start");
		} catch (error) {
			pi.logger.warn(`[dsh-minimal] tool roster switch failed: ${String(error)}`);
		}
	});

	// MCP discovery can settle after session_start; re-apply the roster here.
	pi.on("input", async (event, ctx) => {
		const kind = modelKindOf(ctx.model?.id);
		if (promptOnly || !kind || !cfg[kind].enabled) return;
		if (typeof event.text !== "string" || event.text.startsWith("/")) return;
		try {
			mergeIntoSnapshot(kind);
			if (inPureDshPhase(kind)) {
				await applyRoster(rosterFor(kind), "input#minimal");
			} else if (fullTools !== null) {
				await applyRoster(fullTools, "input#restore");
			}
		} catch (error) {
			pi.logger.warn(`[dsh-minimal] tool roster switch failed: ${String(error)}`);
		}
	});

	// First turn: replace the system prompt and use the minimal roster.
	// Later turns: restore the full roster and only attach the DSH block.
	pi.on("before_agent_start", async (event, ctx) => {
		const kind = modelKindOf(ctx.model?.id);
		if (!kind || !cfg[kind].enabled) {
			// Session switched to a non-gated model after a restriction: undo it.
			if (!promptOnly && fullTools !== null) {
				try {
					const prev = kind ?? "flash";
					await restoreFullRoster(prev, "non_gated#restore");
				} catch (error) {
					pi.logger.warn(`[dsh-minimal] tool roster switch failed: ${String(error)}`);
				}
			}
			return;
		}
		if (promptOnly) {
			const systemPrompt = assembleSystemPrompt(event.systemPrompt, cfg[kind].prompt.ompSuffix);
			if (systemPrompt === null) return;
			return { systemPrompt };
		}
		try {
			mergeIntoSnapshot(kind);
			if (inPureDshPhase(kind)) {
				await applyRoster(rosterFor(kind), "before_agent_start#minimal");
				firstTurnArmed = true;
				return { systemPrompt: [...(await turn1PromptFor(kind, event.systemPrompt))] };
			}
			await applyRoster(fullTools ?? rosterFor(kind), "before_agent_start#restore");
			const systemPrompt = assembleSystemPrompt(event.systemPrompt, cfg[kind].prompt.ompSuffix);
			if (systemPrompt === null) return;
			return { systemPrompt };
		} catch (error) {
			pi.logger.warn(`[dsh-minimal] tool roster switch failed: ${String(error)}`);
		}
	});

	// The first tool call ends the pure-DSH window.
	pi.on("tool_call", async (_event, ctx) => {
		const kind = modelKindOf(ctx.model?.id);
		if (promptOnly || !kind || !cfg[kind].enabled) return;
		if (cfg[kind].tools.timing !== "first-tool-call" || firstToolCallDone) return;
		firstToolCallDone = true;
		try {
			await restoreFullRoster(kind, "first_tool_call#restore");
		} catch (error) {
			pi.logger.warn(`[dsh-minimal] tool roster switch failed: ${String(error)}`);
		}
	});

	// Restore when the first turn ends.
	pi.on("turn_end", async (event, ctx) => {
		const kind = modelKindOf(ctx.model?.id);
		if (promptOnly || !kind || !cfg[kind].enabled) return;
		if (event.turnIndex !== 0 || firstTurnEnded) return;
		firstTurnEnded = true;
		firstTurnArmed = false;
		try {
			mergeIntoSnapshot(kind);
			if (fullTools !== null && (cfg[kind].tools.timing === "first-agent-turn" || !firstToolCallDone)) {
				await applyRoster(fullTools, "turn_end#restore");
			}
		} catch (error) {
			pi.logger.warn(`[dsh-minimal] tool roster switch failed: ${String(error)}`);
		}
	});

	// A compacted context starts a fresh pure-DSH phase.
	pi.on("session_compact", async (_event, ctx) => {
		const kind = modelKindOf(ctx.model?.id);
		if (promptOnly || !kind || !cfg[kind].enabled) return;
		firstTurnEnded = false;
		firstToolCallDone = false;
		firstTurnArmed = true;
		userMessageInjected = false;
		try {
			await applyRoster(rosterFor(kind), "session_compact#minimal");
		} catch (error) {
			pi.logger.warn(`[dsh-minimal] tool roster switch failed: ${String(error)}`);
		}
	});

	// Inject the DSH block as a user message before the first user turn.
	pi.on("context", (event, ctx) => {
		const kind = modelKindOf(ctx.model?.id);
		if (!kind || !cfg[kind].enabled) return;
		if (!firstTurnArmed || userMessageInjected || promptOnly) return;
		if (!cfg[kind].prompt.dshUserInjection) return;
		userMessageInjected = true;
		const userMessage = {
			role: "user" as const,
			content: [{ type: "text" as const, text: buildDshBlock() }],
			synthetic: true,
			attribution: "agent" as const,
			timestamp: Date.now(),
		};
		pi.logger.debug(
			`[dsh-minimal] context: injecting user message before ${event.messages.length} messages, first=${event.messages[0]?.role}`,
		);
		return { messages: [userMessage, ...event.messages] };
	});

	// /new and friends reuse the same session; start clean.
	pi.on("session_switch", async () => {
		if (!promptOnly && fullTools !== null) {
			try {
				await applyRoster(fullTools, "session_switch#restore");
			} catch (error) {
				pi.logger.warn(`[dsh-minimal] tool roster switch failed: ${String(error)}`);
			}
		}
		fullTools = null;
		firstTurnEnded = false;
		firstToolCallDone = false;
		firstTurnArmed = false;
		userMessageInjected = false;
	});

	// /dsh-minimal command (TUI menu + argument form).
	pi.registerCommand("dsh-minimal", {
		description: "DSH Minimal：按模型配置（开关/提示词/工具/重置）",
		handler: async (args, ctx) => {
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

			const apply = async (kind: ModelKind): Promise<void> => {
				persistConfig();
				if (!cfg[kind].enabled || !inPureDshPhase(kind)) {
					try {
						await restoreFullRoster(kind, "config_change#restore");
					} catch (error) {
						pi.logger.warn(`[dsh-minimal] tool roster switch failed: ${String(error)}`);
					}
				} else {
					try {
						await applyRoster(rosterFor(kind), "config_change#minimal");
					} catch (error) {
						pi.logger.warn(`[dsh-minimal] tool roster switch failed: ${String(error)}`);
					}
				}
			};

			const describe = (m: DshModelConfig): string =>
				[
					m.enabled ? "开" : "关",
					`注入=${m.prompt.dshSystemInjection}`,
					`用户注入=${m.prompt.dshUserInjection ? "on" : "off"}`,
					`后缀=${m.prompt.ompSuffix}`,
					`规则=${m.prompt.ompRules ? "on" : "off"}`,
					`上下文=${m.prompt.contextFiles ? "on" : "off"}`,
					`工具=${m.tools.roster}`,
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
				cfg.flash = defaultModelConfig();
				cfg.pro = defaultModelConfig();
				notify("已重置为环境默认");
				await apply(modelKindOf(ctx.model?.id) ?? "flash");
				return;
			}

			// Esc closes the current dialog; 返回 walks up one level.
			const hasGenericRules = (): boolean => {
				const blocks = ctx.getSystemPrompt();
				return extractGenericRules(blocks) !== undefined;
			};

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
						{ label: "OMP 扩展工具", description: `首轮内置工具层：当前 ${m.tools.roster}` },
						{ label: "MCP", description: `恢复时是否包含 MCP 工具：当前 ${m.tools.mcp ? "on" : "off"}` },
						{ label: "恢复时机", description: `当前 ${m.tools.timing}` },
						{ label: "返回", description: "回到模型菜单" },
					]);
					if (!sub || sub === "返回") return;
					if (sub === "OMP 扩展工具") {
						const choice = await pick("OMP 扩展工具（首轮内置工具层）", [
							{ label: "full", description: "全部内置（默认/推荐）" },
							{ label: "base", description: "bash,read,write,edit（DSH 双工具投影）" },
							{ label: "mid", description: "base + eval,glob,grep,task" },
						]);
						if (!choice) continue;
						m.tools.roster = choice as RosterTier;
						notify(`${label} 扩展工具 → ${choice}`);
						await apply(kind);
						continue;
					}
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
						{ label: "工具设置", description: "扩展工具 / MCP / 恢复时机" },
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
						cfg[kind] = defaultModelConfig();
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
					cfg.flash = defaultModelConfig();
					cfg.pro = defaultModelConfig();
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
}
