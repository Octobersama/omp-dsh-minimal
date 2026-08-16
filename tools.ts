/**
 * tools.ts — DSH Minimal 对齐的工具注册（K1/K3）。
 * 从 index.ts 抽出：3 个工具定义 + str_replace_editor 执行器 + 相关常量。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

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

export interface StrReplaceEditorParams {
	command: string;
	path: string;
	file_text?: string;
	insert_line?: number;
	new_str?: string;
	old_str?: string;
	view_range?: number[];
}

/** str_replace_editor 的纯函数执行器（node:fs 近似实现）。 */
function executeStrReplaceEditor(params: StrReplaceEditorParams, cwd: string): any {
	const abs = resolve(cwd, params.path ?? ".");
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
}

export interface MinimalToolsHooks {
	/** 解锁工具时回调（主函数负责记录并持久化 unlockedTools）。 */
	onUnlock(names: string[]): void;
}

/** 注册 Minimal 对齐的工具（bash re-register + str_replace_editor + dev_tool_search）。 */
export function registerMinimalTools(pi: ExtensionAPI, hooks: MinimalToolsHooks): void {
	const z = (pi as any).zod;
	const { onUnlock } = hooks;

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
			return executeStrReplaceEditor(params, ctx?.cwd ?? process.cwd());
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
				onUnlock(unlock);
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
}
