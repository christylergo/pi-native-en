/**
 * UI components for the native-prompt extension.
 *
 * - NativePanel: the always-visible, right-aligned panel above the editor.
 *   Shows the FULL three-style translation, scrolls internally, and never
 *   takes focus — so the user can transcribe from it into the editor while
 *   it is open. Scrolling is driven by global shortcuts (Alt+J/Alt+K).
 * - NativeOverlay: the interactive modal (Alt+N) for selection/copy/inject.
 *   Closing it returns focus to the editor automatically.
 */
import { spawn } from "node:child_process";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { STYLE_KEYS, STYLE_LABELS, type StyleKey, type TranslationResult } from "./translator.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface ThemeLike {
	fg: (token: string, text: string) => string;
}

function padTo(s: string, len: number): string {
	const v = visibleWidth(s);
	return s + " ".repeat(Math.max(0, len - v));
}

function padLeft(line: string, leftPad: number): string {
	return " ".repeat(leftPad) + line;
}

function boxWidthFor(width: number, max: number): number {
	return Math.max(30, Math.min(max, width));
}

function drawBox(theme: ThemeLike | null, innerLines: string[], inner: number, title: string): string[] {
	const c = theme ? theme.fg("border", "│") : "│";
	// A title longer than the box would push the top border out of alignment.
	const shown = truncateToWidth(title, Math.max(4, inner - 4));
	const dashes = Math.max(0, inner - shown.length - 3);
	const top = theme
		? theme.fg("border", `╭─ ${shown} `) + theme.fg("border", "─".repeat(dashes)) + theme.fg("border", "╮")
		: `╭─ ${shown} ${"─".repeat(dashes)}╮`;
	const bottom = theme ? theme.fg("border", `╰${"─".repeat(inner)}╯`) : `╰${"─".repeat(inner)}╯`;
	// Defensive: never let a long inner line push the box wider than its frame.
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
// Panel: full-content, right-aligned, passively visible above the editor
// ---------------------------------------------------------------------------

export class NativePanel {
	private sourceText = "";
	private result: TranslationResult | null = null;
	private modelLabel = "";
	private offset = 0;
	private sections: string[][] = [];
	private wrapWidth = 0;
	private tui: { requestRender(): void } | null = null;
	private theme: ThemeLike | null = null;

	get hasContent(): boolean {
		return this.result !== null;
	}

	bind(tui: { requestRender(): void }, theme: ThemeLike): void {
		this.tui = tui;
		this.theme = theme;
	}

	set(source: string, result: TranslationResult, modelLabel: string): void {
		this.sourceText = source;
		this.result = result;
		this.modelLabel = modelLabel;
		this.offset = 0;
		this.wrapWidth = 0; // force re-wrap
		this.refresh();
	}

	clear(): void {
		this.result = null;
		this.tui?.requestRender();
	}

	/** Scroll by delta lines (global shortcuts call this; editor keeps focus). */
	scrollBy(delta: number): void {
		if (!this.result) return;
		const max = Math.max(0, this.totalLines() - PANEL_VIEWPORT_HEIGHT);
		this.offset = Math.min(Math.max(0, this.offset + delta), max);
		this.tui?.requestRender();
	}

	private totalLines(): number {
		return this.sections.reduce((n, s) => n + s.length, 0);
	}

	private rebuild(wrapAt: number): void {
		this.wrapWidth = wrapAt;
		const th = this.theme;
		const r = this.result;
		if (!r) {
			this.sections = [];
			return;
		}
		this.sections = STYLE_KEYS.map((key) => {
			const header = th ? th.fg("accent", STYLE_LABELS[key]) : STYLE_LABELS[key];
			return [header, ...wrapTextWithAnsi(r[key] ?? "", wrapAt), ""];
		});
		const max = Math.max(0, this.totalLines() - PANEL_VIEWPORT_HEIGHT);
		this.offset = Math.min(this.offset, max);
	}

	private refresh(): void {
		this.wrapWidth = 0;
		this.tui?.requestRender();
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (!this.result) return [];
		const th = this.theme;
		const boxW = boxWidthFor(width, 78);
		const inner = boxW - 2;
		const wrapAt = Math.max(20, inner - 2);
		if (wrapAt !== this.wrapWidth) this.rebuild(wrapAt);

		const lines: string[] = [];
		const src = this.sourceText.replace(/\s+/g, " ").trim();
		lines.push(` ${th ? th.fg("dim", `◧ ${truncateToWidth(src, inner - 6)}`) : truncateToWidth(src, inner - 2)}`);
		lines.push("");

		let cursor = 0;
		for (const section of this.sections) {
			for (const line of section) {
				if (cursor >= this.offset && cursor < this.offset + PANEL_VIEWPORT_HEIGHT) {
					lines.push(` ${line}`);
				}
				cursor++;
			}
		}

		const total = this.totalLines();
		const scrollable = total > PANEL_VIEWPORT_HEIGHT;
		const pos = scrollable
			? ` · ${Math.min(100, Math.round((this.offset / Math.max(1, total - PANEL_VIEWPORT_HEIGHT)) * 100))}%`
			: "";
		const footer = `Ctrl+1/2/3 inject · Alt+N interact${scrollable ? " · Alt+J/K scroll" : ""}${pos}`;
		lines.push("");
		lines.push(` ${th ? th.fg("dim", truncateToWidth(footer, inner - 2)) : truncateToWidth(footer, inner - 2)}`);

		const box = drawBox(th, lines, inner, `Native · ${this.modelLabel}`);
		const leftPad = Math.max(0, width - boxW);
		return box.map((l) => padLeft(l, leftPad));
	}
}

// ---------------------------------------------------------------------------
// Overlay: interactive modal for selection/copy/inject (Alt+N)
// ---------------------------------------------------------------------------

export interface OverlayChoice {
	style: StyleKey;
	text: string;
}

const PANEL_VIEWPORT_HEIGHT = 16;
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
		// Sensible default; render() re-wraps to the real terminal width.
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
			// Tab / Shift+Tab cycle the selected style.
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
		const boxW = boxWidthFor(width, 78);
		const inner = boxW - 2;

		// Re-wrap whenever the available width changes (also builds on first render).
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
		const footer =
			this.status ||
			`Enter/1/2/3 inject${scrollable ? " · ↑↓ scroll" : ""} · Tab select · c copy · Esc close${position}`;
		lines.push("");
		lines.push(` ${th ? th.fg("dim", truncateToWidth(footer, inner - 2)) : truncateToWidth(footer, inner - 2)}`);

		const box = drawBox(th, lines, inner, `Native · ${this.modelLabel}`);
		const leftPad = Math.max(0, width - boxW);
		return box.map((l) => padLeft(l, leftPad));
	}
}
