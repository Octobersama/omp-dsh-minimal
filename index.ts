/**
 * omp-dsh-minimal — DeepSeek Harness "Minimal" (极简模式) for Oh My Pi.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { COMPACTION_TOOLS, INIT_ANCHOR_PROMPT, MINIMAL_TOOL_PAIR, RESIDENT_DISCOVERY_TOOLS, registerMinimalTools } from "./tools";
import { registerCommands, type CommandDeps } from "./command";

// The DSH persona, kept verbatim.
export const DSH_PERSONA = "You are a helpful software engineer assistant.";

// Used to keep the block idempotent across prompt rebuilds.
export const DSH_MARKER = "<<<dsh-minimal>>>";
export const DSH_CLOSE_MARKER = "<<< /dsh-minimal >>>";

export const CONFIG_ENTRY_TYPE = "io.omp.dsh-minimal.config";

// 运行态状态持久化条目（unlockedTools / 晋升 / compaction 状态，resume/reload 恢复）。
export const STATE_ENTRY_TYPE = "io.omp.dsh-minimal.state";

export type RestoreTiming = "first-tool-call" | "first-agent-turn";
export type SystemInjection = "off" | "persona" | "role" | "policy";
export type SuffixPlacement = "none" | "start" | "end" | "both";
export type ModelKind = "flash" | "pro";

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
			dshUserInjection: false,
			ompSuffix: "both",
			ompRules: false,
			contextFiles: false,
		},
		tools: {
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

	// ── K1/K3：注册 Minimal 对齐工具 + 按需解锁状态 ──────────────────────────
	const unlockedTools = new Set<string>();
	registerMinimalTools(pi, {
		onUnlock: (names) => {
			for (const name of names) unlockedTools.add(name);
			persistState();
		},
	});

	// 晋升后的 resident set：Minimal 工具对 + 发现工具 + 已解锁。
	const residentSet = (): string[] =>
		mergeToolNames([...MINIMAL_TOOL_PAIR, ...RESIDENT_DISCOVERY_TOOLS], [...unlockedTools]);

	// compaction 后的工具集：Minimal 工具对 + 核心工作集（K6）。
	const compactionSet = (): string[] =>
		mergeToolNames([...MINIMAL_TOOL_PAIR], COMPACTION_TOOLS);

	// Runtime config (env seeds; /dsh-minimal overrides).
	const modeSeed = env("DSH_MINIMAL_MODE") ?? "a0b4";
	const seedPrompt: SystemInjection = modeSeed.startsWith("a0") ? "persona" : modeSeed.startsWith("a1") ? "role" : modeSeed.startsWith("a2") ? "policy" : "persona";
	const seedTiming = (env("DSH_MINIMAL_TIMING") ?? "first-tool-call") as RestoreTiming;
	const seedSuffix = (env("DSH_MINIMAL_POSITION") ?? "both") as SuffixPlacement;
	const cfg: DshConfig = {
		flash: defaultModelConfig(),
		pro: defaultModelConfig(),
	};
	for (const kind of ["flash", "pro"] as const) {
		cfg[kind].prompt.dshSystemInjection = seedPrompt;
		cfg[kind].prompt.ompSuffix = seedSuffix;
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

	// 首轮工具集：固定为 DSH Minimal 工具对（K1：锚定靠 schema 身份），toolsOverride 可覆盖。
	const rosterFor = (_kind: ModelKind): string[] => {
		if (toolsOverride) return readCsv(toolsOverride, MINIMAL_TOOL_PAIR);
		return [...MINIMAL_TOOL_PAIR];
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
	let wasRestricted = false;
	let compacted = false;
	let anchoring = false;
	let firstTurnArmed = false;
	let userMessageInjected = false;

	const applyRoster = async (names: string[], reason: string): Promise<void> => {
		await pi.setActiveTools(names);
		pi.logger.debug(`[dsh-minimal] ${reason}: roster=${names.join(",")}`);
	};

	// 锚定轮结束后恢复 resident set（K3：不 dump 全量，避免后晋升回归）。
	const restoreFullRoster = async (_kind: ModelKind, reason: string): Promise<void> => {
		anchoring = false;
		compacted = false;
		await applyRoster(residentSet(), reason);
		persistState();
	};

	// Persist config for resumed sessions.
	const persistConfig = (): void => {
		try {
			pi.appendEntry(CONFIG_ENTRY_TYPE, { flash: cfg.flash, pro: cfg.pro });
		} catch (error) {
			pi.logger.warn(`[dsh-minimal] persist config failed: ${String(error)}`);
		}
	};

	// Persist runtime state (unlocked tools + promotion/compaction phase) for resume/reload.
	const persistState = (): void => {
		try {
			pi.appendEntry(STATE_ENTRY_TYPE, {
				unlockedTools: [...unlockedTools],
				anchoring,
				compacted,
			});
		} catch (error) {
			pi.logger.warn(`[dsh-minimal] persist state failed: ${String(error)}`);
		}
	};

	// Restore runtime state from the last persisted state entry.
	const restoreStateFromSession = (ctx: {
		sessionManager: { getBranch: () => Array<{ type?: string; customType?: string; data?: unknown }> };
	}): void => {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
			const data = entry.data as Partial<{
				unlockedTools: string[];
				anchoring: boolean;
				compacted: boolean;
			}> | undefined;
			if (!data || typeof data !== "object") continue;
			if (Array.isArray(data.unlockedTools)) {
				for (const name of data.unlockedTools) {
					if (typeof name === "string" && name.length > 0) unlockedTools.add(name);
				}
			}
			if (typeof data.anchoring === "boolean") anchoring = data.anchoring;
			if (typeof data.compacted === "boolean") compacted = data.compacted;
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
		restoreStateFromSession(ctx);
		const kind = modelKindOf(ctx.model?.id);
		if (promptOnly || !kind || !cfg[kind].enabled) return;
		try {
			await applyRoster(residentSet(), "session_start#restore");
			wasRestricted = true;
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
			if (anchoring) {
				await applyRoster(rosterFor(kind), "input#minimal");
			} else {
				await applyRoster(residentSet(), "input#restore");
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
			// 切到非 gated 模型：恢复完整工具，插件不再干预。
			if (!promptOnly && wasRestricted) {
				try {
					await applyRoster(pi.getAllTools().map((t) => t.name), "non_gated#restore");
					wasRestricted = false;
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
			if (anchoring) {
				await applyRoster(compacted ? compactionSet() : rosterFor(kind), "before_agent_start#minimal");
				firstTurnArmed = true;
				return { systemPrompt: [...(await turn1PromptFor(kind, event.systemPrompt))] };
			}
			await applyRoster(residentSet(), "before_agent_start#restore");
			const systemPrompt = assembleSystemPrompt(event.systemPrompt, cfg[kind].prompt.ompSuffix);
			if (systemPrompt === null) return;
			return { systemPrompt };
		} catch (error) {
			pi.logger.warn(`[dsh-minimal] tool roster switch failed: ${String(error)}`);
		}
	});

	// 锚定轮内首次工具调用结束锚定（first-tool-call 模式）。
	pi.on("tool_call", async (_event, ctx) => {
		const kind = modelKindOf(ctx.model?.id);
		if (promptOnly || !kind || !cfg[kind].enabled) return;
		if (!anchoring) return;
		if (cfg[kind].tools.timing !== "first-tool-call") return;
		try {
			await restoreFullRoster(kind, "first_tool_call#restore");
		} catch (error) {
			pi.logger.warn(`[dsh-minimal] tool roster switch failed: ${String(error)}`);
		}
	});

	// 锚定轮结束（turn 结束）时结束锚定。
	pi.on("turn_end", async (_event, ctx) => {
		const kind = modelKindOf(ctx.model?.id);
		if (promptOnly || !kind || !cfg[kind].enabled) return;
		if (!anchoring) return;
		firstTurnArmed = false;
		try {
			await restoreFullRoster(kind, "turn_end#restore");
		} catch (error) {
			pi.logger.warn(`[dsh-minimal] tool roster switch failed: ${String(error)}`);
		}
	});

	// compaction 后标记 compacted（若之后 /dsh-init 重新锚定则用核心工作集），不自动锚定。
	pi.on("session_compact", async (_event, ctx) => {
		const kind = modelKindOf(ctx.model?.id);
		if (promptOnly || !kind || !cfg[kind].enabled) return;
		compacted = true;
		firstTurnArmed = false;
		userMessageInjected = false;
		try {
			await applyRoster(residentSet(), "session_compact#restore");
			persistState();
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
		if (!promptOnly) {
			try {
				await applyRoster(residentSet(), "session_switch#restore");
			} catch (error) {
				pi.logger.warn(`[dsh-minimal] tool roster switch failed: ${String(error)}`);
			}
		}
		wasRestricted = false;
		compacted = false;
		anchoring = false;
		firstTurnArmed = false;
		userMessageInjected = false;
	});

	// /dsh-minimal、/dsh-init 命令（实现见 command.ts）。
	const commandDeps: CommandDeps = {
		pi,
		cfg,
		isAnchoring: () => anchoring,
		newConfig: defaultModelConfig,
		apply: async (kind) => {
			persistConfig();
			if (!cfg[kind].enabled || !anchoring) {
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
		},
		extractGenericRules,
		modelKindOf,
		initAnchor: () => {
			anchoring = true;
			pi.sendUserMessage(INIT_ANCHOR_PROMPT);
		},
	};
	registerCommands(commandDeps);
}
