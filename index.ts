/**
 * omp-dsh-minimal — DeepSeek Harness "Minimal" (极简模式) for Oh My Pi.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

// The DSH persona, kept verbatim.
export const DSH_PERSONA = "You are a helpful software engineer assistant.";

// DSH Minimal persistent bash 描述（逐字节，来自 dsh-anchored agent.cordis.yml）。
// K1 的核心：锚定靠工具 schema 的字节级身份（issue #11）。
export const MINIMAL_BASH_DESCRIPTION = `Run commands in a bash shell
* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
* You don't have access to the internet via this tool.
* You do have access to a mirror of common linux and python packages via apt and pip.
* State is persistent across command calls and discussions with the user.
* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.
* Please avoid commands that may produce a very large amount of output.
* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.`;

// str_replace_editor 描述（Anthropic/DSH 标准风格，DSH Minimal 第二工具）。
export const STR_REPLACE_EDITOR_DESCRIPTION = `Custom editing tool for viewing, creating and editing files
* State is persistent across command calls and discussions with the user
* If \`path\` is a file, \`view\` displays the result of applying \`cat -n\`. If \`path\` is a directory, \`view\` lists non-hidden files and directories up to 2 levels deep
* The \`create\` command cannot be used if the specified \`path\` already exists as a file
* If a \`command\` generates a long output, it will be truncated and marked with \`<response clipped>\`
* The \`undo_edit\` command will revert the last edit made to the file at \`path\`

Notes for using the \`str_replace\` command:
* The \`old_str\` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!
* If the \`old_str\` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in \`old_str\` to make it unique
* The \`new_str\` parameter should contain the edited lines that should replace the \`old_str\``;

// 首轮 Minimal 工具对（DSH Minimal 的 bash + str_replace_editor）。
export const MINIMAL_TOOL_PAIR = ["bash", "str_replace_editor"];

// 晋升后常驻的发现工具（K3：按需解锁）。
export const RESIDENT_DISCOVERY_TOOLS = ["dev_tool_search"];

// compaction 后的核心工作集（K6：compaction 时模型是任务中途，需要能继续工作）。
// 对齐 dsh-anchored 的 compactionTools 默认值，映射到 OMP 工具名。
export const COMPACTION_TOOLS = ["read", "write", "edit", "glob", "grep", "todo", "ask"];

// dev_tool_search 的可解锁工具索引（对齐 dsh 的 UNLOCKABLE_INDEX，映射到 OMP 工具名）。
// 明确列出 resident set 之外可解锁的工具，让模型知道何时该调 dev_tool_search。
export const DEV_TOOL_UNLOCKABLE_INDEX = [
	"web_search — internet search and web retrieval",
	"task — delegate work to sub-agents",
	"hub — background jobs / long-running services",
	"browser — control a web browser",
	"github — GitHub operations (PRs, issues, code search)",
	"lsp — code intelligence (definitions, references)",
	"computer — control the desktop",
	"inspect_image — read image files",
	"debug — debugging tools",
	"eval — run Python code",
	"security_scan — security scanning",
	"ast_grep / ast_edit — syntax-aware search and codemods",
	"todo — task tracking",
	"ask — ask the user",
	"checkpoint / rewind — session checkpoints",
];

// /dsh-init 锚定轮预设提示词（参考 dsh zero-anchored/whoami 的锚定轮思路，适配 2 工具锚定轮：
// 触发一次 bash 调用以产生 we 轨迹并晋升）。
export const INIT_ANCHOR_PROMPT = "Initialize this session: list the files in the current directory and show the git status.";

// Used to keep the block idempotent across prompt rebuilds.
export const DSH_MARKER = "<<<dsh-minimal>>>";
export const DSH_CLOSE_MARKER = "<<< /dsh-minimal >>>";

export const CONFIG_ENTRY_TYPE = "io.omp.dsh-minimal.config";

// 运行态状态持久化条目（unlockedTools / 晋升 / compaction 状态，resume/reload 恢复）。
export const STATE_ENTRY_TYPE = "io.omp.dsh-minimal.state";

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
			dshUserInjection: false,
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

	// ── K1/K3：注册 Minimal 对齐工具 + 按需解锁状态 ──────────────────────────
	const z = (pi as any).zod;
	const unlockedTools = new Set<string>();

	// re-register 内建 bash：schema 对齐 DSH Minimal，执行委托内建。
	pi.registerTool({
		name: "bash",
		label: "Bash",
		description: MINIMAL_BASH_DESCRIPTION,
		parameters: z.object({ command: z.string() }),
		async execute(_toolCallId: string, params: any, signal: any, _onUpdate: any, ctx: any) {
			if (ctx?.invokeTool) return ctx.invokeTool(params, { signal });
			return { content: [{ type: "text", text: "bash unavailable in this context" }], details: {} };
		},
	});

	// str_replace_editor：DSH Minimal 第二工具，执行用 node:fs 近似。
	pi.registerTool({
		name: "str_replace_editor",
		label: "File Editor",
		description: STR_REPLACE_EDITOR_DESCRIPTION,
		parameters: z.object({
			command: z.string(),
			path: z.string(),
			file_text: z.string().optional(),
			insert_line: z.number().optional(),
			new_str: z.string().optional(),
			old_str: z.string().optional(),
			view_range: z.array(z.number()).optional(),
		}),
		async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
			const base: string = ctx?.cwd ?? process.cwd();
			const abs = resolve(base, params.path ?? ".");
			try {
				switch (params.command) {
					case "view": {
						if (!existsSync(abs)) return { content: [{ type: "text", text: `Error: file not found: ${params.path}` }], details: {} };
						const content = readFileSync(abs, "utf8");
						const numbered = content.split("\n").map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join("\n");
						return { content: [{ type: "text", text: numbered }], details: {} };
					}
					case "create": {
						if (existsSync(abs)) return { content: [{ type: "text", text: `Error: file already exists: ${params.path}` }], details: {} };
						mkdirSync(dirname(abs), { recursive: true });
						writeFileSync(abs, params.file_text ?? "");
						return { content: [{ type: "text", text: `File created: ${params.path}` }], details: {} };
					}
					case "str_replace": {
						if (!existsSync(abs)) return { content: [{ type: "text", text: `Error: file not found: ${params.path}` }], details: {} };
						const content = readFileSync(abs, "utf8");
						const oldStr = params.old_str ?? "";
						if (!content.includes(oldStr)) return { content: [{ type: "text", text: "Error: old_str not found in file" }], details: {} };
						const count = content.split(oldStr).length - 1;
						if (count > 1) return { content: [{ type: "text", text: `Error: old_str not unique (${count} matches)` }], details: {} };
						writeFileSync(abs, content.replace(oldStr, params.new_str ?? ""));
						return { content: [{ type: "text", text: `Replaced in ${params.path}` }], details: {} };
					}
					case "insert": {
						if (!existsSync(abs)) return { content: [{ type: "text", text: `Error: file not found: ${params.path}` }], details: {} };
						const lines = readFileSync(abs, "utf8").split("\n");
						const line = typeof params.insert_line === "number" ? params.insert_line : lines.length;
						lines.splice(line, 0, params.new_str ?? "");
						writeFileSync(abs, lines.join("\n"));
						return { content: [{ type: "text", text: `Inserted at line ${line}` }], details: {} };
					}
					default:
						return { content: [{ type: "text", text: `Unknown command: ${params.command}` }], details: {} };
				}
			} catch (e) {
				return { content: [{ type: "text", text: `Error: ${String(e)}` }], details: {} };
			}
		},
	});

	// dev_tool_search：K3 按需解锁。
	pi.registerTool({
		name: "dev_tool_search",
		label: "Tool Search",
		description: [
			"Discover and unlock tools that are NOT currently available.",
			"This session keeps a minimal resident set (bash, str_replace_editor). Everything else is unlocked on demand through this tool.",
			"If the current task needs any of the following, call dev_tool_search FIRST — do not try to work around them with bash:",
			...DEV_TOOL_UNLOCKABLE_INDEX.map((line) => `- ${line}`),
			"",
			"Pass `query` to search the full catalog (returns matching tool names + descriptions), then pass `toolNames` with exact names to unlock them for the next request.",
		].join("\n"),
		parameters: z.object({
			query: z.string().optional(),
			toolNames: z.array(z.string()).optional(),
		}),
		async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, _ctx: any) {
			const lines: string[] = [];
			const unlock = Array.isArray(params.toolNames) ? params.toolNames.filter((n: unknown) => typeof n === "string" && n.length > 0) : [];
			if (unlock.length > 0) {
				for (const name of unlock) unlockedTools.add(name);
				persistState();
				lines.push(`Unlocked for the next request: ${unlock.join(", ")}`);
			}
			const query = typeof params.query === "string" ? params.query.trim() : "";
			if (query.length === 0) return { content: [{ type: "text", text: lines.join("\n") || "Provide `query` to search, or `toolNames` to unlock." }], details: {} };
			try {
				const all = (pi as any).getAllTools() as Array<{ name: string; description: string }>;
				const wanted = query.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
				const matches = all
					.filter((t) => {
						const hay = `${t.name} ${t.description ?? ""}`.toLowerCase();
						return wanted.every((tok) => hay.includes(tok));
					})
					.slice(0, 25);
				if (matches.length === 0) {
					lines.push(`No tools match "${query}".`);
				} else {
					lines.push(`Matching tools (${matches.length}):`);
					for (const m of matches) {
						lines.push(`- ${m.name}: ${(m.description || "").split("\n")[0].slice(0, 90)}`);
					}
					lines.push(`Unlock with dev_tool_search({"toolNames": ["<exact name>"]}).`);
				}
			} catch (e) {
				lines.push(`catalog search unavailable: ${String(e)}`);
			}
			return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
		},
	});

	// 晋升后的 resident set：Minimal 工具对 + 发现工具 + 已解锁。
	const residentSet = (): string[] =>
		mergeToolNames([...MINIMAL_TOOL_PAIR, ...RESIDENT_DISCOVERY_TOOLS], [...unlockedTools]);

	// compaction 后的工具集：Minimal 工具对 + 核心工作集（K6）。
	const compactionSet = (): string[] =>
		mergeToolNames([...MINIMAL_TOOL_PAIR], COMPACTION_TOOLS);

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

	// 首轮工具集：固定为 DSH Minimal 工具对（K1：锚定靠 schema 身份）。
	// toolsOverride 环境变量可覆盖；roster 三档保留向后兼容但不再影响首轮。
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
			// Session switched to a non-gated model after a restriction: undo it.
			if (!promptOnly && wasRestricted) {
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

	// /dsh-init：主动触发一次锚定轮（预设提示词 + 2 工具 + 剥离 SP）。
	pi.registerCommand("dsh-init", {
		description: "DSH Minimal：触发锚定轮（建立 we 轨迹后还原体验）",
		handler: async (_args, ctx) => {
			if (anchoring) {
				ctx.ui.notify("[dsh-minimal] 锚定轮进行中，无需重复触发", "info");
				pi.logger.info("[dsh-minimal] dsh-init: already anchoring");
				return;
			}
			anchoring = true;
			ctx.ui.notify("[dsh-minimal] 触发锚定轮…", "info");
			pi.logger.info("[dsh-minimal] dsh-init: anchoring");
			pi.sendUserMessage(INIT_ANCHOR_PROMPT);
		},
	});
}
