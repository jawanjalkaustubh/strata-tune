PC tuning and diagnostics: what is wrong with this machine, what it costs, and how to fix it. Free, no accounts, no telemetry, no cloud calls.

**Install (Windows):** unzip anywhere and run `Strata Tune.exe`. Install the **PawnIO** driver from <https://pawnio.eu> if you don't have it — without it the sensor service cannot read CPU, board and memory sensors. First launch shows the disclaimer, then Windows asks once (UAC) to start the elevated sensor service, which listens only on `127.0.0.1` with a per-launch secret and exits with the app. Not code-signed: *More info → Run anyway*.

## What's new in 0.2.0

**Runs on Apple Silicon.** A native macOS collector — a Swift worker plus the IOKit sensor path — drives **Monitor**, **AI Models** and the **audit** on a Mac, with Apple's own core names, a SoC diagram, and an audit rule set written for macOS instead of Windows advice. The Headroom hunt and Capture (PresentMon) stay Windows-only and say so. See `docs/MACOS.md`.

**LLM benchmark** on the AI Models page: a context-depth sweep on one quantised model through Ollama, with the ± spread across runs and llama-benchy beside it. Export the result on one machine, import it on the other, and the two rows sit together — tokens per second on the same model is the comparison that actually transfers between a PC and a Mac.

**AI stats, compared honestly.** A Mac's **Measure** reports what its GPU achieved on a real matmul: dense INT8 through Metal 4 tensor ops. A PC's "AI TOPS" headline is its vendor's *peak* at FP4 with 2:1 sparsity — an RTX 5090's 3,352 — which is four times the same card's dense INT8 figure. The two sat under one label and invited a 27× reading of a 7× gap. The PC card now prints its dense INT8 row (838 for that card) as **comparable** directly under the headline, and the Mac's figure is labelled plain TOPS with the row to compare it with. Both tooltips say the PC row is still a spec-sheet peak where the Mac's is measured.

**Also:** the Monitor's SoC diagram figures no longer overlap its label.

**Windows is unchanged:** same requirements (PawnIO for CPU sensors, *Performance Log Users* membership for Capture), same pages, same collector.

**Known limits:** GPU audit checks and the Headroom hunt need an NVIDIA card; AMD and Intel cards show what their drivers report. Capture needs PresentMon (Windows). Unsigned build.

SHA-256 of the zip is in the `.sha256` file beside it. Use is governed by [`LICENSE`](LICENSE) and [`DISCLAIMER.md`](DISCLAIMER.md).
