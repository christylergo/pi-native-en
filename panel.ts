/**
 * UI components for the native-prompt extension.
 *
 * - NativeSidePanel: stateful panel content (loading / streaming / done /
 *   error) rendered inside the editor component's right side. It never takes
 *   focus; scrolling is driven by global shortcuts.
 * - PanelEditor: wraps pi's real editor (CustomEditor). When the panel is
 *   active it renders the editor narrower (its text wraps) and draws the
 *   panel beside it; when inactive it is a pure pass-through.
 * - NativeOverlay: the interactive modal (Alt+N) for selection/copy/inject.
 */
import { spawn } from "node:child_process";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { STYLE_KEYS, STYLE_LABELS, type StyleKey, type TranslationResult } from "./translator.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface ThemeLike {
	fg: (token: string, text: string) => string;
}

interface TuiLike {
	requestRender(): void;
}

function padTo(s: string, len: number): string {
	const v = visibleWidth(s);
	return s + " ".repeat(Math.max(0, len - v));
}

function drawBox(theme: ThemeLike | null, innerLines: string[], inner: number, title: string): string[] {
	const c = theme ? theme.fg("border", "│") : "│";
	const shown = truncateToWidth(title, Math.max(4, inner - 4));
	const dashes = Math.max(0, inner - shown.length - 3);
	const top = theme
		? theme.fg("border", `╭─ ${shown} `) + theme.fg("border", "─".repeat(dashes)) + theme.fg("border", "╮")
		: `╭─ ${shown} ${"─".repeat(dashes)}╮`;
	const bottom = theme ? theme.fg("border", `╰${"─".repeat(inner)}╯`) : `╰${"─".repeat(inner)}╯`;
	const rows = innerLines.map((l) => (visibleWidth(l) > inner ? truncateToWidth(l, inner) : l));
	return [top, ...rows.map((l) => c + padTo(l, inner) + c), bottom];
}

// ---------------------------------------------------------------------------
// Clipboard
// ---------------------------------------------------------------------------

export async function copyToClipboard(text: string): Promise<boolean> {
	const attempts: Array<[string, string[]]> = [
		["wl-copy", []],
		["xclip", ["-selection", "clipboard"]],
		["xsel", ["--clipboard", "--input"]],
		["pbcopy", []],
	];
	for (const [bin, args] of attempts) {
		try {
			await new Promise<void>((resolve, reject) => {
				const p = spawn(bin, args, { stdio: ["pipe", "ignore", "ignore"] });
				p.on("error", reject);
				p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
				p.stdin.write(text);
				p.stdin.end();
			});
			return true;
		} catch {
			// try the next helper
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// Side panel: content states rendered in the editor's right side
// ---------------------------------------------------------------------------

const CONTENT_HEIGHT = 18;

type PanelState =
	| { phase: "loading"; source: string; modelLabel: string }
	| { phase: "streaming"; source: string; modelLabel: string; partial: string }
	| { phase: "done"; source: string; result: TranslationResult; modelLabel: string }
	| { phase: "error"; message: string };

export class NativeSidePanel {
	private state: PanelState | null = null;
	private offset = 0; // manual scroll offset for the "done" phase
	private tui: TuiLike | null = null;
	private theme: ThemeLike | null = null;
	private sections: string[][] = [];
	private wrapWidth = 0;

	get active(): boolean {
		return this.state !== null;
	}

	get scrollable(): boolean {
		return this.state?.phase === "done" && this.totalLines() > CONTENT_HEIGHT;
	}

	attach(tui: TuiLike, theme: ThemeLike | null): void {
		this.tui = tui;
		// Different pi factories hand out different theme shapes: widgets and
	// overlays get a full theme with fg(), the editor factory gets an editor
	// theme without it. Normalize once here so rendering can never crash.
		this.theme = theme && typeof (theme as { fg?: unknown }).fg === "function" ? theme : null;
	}

	private requestRender(): void {
		this.tui?.requestRender();
	}

	showLoading(source: string, modelLabel: string): void {
		this.state = { phase: "loading", source, modelLabel };
		this.offset = 0;
		this.wrapWidth = 0;
		this.requestRender();
	}

	showStreaming(source: string, modelLabel: string, partial: string): void {
		if (this.state?.phase === "done" || this.state?.phase === "error") return; // finished already
		this.state = { phase: "streaming", source, modelLabel, partial };
		this.requestRender();
	}

	showDone(source: string, result: TranslationResult, modelLabel: string): void {
		this.state = { phase: "done", source, result, modelLabel };
		this.offset = 0;
		this.wrapWidth = 0;
		this.requestRender();
	}

	showError(message: string): void {
		this.state = { phase: "error", message };
		this.requestRender();
	}

	clear(): void {
		if (!this.state) return;
		this.state = null;
		this.requestRender();
	}

	/** Scroll by delta lines (global shortcuts; works while typing). */
	scrollBy(delta: number): void {
		if (this.state?.phase !== "done") return;
		const max = Math.max(0, this.totalLines() - CONTENT_HEIGHT);
		this.offset = Math.min(Math.max(0, this.offset + delta), max);
		this.requestRender();
	}

	private totalLines(): number {
		return this.sections.reduce((n, s) => n + s.length, 0);
	}

	private rebuildDone(wrapAt: number): void {
		this.wrapWidth = wrapAt;
		const th = this.theme;
		const st = this.state as Extract<PanelState, { phase: "done" }>;
		this.sections = STYLE_KEYS.map((key) => {
			const header = th ? th.fg("accent", STYLE_LABELS[key]) : STYLE_LABELS[key];
			return [header, ...wrapTextWithAnsi(st.result[key] ?? "", wrapAt), ""];
		});
		const max = Math.max(0, this.totalLines() - CONTENT_HEIGHT);
		this.offset = Math.min(this.offset, max);
	}

	invalidate(): void {}

	/** Render the panel box; the caller places it (right side of the editor). */
	render(width: number): string[] {
		if (!this.state) return [];
		const th = this.theme;
		const inner = Math.max(20, width - 2);
		const wrapAt = inner - 2;
		const lines: string[] = [];
		let title = "Native";

		const st = this.state;
		if (st.phase === "loading") {
			title = `Native · ${st.modelLabel}`;
			lines.push(` ${th ? th.fg("accent", "⠋ Contacting model…") : "Contacting model…"}`);
			lines.push("");
			lines.push(` ${th ? th.fg("dim", `◧ ${truncateToWidth(st.source.replace(/\s+/g, " ").trim(), inner - 6)}`) : truncateToWidth(st.source, inner - 2)}`);
			lines.push("");
			lines.push(` ${th ? th.fg("dim", "The translation will stream in here.") : ""}`);
		} else if (st.phase === "streaming") {
			title = `Native · translating… ${st.partial.length}c`;
			// Show the tail of the stream, auto-following.
			const wrapped = wrapTextWithAnsi(st.partial || "…", wrapAt);
			const tail = wrapped.slice(-CONTENT_HEIGHT);
			for (const l of tail) lines.push(` ${l}`);
			lines.push("");
			lines.push(` ${th ? th.fg("dim", "streaming — a new trigger cancels") : ""}`);
		} else if (st.phase === "done") {
			title = `Native · ${st.modelLabel}`;
			if (wrapAt !== this.wrapWidth || this.sections.length === 0) this.rebuildDone(wrapAt);
			lines.push(` ${th ? th.fg("dim", `◧ ${truncateToWidth(st.source.replace(/\s+/g, " ").trim(), inner - 6)}`) : truncateToWidth(st.source, inner - 2)}`);
			lines.push("");
			let cursor = 0;
			for (const section of this.sections) {
				for (const line of section) {
					if (cursor >= this.offset && cursor < this.offset + CONTENT_HEIGHT) lines.push(` ${line}`);
					cursor++;
				}
			}
		} else {
			title = "Native ✗";
			lines.push(` ${th ? th.fg("error", truncateToWidth(st.message, inner - 2)) : truncateToWidth(st.message, inner - 2)}`);
			lines.push("");
			lines.push(` ${th ? th.fg("dim", "retry by appending 'native' again") : ""}`);
		}

		// Footer hints
		if (st.phase === "done") {
			const pos = this.scrollable
				? ` · ${Math.min(100, Math.round((this.offset / Math.max(1, this.totalLines() - CONTENT_HEIGHT)) * 100))}%`
				: "";
			const footer = `Ctrl+1/2/3 inject · Alt+N interact${this.scrollable ? " · Alt+J/K scroll" : ""}${pos}`;
			lines.push("");
			lines.push(` ${th ? th.fg("dim", truncateToWidth(footer, inner - 2)) : truncateToWidth(footer, inner - 2)}`);
		}

		return drawBox(th, lines, inner, title);
	}
}

// ---------------------------------------------------------------------------
// PanelEditor: wraps the real editor, adding the side panel when active
// ---------------------------------------------------------------------------

export class PanelEditor extends CustomEditor {
	constructor(
		tui: TuiLike & object,
		theme: ThemeLike & object,
		keybindings: object,
		private panel: NativeSidePanel,
		panelTheme?: ThemeLike | null,
	) {
		super(tui as never, theme as never, keybindings as never);
		// The editor factory's theme has no fg(); the full theme comes from
		// ctx.ui.theme on the extension context instead.
		this.panel.attach(tui, panelTheme ?? null);
	}

	render(width: number): string[] {
		if (!this.panel.active || width < 70) {
			// Panel hidden (or terminal too narrow): the untouched default editor.
			return super.render(width);
		}
		const panelW = Math.min(78, Math.max(36, Math.floor(width * 0.55)));
		const gap = 1;
		const editorW = width - panelW - gap;

		const edLines = super.render(editorW);
		const pLines = this.panel.render(panelW);
		const rows = Math.max(edLines.length, pLines.length);
		const edOffset = rows - edLines.length; // editor stays at the bottom

		const out: string[] = [];
		for (let i = 0; i < rows; i++) {
			const ed = i >= edOffset ? padTo(edLines[i - edOffset] ?? "", editorW) : " ".repeat(editorW);
			out.push(ed + " ".repeat(gap) + (pLines[i] ?? ""));
		}
		return out;
	}
}

// ---------------------------------------------------------------------------
// Overlay: interactive modal for selection/copy/inject (Alt+N)
// ---------------------------------------------------------------------------

export interface OverlayChoice {
	style: StyleKey;
	text: string;
}

const VIEWPORT_HEIGHT = 22;

export class NativeOverlay {
	private selected = 0;
	private offset = 0;
	private status = "";
	private sections: Array<{ key: StyleKey; lines: string[] }> = [];
	private wrapWidth = 0;

	constructor(
		private theme: ThemeLike | null,
		private source: string,
		private result: TranslationResult,
		private modelLabel: string,
		private done: (choice: OverlayChoice | undefined) => void,
	) {
		// Same defensive normalization as NativeSidePanel.attach.
		this.theme = theme && typeof (theme as { fg?: unknown }).fg === "function" ? theme : null;
		this.rebuild(58);
	}

	private rebuild(wrapAt: number): void {
		this.wrapWidth = wrapAt;
		const th = this.theme;
		this.sections = STYLE_KEYS.map((key) => {
			const header = th ? th.fg("accent", STYLE_LABELS[key]) : STYLE_LABELS[key];
			return {
				key,
				lines: [` ${header}`, ...wrapTextWithAnsi(this.result[key] ?? "", wrapAt).map((l) => ` ${l}`), ""],
			};
		});
		this.clampOffset();
	}

	private totalLines(): number {
		return this.sections.reduce((n, s) => n + s.lines.length, 0);
	}

	private sectionRange(index: number): { start: number; end: number } {
		let start = 0;
		for (let i = 0; i < index; i++) start += this.sections[i]!.lines.length;
		return { start, end: start + this.sections[index]!.lines.length };
	}

	private clampOffset(): void {
		const maxOffset = Math.max(0, this.totalLines() - VIEWPORT_HEIGHT);
		this.offset = Math.min(Math.max(0, this.offset), maxOffset);
	}

	private ensureVisible(): void {
		const { start, end } = this.sectionRange(this.selected);
		if (start < this.offset) this.offset = start;
		if (end > this.offset + VIEWPORT_HEIGHT) this.offset = end - VIEWPORT_HEIGHT;
		this.clampOffset();
	}

	private scroll(delta: number): void {
		this.status = "";
		this.offset = Math.min(Math.max(0, this.offset + delta), Math.max(0, this.totalLines() - VIEWPORT_HEIGHT));
	}

	private choose(index: number): void {
		const key = STYLE_KEYS[index]!;
		this.done({ style: key, text: this.result[key] ?? "" });
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			this.done(undefined);
		} else if (matchesKey(data, "return")) {
			this.choose(this.selected);
		} else if (data === "1") {
			this.choose(0);
		} else if (data === "2") {
			this.choose(1);
		} else if (data === "3") {
			this.choose(2);
		} else if (matchesKey(data, "tab")) {
			this.selected = (this.selected + (data.includes("\x1b[2") ? STYLE_KEYS.length - 1 : 1)) % STYLE_KEYS.length;
			this.status = "";
			this.ensureVisible();
		} else if (matchesKey(data, "down")) {
			this.scroll(1);
		} else if (matchesKey(data, "up")) {
			this.scroll(-1);
		} else if (matchesKey(data, "pageup") || matchesKey(data, "pageUp")) {
			this.scroll(-VIEWPORT_HEIGHT);
		} else if (matchesKey(data, "pagedown") || matchesKey(data, "pageDown")) {
			this.scroll(VIEWPORT_HEIGHT);
		} else if (matchesKey(data, "home")) {
			this.scroll(-Infinity);
		} else if (matchesKey(data, "end")) {
			this.scroll(Infinity);
		} else if (data === "c" || data === "C") {
			const key = STYLE_KEYS[this.selected]!;
			void copyToClipboard(this.result[key] ?? "").then((ok) => {
				this.status = ok ? `copied ${STYLE_LABELS[key]} to clipboard` : "no clipboard helper found (wl-copy/xclip)";
			});
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		const th = this.theme;
		const boxW = Math.max(30, Math.min(78, width));
		const inner = boxW - 2;
		const wrapAt = Math.max(20, inner - 2);
		if (wrapAt !== this.wrapWidth) this.rebuild(wrapAt);

		const lines: string[] = [];
		const src = this.source.replace(/\s+/g, " ").trim();
		lines.push(` ${th ? th.fg("dim", `◧ ${truncateToWidth(src, inner - 6)}`) : truncateToWidth(src, inner - 2)}`);
		lines.push("");

		let cursor = 0;
		for (let i = 0; i < this.sections.length; i++) {
			const section = this.sections[i]!;
			for (const line of section.lines) {
				if (cursor >= this.offset && cursor < this.offset + VIEWPORT_HEIGHT) {
					if (i === this.selected) {
						const marker = th ? th.fg("accent", "▍") : "▍";
						lines.push(`${marker}${line.slice(1)}`);
					} else {
						lines.push(` ${line.slice(1)}`);
					}
				}
				cursor++;
			}
		}

		const scrollable = this.totalLines() > VIEWPORT_HEIGHT;
		const position = scrollable ? ` · ${Math.min(100, Math.round((this.offset / Math.max(1, this.totalLines() - VIEWPORT_HEIGHT)) * 100))}%` : "";
		const footer = this.status || `Enter/1/2/3 inject${scrollable ? " · ↑↓ scroll" : ""} · Tab select · c copy · Esc close${position}`;
		lines.push("");
		lines.push(` ${th ? th.fg("dim", truncateToWidth(footer, inner - 2)) : truncateToWidth(footer, inner - 2)}`);

		const box = drawBox(th, lines, inner, `Native · ${this.modelLabel}`);
		const leftPad = Math.max(0, width - boxW);
		return box.map((l) => " ".repeat(leftPad) + l);
	}
}
