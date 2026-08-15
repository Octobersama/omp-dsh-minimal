import { describe, expect, test } from "bun:test";
import {
	BASE_TOOLS,
	DSH_CLOSE_MARKER,
	DSH_MARKER,
	DSH_PERSONA,
	DEFAULT_MINIMAL_TOOLS,
	PRESETS,
	MID_TOOLS,
	assembleSystemPrompt,
	buildDshBlock,
	defaultModelConfig,
	matchesModel,
	mergeToolNames,
	readCsv,
} from "../index";

const BLOCK = `<<<dsh-minimal>>>\nYou are a helpful software engineer assistant.\n<<< /dsh-minimal >>>`;

describe("buildDshBlock", () => {
	test("carries exactly the DSH persona plus paired tags", () => {
		expect(buildDshBlock()).toBe(BLOCK);
		expect(BLOCK).toContain(DSH_MARKER);
		expect(BLOCK).toContain(DSH_CLOSE_MARKER);
		expect(BLOCK).toContain(DSH_PERSONA);
	});

	test("the block contains no tool-calling guidance", () => {
		const block = buildDshBlock();
		expect(block).not.toContain("bash");
		expect(block).not.toContain("str_replace");
		expect(block).not.toContain("command");
	});
});

describe("defaultModelConfig", () => {
	test("defaults to the a0b4-decomposed config with MCP on", () => {
		const cfg = defaultModelConfig();
		expect(cfg).toEqual({
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
		});
	});

	test("fresh per-model configs are independent instances", () => {
		const a = defaultModelConfig();
		const b = defaultModelConfig();
		a.enabled = false;
		expect(b.enabled).toBe(true);
	});
});

describe("assembleSystemPrompt", () => {
	test("none placement returns the blocks untouched", () => {
		const input = ["block A", "block B"];
		expect(assembleSystemPrompt(input, "none")).toEqual(["block A", "block B"]);
		expect(input).toEqual(["block A", "block B"]);
	});

	test("appends the persona at the very end of the last block by default", () => {
		const result = assembleSystemPrompt(["block A", "block B"], "end");
		expect(result).toEqual(["block A", `block B\n\n${BLOCK}`]);
	});

	test("prepends a standalone block at the very start when requested", () => {
		const result = assembleSystemPrompt(["block A", "block B"], "start");
		expect(result).toEqual([BLOCK, "block A", "block B"]);
	});

	test("default placement carries the block at both start and end", () => {
		const result = assembleSystemPrompt(["block A"]);
		expect(result).toEqual([BLOCK, `block A\n\n${BLOCK}`]);
	});

	test("both placement on an empty prompt adds the block once", () => {
		expect(assembleSystemPrompt([], "both")).toEqual([BLOCK]);
	});

	test("handles an empty prompt by adding the block", () => {
		expect(assembleSystemPrompt([], "end")).toEqual([BLOCK]);
	});

	test("is idempotent: returns null when the marker is already present", () => {
		const once = assembleSystemPrompt(["plain"], "end");
		expect(once).not.toBeNull();
		expect(assembleSystemPrompt(once!, "end")).toBeNull();
	});

	test("does not mutate the input array", () => {
		const input = ["block A"];
		assembleSystemPrompt(input, "end");
		expect(input).toEqual(["block A"]);
	});
});

describe("readCsv", () => {
	test("defaults when unset or empty", () => {
		expect(readCsv(undefined, DEFAULT_MINIMAL_TOOLS)).toEqual(DEFAULT_MINIMAL_TOOLS);
		expect(readCsv("  , , ", DEFAULT_MINIMAL_TOOLS)).toEqual(DEFAULT_MINIMAL_TOOLS);
	});

	test("parses and trims a comma list", () => {
		expect(readCsv("bash, read ,write", ["bash"])).toEqual(["bash", "read", "write"]);
	});
});

describe("mergeToolNames", () => {
	test("unions late-joining tools into the snapshot without losing the original set", () => {
		const base = ["read", "bash", "edit", "write", "eval", "grep"];
		const late = ["bash", "read", "write", "edit", "mcp__chrome_devtools_click", "mcp__github_search_code"];
		expect(mergeToolNames(base, late)).toEqual([
			"read",
			"bash",
			"edit",
			"write",
			"eval",
			"grep",
			"mcp__chrome_devtools_click",
			"mcp__github_search_code",
		]);
	});

	test("an empty extra set leaves the base untouched", () => {
		expect(mergeToolNames(["read", "bash"], [])).toEqual(["read", "bash"]);
	});
});

describe("PRESETS", () => {
	test("covers the six shipped presets", () => {
		expect(Object.keys(PRESETS).sort()).toEqual(["a0b0", "a0b4", "a0b5", "a1b0", "a1b5", "a2b0"]);
	});

	test("maps modes to prompt and roster tiers", () => {
		expect(PRESETS.a0b0).toEqual({ prompt: "persona", tools: "base" });
		expect(PRESETS.a1b0).toEqual({ prompt: "role", tools: "base" });
		expect(PRESETS.a2b0).toEqual({ prompt: "policy", tools: "base" });
		expect(PRESETS.a0b4).toEqual({ prompt: "persona", tools: "full" });
		expect(PRESETS.a0b5).toEqual({ prompt: "persona", tools: "mid" });
		expect(PRESETS.a1b5).toEqual({ prompt: "role", tools: "mid" });
	});

	test("roster tiers are distinct and include the DSH base", () => {
		expect(BASE_TOOLS).toEqual(["bash", "read", "write", "edit"]);
		expect(MID_TOOLS.slice(0, BASE_TOOLS.length)).toEqual(BASE_TOOLS);
		expect(MID_TOOLS).toContain("eval");
		expect(MID_TOOLS).toContain("task");
		expect(DEFAULT_MINIMAL_TOOLS.length).toBeGreaterThan(MID_TOOLS.length);
		for (const tool of BASE_TOOLS) {
			expect(DEFAULT_MINIMAL_TOOLS).toContain(tool);
		}
	});
});

describe("matchesModel", () => {
	const cases: Array<[string, boolean]> = [
		// Allow-listed DeepSeek V4 models
		["lithoapi/deepseek-v4-flash", true],
		["lithoapi/deepseek-v4-flash:max", true],
		["lithoapi/deepseek-v4-flash-0731", true],
		["deepseek/deepseek-v4-pro", true],
		["lithoapi/deepseek-v4-pro-0813", true],
		["lithoapi/deepseek-v4-pro-0813:max", true],
		// Other models stay untouched
		["lithoapi/deepseek-v3", false],
		["deepseek/deepseek-reasoner", false],
		["anthropic/claude-sonnet-4-5", false],
		["lithoapi/gpt-5.6-sol", false],
		["", false],
		[undefined, false],
	];

	for (const [modelId, expected] of cases) {
		test(`${String(modelId) || "<empty>"} -> ${expected}`, () => {
			expect(matchesModel(modelId)).toBe(expected);
		});
	}

	test("env override replaces the default pattern", () => {
		expect(matchesModel("lithoapi/deepseek-v3", "v3")).toBe(true);
		expect(matchesModel("lithoapi/deepseek-v4-flash", "v3")).toBe(false);
	});
});
