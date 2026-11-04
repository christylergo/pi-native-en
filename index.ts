/**
 * native-prompt — translate prompts into native English, right inside Pi.
 *
 * Trigger: end any input with the word "native" (e.g. "帮我翻译这句话 native").
 * The input is intercepted, never sent to the working session, and translated
 * by an independent LLM call whose history lives in its own state directory.
 *
 * When the translation completes, a right-aligned panel with the FULL
 * three-style result appears above the editor. It never takes focus — the
 * user can transcribe from it into the editor while it stays open, scrolling
 * with Alt+J/Alt+K. Submitting any input dismisses it.
 *
 * Keyboard (chosen to avoid pi defaults):
 *   Ctrl+1 / Ctrl+2 / Ctrl+3   inject Natural / Technical / Concise into the editor
 *   Alt+N                      interactive modal (select/copy/inject; Esc returns focus to the editor)
 *   Alt+J / Alt+K              scroll the panel down / up (works while typing)
 *
 * Commands:
 *   /native <text>             manual translation trigger
 *   /native model              pick the translator model from configured providers
 *   /native clear              clear the persistent translation history
 *
 * Install:   ./install.sh (repo) or keep this directory at
 *            ~/.pi/agent/extensions/native-prompt (auto-discovered)
 * Uninstall: run ./uninstall.sh  (or: rm -rf this directory and
 *            ~/.local/state/pi-native-translator), then restart pi.
 *
 * Footprint: the extension only ever writes to its own directory and to
 * ~/.local/state/pi-native-translator/. No settings.json changes, no packages,
 * no background processes; shortcuts and commands are process-level and
 * disappear on restart.
 */
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NativeOverlay, NativePanel } from "./panel.ts";
import {
	clearHistory,
	describeModel,
	loadConfig,
	recordChoice,
	saveConfig,
	STYLE_LABELS,
	translate,
	type PluginConfig,
	type StyleKey,
	type TranslationResult,
} from "./translator.ts";

const TRIGGER = /[ \t]*native[ \t]*$/i;

function extensionDir(): string {
	try {
		return path.dirname(fileURLToPath(import.meta.url));
	} catch {
		return path.join(os.homedir(), ".pi", "agent", "extensions", "native-prompt");
	}
}

export default async function main(pi: ExtensionAPI): Promise<void> {
	const dir = extensionDir();
	const config: PluginConfig = loadConfig(dir);

	// Channel B: register the plugin's private endpoint when configured.
	if (config.model.source === "custom" && config.model.baseUrl && config.model.model) {
		pi.registerProvider("native-prompt", {
			baseUrl: config.model.baseUrl,
			apiKey: config.model.apiKey ?? "local",
			api: config.model.api ?? "openai-completions",
			models: [
				{
					id: config.model.model,
					name: config.model.model,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
				},
			],
		});
	}

	let inFlight: AbortController | null = null;
	let last: { source: string; result: TranslationResult; modelLabel: string } | null = null;
	let panelOpen = false;
	const panel = new NativePanel();

	// -- helpers -------------------------------------------------------------

	function setStatus(ctx: ExtensionContext, text: string | undefined): void {
		try {
			if (ctx.hasUI) ctx.ui.setStatus("native-prompt", text);
		} catch {
			// Stale ctx after session switch: the next event refreshes state.
		}
	}

	function showPanel(ctx: ExtensionContext): void {
		if (!ctx.hasUI || !last) return;
		try {
			ctx.ui.setWidget("native-prompt", (tui, theme) => {
				panel.bind(tui as { requestRender(): void }, theme as unknown as { fg: (t: string, s: string) => string });
				return panel as never;
			});
			panel.set(last.source, last.result, last.modelLabel);
		} catch {
			// Stale ctx: the session_start handler re-registers the widget.
		}
	}

	function hidePanel(ctx: ExtensionContext): void {
		panel.clear();
		try {
			if (ctx.hasUI) ctx.ui.setWidget("native-prompt", undefined);
		} catch {
			// stale ctx
		}
	}

	function inject(ctx: ExtensionContext, style: StyleKey, text?: string): void {
		if (!last) {
			ctx.ui.notify("native-prompt: nothing to inject yet — send a prompt ending with 'native' first", "warning");
			return;
		}
		recordChoice(style);
		ctx.ui.setEditorText(text ?? last.result[style] ?? "");
		hidePanel(ctx);
		ctx.ui.notify(`native-prompt: injected ${STYLE_LABELS[style]}`, "info");
	}

	async function openPanel(ctx: ExtensionContext): Promise<void> {
		if (!last) {
			ctx.ui.notify("native-prompt: no translation yet — send a prompt ending with 'native' first", "warning");
			return;
		}
		if (panelOpen) return;
		panelOpen = true;
		try {
			const snapshot = last;
			const choice = await ctx.ui.custom(
				(_tui, theme, _keybindings, done) =>
					new NativeOverlay(
						theme as unknown as { fg: (t: string, s: string) => string },
						snapshot.source,
						snapshot.result,
						snapshot.modelLabel,
						done,
					) as never,
				{ overlay: true } as never,
			);
			// The panel is closed here (inject, copy-then-close, or Esc);
			// pi has already returned focus to the editor.
			if (choice) inject(ctx, choice.style, choice.text);
		} catch {
			// Stale ctx (session switch while the panel was open): drop quietly.
		} finally {
			panelOpen = false;
		}
	}

	// -- translation flow ---------------------------------------------------

	async function runTranslate(ctx: ExtensionContext, source: string): Promise<void> {
		if (!source.trim()) {
			ctx.ui.notify("native-prompt: append 'native' after your text to translate it", "warning");
			return;
		}
		inFlight?.abort();
		const abort = new AbortController();
		inFlight = abort;
		last = null;
		setStatus(ctx, `Translating · ${describeModel(config)}…`);
		try {
			const out = await translate(ctx, config, source, abort.signal);
			if (inFlight !== abort) return; // superseded by a newer trigger
			last = { source, result: out.result, modelLabel: out.modelLabel };
			setStatus(ctx, undefined);
			if (ctx.hasUI) {
				// Show the full-content panel passively — the editor keeps focus so
				// the user can transcribe straight from the panel while it is open.
				showPanel(ctx);
			} else if (ctx.mode === "print") {
				// Headless (/native in print mode): the only output channel.
				// Never print in json/rpc modes — stdout is a protocol stream there.
				console.log(`\n[native-prompt · ${out.modelLabel}]`);
				for (const key of ["natural", "technical", "concise"] as const) {
					console.log(`\n— ${STYLE_LABELS[key]} —\n${out.result[key]}`);
				}
			}
		} catch (err) {
			if (inFlight !== abort) return;
			setStatus(ctx, undefined);
			if (abort.signal.aborted) return;
			const message = err instanceof Error ? err.message : String(err);
			try {
				ctx.ui.notify(message, "error");
			} catch {
				// stale ctx
			}
			if (ctx.mode === "print") console.error(`[native-prompt] ${message}`);
		}
	}

	// -- model picker -------------------------------------------------------

	async function pickModel(ctx: ExtensionCommandContext): Promise<void> {
		let models: Array<{ provider?: string; id: string; name?: string }> = [];
		try {
			const registry = ctx.modelRegistry as unknown as { getAvailable?: () => Array<{ provider?: string; id: string; name?: string }> };
			models = registry.getAvailable?.() ?? [];
		} catch {
			models = [];
		}
		if (models.length === 0) {
			ctx.ui.notify("native-prompt: no models visible to the registry — set model/provider in config.json", "warning");
			return;
		}
		const labels = models.map((m) => `${m.provider ?? "?"}/${m.id}`);
		const pick = await ctx.ui.select("native-prompt: translator model", labels);
		if (pick === undefined) return;
		const hit = models[labels.indexOf(pick)];
		if (!hit) return;
		config.model = { source: "registry", provider: hit.provider ?? "", id: hit.id };
		saveConfig(dir, config);
		ctx.ui.notify(`native-prompt: model set to ${hit.provider ?? "?"}/${hit.id} (saved to config.json)`, "info");
	}

	// -- wiring -------------------------------------------------------------

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return;
		if (ctx.mode === "print") return;

		const match = TRIGGER.exec(event.text);
		if (match) {
			const source = event.text.slice(0, match.index).trim();
			if (!source) {
				ctx.ui.notify("native-prompt usage: <your text> native", "warning");
			} else {
				// Interactive: fire and forget — a translation can take 15s+, and
				// blocking input handling here would queue every later keystroke.
				// Stale-ctx races (session switch mid-flight) are handled inside.
				void runTranslate(ctx, source);
			}
			return { action: "handled" };
		}

		// Any submitted input dismisses the panel: the user quick-injected
		// earlier or finished transcribing their own version by hand.
		if (panel.hasContent) hidePanel(ctx);
	});

	pi.registerCommand("native", {
		description: "native-prompt: translate text / pick model / clear history",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const rest = (args ?? "").trim();
			if (rest === "model") return pickModel(ctx);
			if (rest === "clear") {
				clearHistory();
				ctx.ui.notify("native-prompt: translation history cleared", "info");
				return;
			}
			if (!rest) {
				ctx.ui.notify("native-prompt: /native <text> · /native model · /native clear", "info");
				return;
			}
			if (ctx.mode === "print") {
				await runTranslate(ctx, rest);
			} else {
				// Same rationale as the input trigger: never block on a 15s+ LLM call.
				void runTranslate(ctx, rest);
			}
		},
	});

	pi.registerShortcut("ctrl+1", {
		description: "native-prompt: inject Natural translation",
		handler: (ctx: ExtensionCommandContext) => inject(ctx, "natural"),
	});
	pi.registerShortcut("ctrl+2", {
		description: "native-prompt: inject Technical translation",
		handler: (ctx: ExtensionCommandContext) => inject(ctx, "technical"),
	});
	pi.registerShortcut("ctrl+3", {
		description: "native-prompt: inject Concise translation",
		handler: (ctx: ExtensionCommandContext) => inject(ctx, "concise"),
	});
	pi.registerShortcut("alt+n", {
		description: "native-prompt: interactive translation panel",
		handler: (ctx: ExtensionCommandContext) => void openPanel(ctx),
	});
	pi.registerShortcut("alt+j", {
		description: "native-prompt: scroll translation panel down",
		handler: () => panel.scrollBy(1),
	});
	pi.registerShortcut("alt+k", {
		description: "native-prompt: scroll translation panel up",
		handler: () => panel.scrollBy(-1),
	});

	// After a session switch the widget binding is gone; restore it if the
	// panel still has content.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI && last) showPanel(ctx);
	});
}
