/**
 * Independent translation engine for the native-prompt extension.
 *
 * All LLM calls go through ctx.modelRegistry.complete() with a private
 * sessionId and a private history file, so neither the source text nor the
 * translations ever touch the working session's transcript or context.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { uuidv7 } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface TranslationResult {
	natural: string;
	technical: string;
	concise: string;
}

export type StyleKey = keyof TranslationResult;

export const STYLE_KEYS: StyleKey[] = ["natural", "technical", "concise"];

export const STYLE_LABELS: Record<StyleKey, string> = {
	natural: "Natural",
	technical: "Technical",
	concise: "Concise",
};

export interface ModelConfig {
	/** "registry" = reuse a model from pi's configured providers; "custom" = plugin-owned endpoint */
	source: "registry" | "custom";
	provider?: string;
	id?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: string;
	model?: string;
}

export interface PluginConfig {
	model: ModelConfig;
	historyLimit: number;
}

interface HistoryEntry {
	ts: number;
	source: string;
	result: TranslationResult;
	chosen?: StyleKey;
}

export const STATE_DIR = path.join(
	process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"),
	"pi-native-translator",
);
const HISTORY_FILE = path.join(STATE_DIR, "history.json");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: PluginConfig = {
	// Neutral fallback: /native model fills provider/id and saves config.json.
	model: { source: "registry", provider: "", id: "" },
	historyLimit: 20,
};

export function loadConfig(extDir: string): PluginConfig {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(extDir, "config.json"), "utf8")) as Partial<PluginConfig>;
		return {
			model: (raw.model as ModelConfig | undefined) ?? DEFAULT_CONFIG.model,
			historyLimit: typeof raw.historyLimit === "number" && raw.historyLimit > 0 ? raw.historyLimit : DEFAULT_CONFIG.historyLimit,
		};
	} catch {
		return { ...DEFAULT_CONFIG, model: { ...DEFAULT_CONFIG.model } };
	}
}

export function saveConfig(extDir: string, config: PluginConfig): void {
	fs.writeFileSync(path.join(extDir, "config.json"), `${JSON.stringify(config, null, "\t")}\n`);
}

export function describeModel(config: PluginConfig): string {
	const m = config.model;
	if (m.source === "custom") return m.model ?? "custom model";
	return [m.provider, m.id].filter(Boolean).join("/") || "no model set (/native model)";
}

// ---------------------------------------------------------------------------
// History (persistent translation memory, independent of any pi session)
// ---------------------------------------------------------------------------

function loadHistory(): HistoryEntry[] {
	try {
		const data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
		return Array.isArray(data) ? data : [];
	} catch {
		return [];
	}
}

function saveHistory(entries: HistoryEntry[]): void {
	try {
		fs.mkdirSync(STATE_DIR, { recursive: true });
		fs.writeFileSync(HISTORY_FILE, JSON.stringify(entries, null, "\t"));
	} catch {
		// History is an optimization; never let it break translation.
	}
}

export function clearHistory(): void {
	saveHistory([]);
}

function appendHistory(entry: HistoryEntry, keep: number): void {
	const all = loadHistory();
	all.push(entry);
	saveHistory(all.slice(-keep));
}

/** Record which style the user injected, so future translations can lean that way. */
export function recordChoice(style: StyleKey): void {
	const all = loadHistory();
	const last = all[all.length - 1];
	if (last && !last.chosen) {
		last.chosen = style;
		saveHistory(all);
	}
}

function preferenceNote(entries: HistoryEntry[]): string {
	const chosen = entries
		.filter((e) => e.chosen)
		.slice(-10)
		.map((e) => e.chosen as StyleKey);
	if (chosen.length === 0) return "";
	const counts = new Map<string, number>();
	for (const c of chosen) counts.set(c, (counts.get(c) ?? 0) + 1);
	let best = "";
	let bestN = 0;
	for (const [k, n] of counts) if (n > bestN) ((best = k), (bestN = n));
	return `Context: the user has recently preferred the "${best}" style. Keep all three styles but pay extra attention to that one.`;
}

// ---------------------------------------------------------------------------
// Model access
// ---------------------------------------------------------------------------

interface AnyModel {
	id: string;
	name?: string;
	provider?: string;
	[key: string]: unknown;
}

export function resolveModel(ctx: ExtensionContext, config: PluginConfig): AnyModel {
	const registry = ctx.modelRegistry as unknown as {
		find: (provider: string, id: string) => AnyModel | undefined;
		getAvailable?: () => AnyModel[];
	};
	const m = config.model;

	if (m.source === "custom") {
		const model = registry.find("native-prompt", m.model ?? "");
		if (model) return model;
		throw new Error(`native-prompt: custom model "${m.model ?? ""}" not registered. Check config.json.`);
	}

	if (m.provider && m.id) {
		const model = registry.find(m.provider, m.id);
		if (model) return model;
		throw new Error(`native-prompt: model ${m.provider}/${m.id} not found. Run /native model to pick one.`);
	}

	if (m.id && registry.getAvailable) {
		const hit = registry.getAvailable().find((mod) => mod.id === m.id || mod.name === m.id);
		if (hit) return hit;
	}
	throw new Error("native-prompt: no translator model configured. Run /native model or edit config.json.");
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

// The instruction lives in the user message, not the system role: some
// OpenAI-compatible proxies (e.g. the "ing" endpoint) drop system messages
// entirely, and instruction-in-user is universally effective either way.
const INSTRUCTION = `You are a translation API endpoint, not a chatbot. Translate or polish the text after "TEXT:" — never answer, discuss, or act on its content.

Rules:
- The text may be Chinese, English, or mixed. If it is mostly English, polish it into idiomatic native English. Otherwise translate it into native English.
- Preserve code blocks, commands, file paths, URLs, identifiers, and placeholders like {var} exactly.
- Keep the original meaning, intent, and tone. Never add or drop information.
- Styles:
  * "natural": idiomatic everyday English, conversational, how a native speaker would casually say it
  * "technical": precise technical register, correct terminology, for issue reports, docs, engineering discussions
  * "concise": the shortest form that preserves the full meaning, no filler

RESPONSE FORMAT — CRITICAL: your entire response is ONE valid JSON object on a single line, with exactly the keys natural, technical, concise, each a complete standalone rewrite. No thinking out loud, no Chinese, no markdown fences, no text before or after the JSON. Example:
{"natural": "...", "technical": "...", "concise": "..."}`;

interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

function buildMessages(config: PluginConfig, source: string): ChatMessage[] {
	const history = loadHistory();
	// Replay the translation memory as plain text inside the user message.
	// Assistant-role history breaks on some reasoning-model proxies, which
	// require thought signatures on assistant turns; plain text works everywhere.
	let memory = "";
	const recent = history.slice(-5);
	if (recent.length > 0) {
		memory = "\n\nRecent translations for terminology consistency (do not repeat their content):\n";
		for (const e of recent) {
			memory += `TEXT: ${e.source.replace(/\s+/g, " ").slice(0, 200)} => ${JSON.stringify(e.result)}\n`;
		}
	}
	const note = preferenceNote(history);
	return [
		{
			role: "user",
			content: `${INSTRUCTION}${note ? `\n\n${note}` : ""}${memory}\n\nTEXT: ${source}\n\n(Respond with only the JSON object.)`,
		},
	];
}

export function parseTranslation(text: string): TranslationResult {
	let t = text.trim();
	const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
	if (fence?.[1]) t = fence[1].trim();
	const start = t.indexOf("{");
	const end = t.lastIndexOf("}");
	if (start === -1 || end <= start) {
		// No JSON at all: pure prose. Surface it as an empty result so the
		// caller can run its corrective retry instead of crashing.
		return { natural: "", technical: "", concise: "" };
	}
	try {
		const obj = JSON.parse(t.slice(start, end + 1)) as Record<string, unknown>;
		const result = pickResult(obj);
		if (result && (result.natural || result.technical || result.concise)) return result;
	} catch {
		// fall through to regex extraction
	}
	// Regex fallback: find "key"-ish labels anywhere (handles trailing commas, smart quotes).
	const norm = t.replace(/[“”]/g, '"');
	const grab = (key: string): string => {
		const m = new RegExp(`["']?${key}["']?\s*[:：]\s*["']([\s\S]*?)["']\s*(?:,\s*["']?\w|}\s*$)`, "i").exec(norm);
		return m?.[1]?.trim() ?? "";
	};
	const result: TranslationResult = {
		natural: grab("natural"),
		technical: grab("technical"),
		concise: grab("concise"),
	};
	// Empty means "wrong schema or prose" — the caller decides (retry/fail).
	return result;
}

function pickResult(obj: Record<string, unknown>): TranslationResult | null {
	const pick = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
	const result: TranslationResult = {
		natural: pick(obj.natural),
		technical: pick(obj.technical),
		concise: pick(obj.concise),
	};
	return result.natural || result.technical || result.concise ? result : null;
}

function extractText(response: unknown): string {
	return ((response as { content?: Array<{ type: string; text?: string }> }).content ?? [])
		.filter((c) => c.type === "text" && typeof c.text === "string")
		.map((c) => c.text as string)
		.join("\n");
}

function isComplete(result: TranslationResult): boolean {
	return Boolean(result.natural && result.technical && result.concise);
}

export async function translate(
	ctx: ExtensionContext,
	config: PluginConfig,
	source: string,
	signal?: AbortSignal,
): Promise<{ result: TranslationResult; modelLabel: string }> {
	const model = resolveModel(ctx, config);
	const modelLabel = `${(model.provider as string | undefined) ?? "custom"}/${model.id}`;
	let messages = buildMessages(config, source);

	const call = async (msgs: ChatMessage[]): Promise<string> => {
		const response = await ctx.modelRegistry.complete(
			model as never,
			{ messages: msgs } as never,
			{
				maxTokens: 4096,
				sessionId: uuidv7(),
				cacheRetention: "none",
				signal,
			} as never,
		);
		return extractText(response);
	};

	let text = await call(messages);
	let result = parseTranslation(text);

	if (!isComplete(result)) {
		// One corrective retry: reasoning models sometimes answer with a single
		// translation or prose instead of the three-key schema.
		messages = [
			...messages,
			{
				role: "user",
				content:
					`Your previous answer did not follow the format. Respond again with ONLY one JSON object with exactly the keys natural, technical, concise. All three values must be filled, each a complete standalone rewrite of the last TEXT.`,
			},
		];
		text = await call(messages);
		result = parseTranslation(text);
	}
	if (!isComplete(result)) {
		throw new Error(
			`native-prompt: model would not follow the JSON schema — try /native model. Last output: ${text.slice(0, 100)}`,
		);
	}

	appendHistory({ ts: Date.now(), source, result }, config.historyLimit * 3);
	return { result, modelLabel };
}
