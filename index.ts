/**
 * native-prompt — translate prompts into native English, right inside Pi.
 *
 * Trigger: end any input with the word "native" (e.g. "帮我翻译这句话 native").
 * The input is intercepted, never sent to the working session, and translated
 * by an independent LLM call whose history lives in its own state directory.
 *
 * Keyboard (chosen to avoid pi defaults):
 *   Ctrl+1 / Ctrl+2 / Ctrl+3   inject Natural / Technical / Concise into the editor
 *   Alt+N                      open the full-text overlay (reopen last results)
 *   Alt+W                      dismiss the side panel
 *
 * Commands:
 *   /native <text>             manual translation trigger
 *   /native model              pick the translator model from configured providers
 *   /native clear              clear the persistent translation history
 *
 * Install:   this directory at ~/.pi/agent/extensions/native-prompt (auto-discovered)
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
import { NativeOverlay, NativeWidget, type PanelState } from "./panel.ts";
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

	const widget = new NativeWidget();
	let inFlight: AbortController | null = null;
	let last: { source: string; result: TranslationResult; modelLabel: string } | null = null;
	let visible = false;

	// -- panel lifecycle ----------------------------------------------------

	// The ctx that started a translation can go stale (session replacement,
	// reload, or process teardown in print mode) while the LLM call is in
	// flight. Panel updates must never crash on that; degrade silently.
	function safeShow(ctx: ExtensionContext, state: PanelState): void {
		try {
			show(ctx, state);
		} catch {
			widget.update(state);
		}
	}

	function safeHide(ctx: ExtensionContext): void {
		try {
			hide(ctx);
		} catch {
			widget.update(null);
		}
	}

	function show(ctx: ExtensionContext, state: PanelState): void {
		visible = ctx.hasUI;
		if (ctx.hasUI) {
			ctx.ui.setWidget(WIDGET_ID, (tui, theme) => {
				widget.bind(tui as { requestRender(): void }, theme as unknown as { fg: (t: string, s: string) => string });
				return widget as never;
			});
		}
		widget.update(state);
	}

	function hide(ctx: ExtensionContext): void {
		visible = false;
		widget.update(null);
		if (ctx.hasUI) ctx.ui.setWidget(WIDGET_ID, undefined);
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
		safeShow(ctx, { phase: "loading", source, modelLabel: describeModel(config) });
		try {
			const out = await translate(ctx, config, source, abort.signal);
			if (inFlight !== abort) return; // superseded by a newer trigger
			last = { source, result: out.result, modelLabel: out.modelLabel };
			safeShow(ctx, { phase: "done", source, result: out.result, modelLabel: out.modelLabel });
			if (ctx.mode === "print") {
				// Headless (/native in print mode): the only output channel.
				// Never print in json/rpc modes — stdout is a protocol stream there.
				console.log(`\n[native-prompt · ${out.modelLabel}]`);
				for (const key of ["natural", "technical", "concise"] as const) {
					console.log(`\n— ${STYLE_LABELS[key]} —\n${out.result[key]}`);
				}
			}
		} catch (err) {
			if (inFlight !== abort) return;
			if (abort.signal.aborted) {
				safeHide(ctx);
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			safeShow(ctx, { phase: "error", message });
			if (ctx.mode === "print") console.error(`[native-prompt] ${message}`);
		}
	}

	function inject(ctx: ExtensionContext, style: StyleKey): void {
		if (!last) {
			ctx.ui.notify("native-prompt: nothing to inject yet — send a prompt ending with 'native' first", "warning");
			return;
		}
		recordChoice(style);
		ctx.ui.setEditorText(last.result[style] ?? "");
		hide(ctx);
		ctx.ui.notify(`native-prompt: injected ${STYLE_LABELS[style]}`, "info");
	}

	async function openOverlay(ctx: ExtensionContext): Promise<void> {
		if (!last) {
			ctx.ui.notify("native-prompt: no translation yet — send a prompt ending with 'native' first", "warning");
			return;
		}
		const choice = await ctx.ui.custom(
			(_tui, theme, _keybindings, done) =>
				new NativeOverlay(
					theme as unknown as { fg: (t: string, s: string) => string },
					last!.source,
					last!.result,
					last!.modelLabel,
					done,
				) as never,
			{ overlay: true } as never,
		);
		if (choice) {
			recordChoice(choice.style);
			ctx.ui.setEditorText(choice.text);
			hide(ctx);
			ctx.ui.notify(`native-prompt: injected ${STYLE_LABELS[choice.style]}`, "info");
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
			} else if (ctx.mode === "print") {
				// Print mode tears the session down when this handler returns;
				// only awaiting keeps the ctx alive for the whole call.
				await runTranslate(ctx, source);
			} else {
				// Interactive: fire and forget — a translation can take 15s+, and
				// blocking input handling here would queue every later keystroke.
				// Stale-ctx races (session switch mid-flight) are handled by
				// safeShow/safeHide.
				void runTranslate(ctx, source);
			}
			return { action: "handled" };
		}

		// Any submitted input means the user is done with the panel
		// (they either quick-injected earlier or typed their own version).
		if (visible) safeHide(ctx);
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
		description: "native-prompt: open full translation panel",
		handler: (ctx: ExtensionCommandContext) => void openOverlay(ctx),
	});
	pi.registerShortcut("alt+w", {
		description: "native-prompt: dismiss translation panel",
		handler: (ctx: ExtensionCommandContext) => {
			if (visible) hide(ctx);
		},
	});

	// After a session switch the widget binding is gone; restore it if the
	// panel should still be visible.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI && visible && last) {
			show(ctx, { phase: "done", source: last.source, result: last.result, modelLabel: last.modelLabel });
		}
	});
}
