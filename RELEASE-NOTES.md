# Strata Tune 0.2.0 (2026-09-21)

Windows package: `powershell -ExecutionPolicy Bypass -File installer\package.ps1`
on the PC produces `release\Strata-Tune-Windows-x64.zip` and
`Strata-Tune-Setup-x64.exe`; attach both with
`gh release upload v0.2.0 release\Strata-Tune-Windows-x64.zip release\Strata-Tune-Setup-x64.exe`.

> **Runs on Apple Silicon.** A native macOS collector (Swift worker + the
> `macmon`/IOKit sensor path) drives Monitor, the AI Models page and the
> audit on a Mac, with Apple's own core names, a SoC diagram, and a rule set
> for macOS instead of Windows advice. The Headroom hunt and Capture
> (PresentMon) remain Windows-only. `scripts/mac/setup.sh`, then the app is
> in Launchpad and on the Desktop. See `docs/MACOS.md`.
>
> **LLM benchmark** on the AI Models page: a context-depth sweep on one
> quantised model through Ollama with ± spread, exportable so a PC and a Mac
> can be compared on the number that matters (tokens per second), with
> llama-benchy beside it.
>
> **AI stats, compared honestly.** A Mac's **Measure** reports the GPU's
> matrix path at dense int8 (Metal 4 tensor ops). A PC's "AI TOPS" headline
> is its vendor's peak at fp4 with 2:1 sparsity (an RTX 5090: 3,352), so the
> PC card now prints its dense INT8 row (838) as *comparable* right under
> the headline, and the Mac's figure is labelled plain TOPS with the row to
> compare it with.
>
> **Also:** the Monitor's SoC diagram figures no longer overlap its label;
> Node 24 LTS is the pinned runtime for the launchers.
>
> **Windows:** unchanged requirements (PawnIO for CPU sensors, Performance
> Log Users for Capture). The setup exe upgrades 0.1.x in place.
