/**
 * UI component for the native-prompt extension: the centered translation
 * panel shown above the editor.
 *
 * The panel is a passive widget: it never takes focus and never covers the
 * input bar. All interaction is driven by global shortcuts registered in
 * index.ts (scroll, style selection, inject, copy), so no modal is needed.
 * Width adapts to the content: the box is as wide as the longest translation
 * line (capped), which keeps folding to a minimum.
 */
import { spawn } from "node:child_process";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { STYLE_KEYS, STYLE_LABELS, type StyleKey, type TranslationResult } from "./translator.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ThemeLike {
	fg: (token: string, text: string) => string;
}

interface TuiLike {
	requestRender(): void;
}

function normalizeTheme(theme: unknown): ThemeLike | null {
	return theme && typeof (theme as { fg?: unknown }).fg === "function" ? (theme as ThemeLike) : null;
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

function center(lines: string[], width: number, boxW: number): string[] {
	const leftPad = Math.max(0, Math.floor((width - boxW) / 2));
	return lines.map((l) => " ".repeat(leftPad) + l);
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
// Panel
// ---------------------------------------------------------------------------

const MIN_INNER = 38;
const MAX_INNER = 110;
const CONTENT_HEIGHT = 18;

type PanelState =
	| { phase: "loading"; source: string; modelLabel: string }
	| { phase: "streaming"; source: string; modelLabel: string; partial: string; thinking: string }
	| { phase: "done"; source: string; result: TranslationResult; modelLabel: string }
	| { phase: "error"; message: string };

export class NativePanel {
	private state: PanelState | null = null;
	private offset = 0;
	private selected = 0;
	private tui: TuiLike | null = null;
	private theme: ThemeLike | null = null;
	private sections: string[][] = [];
	private wrapWidth = 0;

	get active(): boolean {
		return this.state !== null;
	}

	get selectedStyle(): StyleKey | null {
		return this.state?.phase === "done" ? STYLE_KEYS[this.selected]! : null;
	}

	get selectedText(): string | null {
		const st = this.state;
		return st?.phase === "done" ? st.result[STYLE_KEYS[this.selected]!] ?? null : null;
	}

	bind(tui: TuiLike, theme: unknown): void {
		this.tui = tui;
		this.theme = normalizeTheme(theme);
	}

	private requestRender(): void {
		this.tui?.requestRender();
	}

	// -- state transitions --------------------------------------------------

	showLoading(source: string, modelLabel: string): void {
		this.state = { phase: "loading", source, modelLabel };
		this.offset = 0;
		this.selected = 0;
		this.requestRender();
	}

	showStreaming(source: string, modelLabel: string, partial: string, thinking = ""): void {
		if (this.state?.phase === "done" || this.state?.phase === "error") return;
		this.state = { phase: "streaming", source, modelLabel, partial, thinking };
		this.requestRender();
	}

	showDone(source: string, result: TranslationResult, modelLabel: string): void {
		this.state = { phase: "done", source, result, modelLabel };
		this.offset = 0;
		this.selected = 0;
		this.wrapWidth = 0; // force a rebuild — stale sections from the previous translation must go
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

	// -- interactions (driven by global shortcuts; editor keeps focus) ------

	scrollBy(delta: number): void {
		if (this.state?.phase !== "done") return;
		const max = Math.max(0, this.totalLines() - CONTENT_HEIGHT);
		this.offset = Math.min(Math.max(0, this.offset + delta), max);
		this.requestRender();
	}

	/** Cycle the selected style by delta (usually ±1). */
	selectBy(delta: number): void {
		if (this.state?.phase !== "done") return;
		this.selected = (this.selected + delta + STYLE_KEYS.length) % STYLE_KEYS.length;
		this.ensureSelectedVisible();
		this.requestRender();
	}

	/** Select a style directly (0-based index). */
	selectIndex(index: number): void {
		if (this.state?.phase !== "done" || index < 0 || index >= STYLE_KEYS.length) return;
		this.selected = index;
		this.ensureSelectedVisible();
		this.requestRender();
	}

	// -- rendering ----------------------------------------------------------

	private totalLines(): number {
		return this.sections.reduce((n, s) => n + s.length, 0);
	}

	private sectionRange(index: number): { start: number; end: number } {
		let start = 0;
		for (let i = 0; i < index; i++) start += this.sections[i]!.length;
		return { start, end: start + this.sections[index]!.length };
	}

	private ensureSelectedVisible(): void {
		const { start, end } = this.sectionRange(this.selected);
		if (start < this.offset) this.offset = start;
		if (end > this.offset + CONTENT_HEIGHT) this.offset = end - CONTENT_HEIGHT;
		const max = Math.max(0, this.totalLines() - CONTENT_HEIGHT);
		this.offset = Math.min(Math.max(0, this.offset), max);
	}

	/** Panel width: half the terminal by default, widening for long content. */
	private computeInner(width: number): number {
		// The box adds two border columns, so the inner width must fit width - 2.
		const usable = Math.max(20, width - 2);
		const half = Math.max(MIN_INNER, Math.floor(width / 2));
		const st = this.state;
		if (st?.phase !== "done") {
			// Loading/streaming/error: half the screen.
			return Math.min(110, half, usable);
		}
		let longest = 0;
		for (const key of STYLE_KEYS) {
			for (const line of (st.result[key] ?? "").split("\n")) {
				longest = Math.max(longest, visibleWidth(line.trim()));
			}
		}
		const source = Math.min(60, visibleWidth(st.source.replace(/\s+/g, " ").trim()));
		longest = Math.max(longest, source + 4);
		// Half a screen minimum (the user's preferred default), wider only when
		// the content needs it, capped at 110 columns.
		return Math.max(Math.min(half, usable), Math.min(MAX_INNER, longest + 4, usable));
	}

	private rebuildDone(wrapAt: number): void {
		this.wrapWidth = wrapAt;
		const th = this.theme;
		const st = this.state as Extract<PanelState, { phase: "done" }>;
		this.sections = STYLE_KEYS.map((key) => {
			const header = th ? th.fg("accent", STYLE_LABELS[key]) : STYLE_LABELS[key];
			return [header, ...wrapTextWithAnsi(st.result[key] ?? "", wrapAt), ""];
		});
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (!this.state) return [];
		const th = this.theme;
		const inner = this.computeInner(width);
		const boxW = inner + 2;
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
			// Show the reasoning chain while the model thinks, then the answer as
			// it is written — the panel always moves, so it never looks stuck.
			title = `Native · translating… ${st.partial.length}c`;
			if (st.partial.length === 0 && st.thinking.length > 0) {
				lines.push(` ${th ? th.fg("dim", "🧠 thinking…") : "thinking…"}`);
				lines.push("");
				const wrapped = wrapTextWithAnsi(st.thinking, inner - 2);
				for (const l of wrapped.slice(-CONTENT_HEIGHT)) lines.push(` ${th ? th.fg("muted", l) : l}`);
			} else {
				if (st.thinking.length > 0) {
					lines.push(` ${th ? th.fg("dim", `🧠 ${st.thinking.length}c of reasoning done`) : `${st.thinking.length}c of reasoning done`}`);
					lines.push("");
				}
				const wrapped = wrapTextWithAnsi(st.partial || "…", inner - 2);
				for (const l of wrapped.slice(-CONTENT_HEIGHT)) lines.push(` ${l}`);
			}
			lines.push("");
			lines.push(` ${th ? th.fg("dim", "streaming — a new trigger cancels") : ""}`);
		} else if (st.phase === "done") {
			title = `Native · ${st.modelLabel}`;
			const wrapAt = inner - 2;
			if (wrapAt !== this.wrapWidth || this.sections.length === 0) this.rebuildDone(wrapAt);
			lines.push(` ${th ? th.fg("dim", `◧ ${truncateToWidth(st.source.replace(/\s+/g, " ").trim(), inner - 6)}`) : truncateToWidth(st.source, inner - 2)}`);
			lines.push("");
			let cursor = 0;
			for (let i = 0; i < this.sections.length; i++) {
				const section = this.sections[i]!;
				const isSel = i === this.selected;
				for (const line of section) {
					if (cursor >= this.offset && cursor < this.offset + CONTENT_HEIGHT) {
						if (isSel) {
							const marker = th ? th.fg("accent", "▍") : "▍";
							lines.push(`${marker}${line}`);
						} else {
							lines.push(` ${th ? th.fg("muted", line) : line}`);
						}
					}
					cursor++;
				}
			}
		} else {
			title = "Native ✗";
			lines.push(` ${th ? th.fg("error", truncateToWidth(st.message, inner - 2)) : truncateToWidth(st.message, inner - 2)}`);
			lines.push("");
			lines.push(` ${th ? th.fg("dim", "retry by appending 'native' again") : ""}`);
		}

		if (st.phase === "done") {
			const total = this.totalLines();
			const scrollable = total > CONTENT_HEIGHT;
			const pos = scrollable ? ` · ${Math.min(100, Math.round((this.offset / Math.max(1, total - CONTENT_HEIGHT)) * 100))}%` : "";
			const sel = STYLE_LABELS[STYLE_KEYS[this.selected]!];
			const footer = `▸${sel}  Alt+1/2/3 or Alt+I inject · Alt+H/L select · Alt+C copy${scrollable ? " · Alt+J/K scroll" : ""} · Alt+W close${pos}`;
			lines.push("");
			lines.push(` ${th ? th.fg("dim", truncateToWidth(footer, inner - 2)) : truncateToWidth(footer, inner - 2)}`);
		}

		return center(drawBox(th, lines, inner, title), width, boxW);
	}
}
