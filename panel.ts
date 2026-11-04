/**
 * UI components for the native-prompt extension:
 *  - NativeWidget: the on-demand right-aligned panel above the editor
 *    (passive display; keyboard shortcuts live in index.ts).
 *  - NativeOverlay: the interactive full-text view (ctx.ui.custom overlay).
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
	// Right-align a box line inside the full terminal width.
	return " ".repeat(leftPad) + line;
}

export interface PanelState {
	phase: "loading" | "done" | "error";
	source?: string;
	result?: TranslationResult;
	modelLabel?: string;
	message?: string;
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
	// Defensive: never let a long inner line (hints, previews) push the box
	// wider than its frame on narrow terminals.
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
// Widget (passive, right-aligned, above the editor)
// ---------------------------------------------------------------------------

export class NativeWidget {
	state: PanelState | null = null;
	private tui: { requestRender(): void } | null = null;
	private theme: ThemeLike | null = null;

	bind(tui: { requestRender(): void }, theme: ThemeLike): void {
		this.tui = tui;
		this.theme = theme;
	}

	update(state: PanelState | null): void {
		this.state = state;
		this.tui?.requestRender();
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (!this.state) return [];
		const st = this.state;
		const boxW = boxWidthFor(width, 64);
		const inner = boxW - 2;
		const th = this.theme;
		const lines: string[] = [];

		if (st.phase === "loading") {
			const head = th ? th.fg("accent", "Translating") + th.fg("dim", ` · ${st.modelLabel ?? ""}`) : `Translating · ${st.modelLabel ?? ""}`;
			lines.push(` ${head}`);
			lines.push("");
			for (const srcLine of (st.source ?? "").split("\n").slice(0, 2)) {
				lines.push(` ${th ? th.fg("dim", truncateToWidth(srcLine.trim(), inner - 4)) : truncateToWidth(srcLine.trim(), inner - 4)}`);
			}
			lines.push("");
			const hint = th ? th.fg("dim", "Alt+W dismiss · a new trigger cancels") : "Alt+W dismiss · a new trigger cancels";
			lines.push(` ${hint}`);
		} else if (st.phase === "done" && st.result) {
			const src = (st.source ?? "").replace(/\s+/g, " ").trim();
			const srcLine = th ? th.fg("dim", `◧ ${truncateToWidth(src, inner - 6)}`) : truncateToWidth(src, inner - 2);
			lines.push(` ${srcLine}`);
			lines.push("");
			for (let i = 0; i < STYLE_KEYS.length; i++) {
				const key = STYLE_KEYS[i]!;
				const text = (st.result[key] ?? "").replace(/\s+/g, " ").trim();
				const num = th ? th.fg("accent", `${i + 1} ${STYLE_LABELS[key]}`) : `${i + 1} ${STYLE_LABELS[key]}`;
				const preview = truncateToWidth(text, Math.max(8, inner - 16));
				lines.push(` ${padTo(num, 13)}${th ? th.fg("text", preview) : preview}`);
			}
			lines.push("");
			const hint = "Ctrl+1/2/3 inject · Alt+N full · Alt+W close";
			lines.push(` ${th ? th.fg("dim", hint) : hint}`);
		} else {
			const msg = st.message ?? "translation failed";
			lines.push(` ${th ? th.fg("error", truncateToWidth(msg, inner - 2)) : truncateToWidth(msg, inner - 2)}`);
			lines.push("");
			lines.push(` ${th ? th.fg("dim", "Alt+W close · retry by appending 'native' again") : "Alt+W close"}`);
		}

		const title = st.phase === "error" ? "Native ✗" : "Native";
		const box = drawBox(th, lines, inner, title);
		const leftPad = Math.max(0, width - boxW);
		return box.map((l) => padLeft(l, leftPad));
	}
}

// ---------------------------------------------------------------------------
// Overlay (interactive full-text view)
// ---------------------------------------------------------------------------

export interface OverlayChoice {
	style: StyleKey;
	text: string;
}

const OVERLAY_MAX_HEIGHT = 20;

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
		this.ensureVisible();
	}

	private totalLines(): number {
		return this.sections.reduce((n, s) => n + s.lines.length, 0);
	}

	private sectionRange(index: number): { start: number; end: number } {
		let start = 0;
		for (let i = 0; i < index; i++) start += this.sections[i]!.lines.length;
		return { start, end: start + this.sections[index]!.lines.length };
	}

	private ensureVisible(): void {
		const { start, end } = this.sectionRange(this.selected);
		if (start < this.offset) this.offset = start;
		if (end > this.offset + OVERLAY_MAX_HEIGHT) this.offset = end - OVERLAY_MAX_HEIGHT;
		const maxOffset = Math.max(0, this.totalLines() - OVERLAY_MAX_HEIGHT);
		this.offset = Math.min(Math.max(0, this.offset), maxOffset);
	}

	private choose(index: number): void {
		const key = STYLE_KEYS[index]!;
		this.done({ style: key, text: this.result[key] ?? "" });
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.done(undefined);
		} else if (matchesKey(data, "return")) {
			this.choose(this.selected);
		} else if (matchesKey(data, "up")) {
			this.selected = (this.selected + STYLE_KEYS.length - 1) % STYLE_KEYS.length;
			this.status = "";
			this.ensureVisible();
		} else if (matchesKey(data, "down")) {
			this.selected = (this.selected + 1) % STYLE_KEYS.length;
			this.status = "";
			this.ensureVisible();
		} else if (data === "1") {
			this.choose(0);
		} else if (data === "2") {
			this.choose(1);
		} else if (data === "3") {
			this.choose(2);
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
				if (cursor >= this.offset && cursor < this.offset + OVERLAY_MAX_HEIGHT) {
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

		const more = this.totalLines() > OVERLAY_MAX_HEIGHT ? " · ↑↓ scroll" : "";
		const footer = this.status || `Enter/1/2/3 inject · c copy${more} · Esc close`;
		lines.push("");
		lines.push(` ${th ? th.fg("dim", truncateToWidth(footer, inner - 2)) : truncateToWidth(footer, inner - 2)}`);

		const box = drawBox(th, lines, inner, `Native full · ${this.modelLabel}`);
		const leftPad = Math.max(0, width - boxW);
		return box.map((l) => padLeft(l, leftPad));
	}
}
