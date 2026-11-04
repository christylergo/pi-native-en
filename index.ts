/**
 * native-prompt — translate prompts into native English, right inside Pi.
 *
 * Trigger: end any input with the word "native" (e.g. "帮我翻译这句话 native").
 * The input is intercepted, never sent to the working session, and translated
 * by an independent LLM call whose history lives in its own state directory.
 *
 * On trigger the panel appears immediately above the editor (centered,
 * content-adaptive width) and the translation streams into it live. The panel
 * never takes focus and never covers the input bar — all interactions are
 * global shortcuts that work while typing:
 *
 *   Ctrl+1 / Ctrl+2 / Ctrl+3   inject Natural / Technical / Concise
 *   Alt+I                      inject the currently selected style
 *   Alt+H / Alt+L              select previous / next style (▍ marks it)
 *   Alt+C                      copy the selected style to the clipboard
 *   Alt+J / Alt+K              scroll the panel down / up
 *   Alt+W                      close the panel
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
import { copyToClipboard, NativePanel } from "./panel.ts";
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

const WIDGET_ID = "native-prompt";
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
	const panel = new NativePanel();

	// -- helpers -------------------------------------------------------------

	function setStatus(ctx: ExtensionContext, text: string | undefined): void {
		try {
			if (ctx.hasUI) ctx.ui.setStatus("native-prompt", text);
		} catch {
			// Stale ctx after session switch: the next event refreshes state.
		}
	}

	function mountWidget(ctx: ExtensionContext): void {
		try {
			if (!ctx.hasUI) return;
			// The widget slot sits above the editor: the input bar is never
			// covered, and the factory theme is the full theme (with fg()).
			ctx.ui.setWidget(WIDGET_ID, (tui, theme) => {
				panel.bind(tui as { requestRender(): void }, theme);
				return panel as never;
			});
		} catch {
			// Stale ctx: session_start re-registers the widget.
		}
	}

	function unmountWidget(ctx: ExtensionContext): void {
		panel.clear();
		try {
			if (ctx.hasUI) ctx.ui.setWidget(WIDGET_ID, undefined);
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
		unmountWidget(ctx);
		ctx.ui.notify(`native-prompt: injected ${STYLE_LABELS[style]}`, "info");
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
		if (ctx.hasUI) {
			// The panel appears immediately at trigger time; the model's
			// progress streams into it.
			mountWidget(ctx);
			panel.showLoading(source, describeModel(config));
		} else {
			setStatus(ctx, `Translating · ${describeModel(config)}…`);
		}
		try {
			const out = await translate(ctx, config, source, abort.signal, (partial, thinking) => {
				panel.showStreaming(source, describeModel(config), partial, thinking);
			});
			if (inFlight !== abort) return; // superseded by a newer trigger
			last = { source, result: out.result, modelLabel: out.modelLabel };
			setStatus(ctx, undefined);
			if (ctx.hasUI) {
				panel.showDone(source, out.result, out.modelLabel);
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
			if (abort.signal.aborted) {
				unmountWidget(ctx);
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			try {
				if (ctx.hasUI) panel.showError(message);
				else ctx.ui.notify(message, "error");
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
		if (panel.active) unmountWidget(ctx);
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

	// -- shortcuts (all interaction lives in the panel itself) -------------

	pi.registerShortcut("ctrl+1", {
		description: "native-prompt: inject Natural translation",
		handler: (ctx: ExtensionCommandContext) => {
			panel.selectIndex(0);
			inject(ctx, "natural");
		},
	});
	pi.registerShortcut("ctrl+2", {
		description: "native-prompt: inject Technical translation",
		handler: (ctx: ExtensionCommandContext) => {
			panel.selectIndex(1);
			inject(ctx, "technical");
		},
	});
	pi.registerShortcut("ctrl+3", {
		description: "native-prompt: inject Concise translation",
		handler: (ctx: ExtensionCommandContext) => {
			panel.selectIndex(2);
			inject(ctx, "concise");
		},
	});
	pi.registerShortcut("alt+i", {
		description: "native-prompt: inject the selected translation",
		handler: (ctx: ExtensionCommandContext) => {
			const style = panel.selectedStyle;
			if (style) inject(ctx, style);
			else ctx.ui.notify("native-prompt: no translation yet", "warning");
		},
	});
	pi.registerShortcut("alt+h", {
		description: "native-prompt: select previous translation style",
		handler: () => panel.selectBy(-1),
	});
	pi.registerShortcut("alt+l", {
		description: "native-prompt: select next translation style",
		handler: () => panel.selectBy(1),
	});
	pi.registerShortcut("alt+c", {
		description: "native-prompt: copy the selected translation",
		handler: (ctx: ExtensionCommandContext) => {
			const text = panel.selectedText;
			if (!text) {
				ctx.ui.notify("native-prompt: nothing selected", "warning");
				return;
			}
			void copyToClipboard(text).then((ok) =>
				ctx.ui.notify(ok ? "native-prompt: copied to clipboard" : "native-prompt: no clipboard helper (wl-copy/xclip)", ok ? "info" : "warning"),
			);
		},
	});
	pi.registerShortcut("alt+j", {
		description: "native-prompt: scroll translation panel down",
		handler: () => panel.scrollBy(1),
	});
	pi.registerShortcut("alt+k", {
		description: "native-prompt: scroll translation panel up",
		handler: () => panel.scrollBy(-1),
	});
	pi.registerShortcut("alt+w", {
		description: "native-prompt: close translation panel",
		handler: (ctx: ExtensionCommandContext) => {
			if (panel.active) unmountWidget(ctx);
		},
	});

	// After a session switch the widget binding is gone; restore it if the
	// panel still has content.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI && (panel.active || last)) mountWidget(ctx);
	});
}
