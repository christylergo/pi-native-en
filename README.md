# native-prompt

A [pi](https://github.com/nicobailon/code-with-the-flow) extension that
translates prompts into native English without leaving your coding session.

Type any text ending with `native` — Chinese, broken English, or mixed — and a
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
| `Ctrl+1` / `Ctrl+2` / `Ctrl+3` | inject Natural / Technical / Concise into the editor |
| `Alt+I` | inject the currently selected style (`▍` marks it) |
| `Alt+H` / `Alt+L` | select previous / next style |
| `Alt+C` | copy the selected style to the clipboard |
| `Alt+J` / `Alt+K` | scroll the panel down / up |
| `Alt+W` | close the panel |
| `Alt+N` | interactive modal: `↑↓` scroll, `Tab` select, `1/2/3`/`Enter` inject, `c` copy, `Esc` back to the editor |

On trigger a centered, content-adaptive panel appears immediately above the
editor (never covering the input bar) and the translation streams into it
live. It never takes focus — every interaction is a global shortcut that
works while typing. Submitting any input dismisses it.

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
