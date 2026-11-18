# native-prompt

A [pi](https://github.com/nicobailon/code-with-the-flow) extension that
translates prompts into native English without leaving your coding session.

Type any text ending with `native` or `美式` — Chinese, broken English, or mixed — and a
right-aligned panel appears with three rewrites: **Natural**, **Technical**,
and **Concise**. Inject one with a keystroke, or transcribe it yourself while
the panel stays open; submitting dismisses it and the working session's context stays untouched
(translation runs through an independent LLM call with its own history).

```text
帮我把这句话翻译成地道的英文 native
i am want to check why audio not switch native
```

## Quick reference

| Key | Action |
| --- | --- |
| `Alt+1` / `Alt+2` / `Alt+3` | inject Natural / Technical / Concise into the editor |
| `Alt+I` | inject the currently selected style (`▍` marks it) |
| `Alt+N` / `Alt+P` | select next / previous style (neovim next/prev) |
| `Alt+C` | copy the selected style to the clipboard |
| `Alt+J` / `Alt+K` | scroll the panel down / up (vim line motion) |
| `Alt+W` | close the panel |
| `Alt+N` | interactive modal: `↑↓` scroll, `Tab` select, `1/2/3`/`Enter` inject, `c` copy, `Esc` back to the editor |

On trigger a centered panel (half the terminal wide by default, wider only
when the content needs it) appears immediately above the editor — never
covering the input bar — and the translation streams into it live, including
the model's reasoning chain, so it never looks stuck.

Focus model: the panel never takes focus; the editor is always focused. Every
panel action is a global shortcut that works while typing, which is what makes
transcribing from the panel frictionless. There is no focus switching because
none is needed. Submitting any input dismisses the panel.

Inject keys are Alt+digit, not Ctrl+digit: legacy terminal encodings cannot
represent Ctrl+1/2/3 (they arrive as plain digits and never fire).

Commands: `/native <text>` (manual trigger) · `/native model` (pick model) ·
`/native clear` (wipe translation memory).

## Install

```bash
./install.sh    # copies into ~/.pi/agent/extensions/native-prompt
# then /reload in pi, and /native model to pick a translator model
```

## Uninstall (clean, no residue)

```bash
./uninstall.sh  # removes the extension dir and ~/.local/state/pi-native-translator
```

## Documentation

- [中文使用手册](docs/USAGE-zh.md) — full manual: triggers, keys, model
  configuration (registry or private endpoint), privacy notes, compatibility
  quirks, troubleshooting.

## Files

| File | Purpose |
| --- | --- |
| `index.ts` | entry: input interception, panel lifecycle, shortcuts, commands |
| `translator.ts` | independent translation session + persistent memory |
| `panel.ts` | widget panel + interactive overlay, clipboard helpers |
| `config.example.json` | copy to `config.json` and adjust (git-ignored) |

## Privacy

Source texts and translations never enter pi sessions; the translation memory
lives only in `~/.local/state/pi-native-translator/history.json` and is removed
by `/native clear` or uninstall. The extension writes nowhere else.
