# Phase 3 calibration — dev box, 2026-09-16

The measured inputs of the AI stats card (master plan section 10) on the dev box: the worker's
bandwidth and matmul figures against the spec row, and Ollama's decode speed against the
advisor's estimate, from which `CALIBRATION_FACTOR` and `STREAM_EFFICIENCY` in
`src/analysis/advisor.ts` are set. RTX 5090 32 GB (ASUS ROG Astral LC OC), driver 616.92,
Ryzen 9 9950X, 31 GiB usable RAM (DDR5-6200 dual channel), Ollama 0.34.1,
`OLLAMA_MODELS=C:\AI_dev\models`.

## GPU: `strata-tune-worker --bench --json`

Three runs, exit 0, one line of stdout each (`collector/README.md` has the field list); the
third is the review re-run after the 20 ms pass change in `BenchRun.cs`:

```
{"device":"NVIDIA GeForce RTX 5090","luid":"78720","bufferBytes":1073741824,"bandwidthGBs":1611.1,"bandwidthMedianGBs":1445.9,"matmulN":4096,"matmulTflopsFp32":52.1,"matmulTflopsFp16storage":54.34,"elapsedMs":4498}
{"device":"NVIDIA GeForce RTX 5090","luid":"78720","bufferBytes":1073741824,"bandwidthGBs":1594.9,"bandwidthMedianGBs":1463.3,"matmulN":4096,"matmulTflopsFp32":52.35,"matmulTflopsFp16storage":58.72,"elapsedMs":4489}
{"device":"NVIDIA GeForce RTX 5090","luid":"78720","bufferBytes":1073741824,"bandwidthGBs":1603,"bandwidthMedianGBs":1448.9,"matmulN":4096,"matmulTflopsFp32":52.68,"matmulTflopsFp16storage":58.19,"elapsedMs":4480}
```

| Figure | Spec (`gpus.json`, reference design) | This card | Measured | Gap |
|---|---|---|---|---|
| Memory bandwidth, best pass | 1792 GB/s (28 Gbps x 512-bit) | ~2027 GB/s: the memory runs at 1979 MHz against the 1750 MHz reference (+229 MHz, HWiNFO, `docs/dependencies.md`) | 1611 / 1595 / 1603 GB/s | −10 % vs spec, **−21 % vs this card's bus** |
| Memory bandwidth, median pass | — | — | 1446 / 1463 / 1449 GB/s | −19 % vs spec |
| Matmul 4096 fp32, shader cores | 104.8 TFLOPS (21760 x 2 x 2407 MHz) | — | 52.1 / 52.4 / 52.7 TFLOPS | the cs_6_0 kernel is bound by group-shared bandwidth, see `collector/README.md` |
| Matmul 4096 fp16 storage, float maths | 419 TFLOPS tensor FP16 | — | 54.3 / 58.7 / 58.2 TFLOPS | not comparable: no tensor cores from cs_6_0 |

The best pass of a 1 GiB copy is the figure the advisor uses (`bench.json` keeps the last
run per GPU and driver); the median shows the same card 10 % lower once clocks and the
memory controller settle.

### The copy reaches 80 % of the bus, and the bus here is not the spec bus

The "−10 % vs spec" the first version of this page reported was two effects cancelling: a
stream copy does not reach the theoretical figure, and this card's memory is overclocked
+13 % over the reference. Against the bus the card actually has (1979 MHz x 16 x 512 / 8 =
2027 GB/s) the kernel's best pass is **79.5 %**. A stock 5090 at 1750 MHz would therefore read
about 1425 GB/s from the same kernel, and its page would say −20 % vs spec: that is the
kernel's efficiency, not a throttled card. `STREAM_EFFICIENCY = 0.8` carries this: a card
nobody has measured is estimated at spec x 0.8, and the stats card prints the expected copy
rate beside the spec so a measurement reads against the right number ("+12 % vs expected copy"
on this box, which is the memory offset showing).

The "this card" column above is from HWiNFO by hand; the collector does not yet expose
`nvmlDeviceGetMaxClockInfo(MEM)`, so the page cannot compute it (plan section 10's three-column
card is a follow-up once the Phase 1 polish's clock fields land).

## Ollama: timed 256-token generations

The same request `electron/bench.ts` sends (fixed 60-token prompt, `num_predict` 256,
`keep_alive` 15m, stream off), sent directly to `/api/generate`; tok/s is
`eval_count / eval_duration`. Only two models are installed here: `qwen3:4b` and
`qwen3.8:27b` (Strata Photo's agent model). Neither `qwen2.5-coder:32b` nor `qwen3-vl:30b`
is, and pulling 20 GB was not this run's to decide.

Estimates use the measured 1611 GB/s. "At factor 1" is `bandwidth / (activeParamsB x
bytesPerWeight)`; the ratio is measured ÷ that, which is what `factorFrom()` and the page's
"Set factor from measurements" compute.

| Model | Quant | Weights read per token | Estimate at factor 1 | Estimate at 0.65 (old) | Measured, warm | Ratio |
|---|---|---|---|---|---|---|
| qwen3:4b (Qwen3 4B Thinking 2507) | q4_K_M, 4.02 B x 0.56 | 2.25 GB | 716 tok/s | 465 | 328.6, 350.5, 354.6, 356.5, 356.5 (cold first run 323.5, load 1.5 s) | **0.50** (best warm) |
| qwen3.8:27b (27.32 B dense, qwen35 hybrid, 65 blocks) | q4_K_M, 27.32 B x 0.56 | 15.3 GB | 105 tok/s | 68 | 114.8 (cold, load 11.3 s), 137.3, 154.2, 101.4, 127.3, 134.1, 108.6 | 0.96–1.46, **not a decode-efficiency ratio** (below) |

Prompt processing: qwen3:4b 10.7–11.9k tok/s warm, qwen3.8:27b 1.1–1.2k tok/s.

The pacing term stays the plan's per-weight table (4.02 B x 0.56 = 2.25 GB) although the
file Ollama pulls is 2.50 GB (q6_K/q8_0 embedding and output tensors); the factor absorbs the
difference, so the two must not be mixed: against the file the same measurement would be 0.55.
VRAM sizing, by contrast, now uses the file (`weightsBytes()`), because that is what loads.

### qwen3.8:27b is faster than the bus allows: multi-token prediction

15.3 GB of weights at 154 tok/s would be 2.4 TB/s on a 1.79 TB/s bus. The Ollama server log
explains it: the model carries an MTP head (`qwen35.nextn_predict_layers: 1`, confirmed again
by `/api/show` on 2026-09-16: `qwen35`, 65 blocks, `full_attention_interval` 4, `head_count_kv`
4, `key_length` 256) and Ollama 0.34 runs it as speculative decoding (`spec common_specu:
adding speculative implementation 'draft-mtp'`), with a draft acceptance of 0.35–0.60 and a
mean accepted length of 2.4–3.4 tokens per forward pass, varying run to run with the text.
Dividing each run's tok/s by its mean accepted length gives a steady **45 forward passes per
second** in every run (154.2 / 3.41, 134.1 / 3.04, 108.6 / 2.38), which is the bandwidth-bound
quantity, and 45 / 105 = 0.43 is a floor on the plain decode factor for this model (each pass
also runs four draft steps through the MTP layer and the 248k-row LM head, so the single-token
rate without MTP would be somewhat higher, roughly 0.5–0.6).

The advisor's formula has no term for speculative decoding, so the 27B ratio is excluded
from the factor. It does say two things worth keeping: on this box the plan's 0.65 is high
for a plain decode (both models land at 0.43–0.5), and a model row that carries an MTP head
is under-estimated by roughly its acceptance length unless `models.json` says so. It now
can: `mtpAcceptedTokens` on a `ModelSpec` multiplies `tokPerSec` and the offloaded figure,
and the `qwen3.8:27b` row carries 2.4, the lowest mean accepted length of the seven runs
above (conservative on purpose: 1611 GB/s gives 53 passes/s x 2.4 = 126 tok/s, inside the
measured 101–154). The multiplier assumes Ollama 0.34 or newer with the model fully in VRAM;
the "with MTP" chip says so. The row is left out of `factorFrom()` and the page's derived
factor rather than divided by 2.4, because the accepted length is a property of the text, not
the bus; the Calibration card shows its ratio greyed as "not in factor". Its KV cache is also
unusual: of the 65 blocks only every 4th is full attention, so `layers` is 16 (the 49 Gated
DeltaNet blocks keep a fixed state).

## The factor

Median of the plain-decode ratios: one model, **0.50** (356.5 / 715.7). It is inside the
0.4–0.9 band, so `CALIBRATION_FACTOR = 0.5` replaces the plan's 0.65 (the comment beside it
carries the date and this file). The 27B's per-pass floor of 0.43 is consistent with it.

**What this factor is not.** The plan asked for three models (a dense 30B-class, a MoE, the
4B); this box had two, one of them unusable for the purpose, so the shipped factor rests on
one dense 4B model, which is where per-token fixed costs (36 layers of kernel launches, the
151k-row LM head, sampling, the HTTP loop) weigh most: 2.8 ms per token. A dense 30B-class
model at ~20 ms per token pays those costs proportionally less, so its rows are likely
**15–25 % under** (44 tok/s shown for a 32B q4_K_M on this box); that range is the review's
reasoning about fixed costs, not a measurement, which is the point. No MoE model has been
timed at all: the 30B-A3B and gpt-oss rows are paced
on their active experts alone (436 tok/s at 1611 GB/s), and MoE decode in llama.cpp runs many
small expert kernels per token and lands well below that bound. The page marks every MoE
figure "MoE ceiling" until one is measured. To finish the plan's calibration the box needs
one dense 30B-class pull (`qwen2.5-coder:32b`, 20 GB) and one MoE pull (`qwen3:30b-a3b`,
19 GB); both need the user's approval and about 40 GB on the model drive. The Calibration
card's "Set factor from measurements" then sets this box's own factor without a code change,
and if the MoE ratio lands well under 0.5 a per-row efficiency field beside
`mtpAcceptedTokens` is the fix, not a global factor.

The page's derived factor is bounded: outside 0.3–1.0 the card says the run was not a clean
decode (a game or the worker on the card, the model partly in RAM). A spilling model is judged
against its offloaded estimate, and a timing carries the card and driver it was taken on, so a
swap retires it the way `bench.json` is retired.

What the factor does to the picks on this box at 8k context and the measured 1611 GB/s:
Qwen3 32B q4_K_M 57 → 44 tok/s estimated, Gemma 3 27B q4_K_M 68 → 52 tok/s, qwen3:4b 465 →
358 tok/s (measured 356). On the standalone page (spec x 0.8 = 1434 GB/s) the same rows read
39, 47 and 318.

## Sizing changes from the review (2026-09-16)

- **Weights are the pulled file.** `requiredBytes` used paramsB x the plan's per-weight table
  (18.4 GB for a 32B q4_K_M) where the GGUF Ollama loads is 20.0 GB (q6_K/q8_0 output and
  embedding tensors, 6–17 % across the table); the projector blob of a vision model is
  subtracted once and added back as the tower. Every row's requirement is now at least its
  download. The 32B q4_K_M rows moved 20.6 → 22.1 GiB on this box.
- **Sliding-window KV.** Gemma 3 runs 5 of every 6 blocks on a 1024-token window
  (`gemma3.attention.sliding_window` 1024 in the GGUF; llama.cpp `src/models/gemma3.cpp`, swa
  period 6) and llama.cpp's iSWA cache sizes those at the window; gpt-oss alternates full and
  128-token blocks. `models.json` carries `swa: { layers, window }` and `layers` counts the
  full-attention blocks only (27B: 10 + 52, 12B: 8 + 40, 4B: 5 + 29). Gemma 3 27B at 32k is
  20.2 GiB and fast, not 32 GiB and slow; Gemma 3 12B fits a 12 GiB card at 8k with 2 GiB to
  spare and is that card's vision pick.
- **Sorted by total parameters.** A 30B-A3B ranks as a 30B (the plan's "largest model that
  still runs fast"), so the family's own Qwen3-VL 30B-A3B is the vision pick here and the
  30B-A3B rows win a 24 GB card at 32k where the dense 32B rows spill. Their tok/s carries the
  MoE ceiling chip.
- **A pick must hold the context.** `bestFor` skips rows whose window is shorter than the
  slider: at 128k the 40k-window 32B rows step aside for Gemma 3 27B, at 256k nothing on this
  box runs fast.
- **Tight is 1.5 GiB**, the unit the page prints.

## Ranked "best model for" on this box (8k context, 1611 GB/s measured, factor 0.50)

| Use | Pick | Required | Estimated tok/s |
|---|---|---|---|
| chat | Qwen3 32B, `qwen3:32b` q4_K_M | 22.1 GiB of 31.8 GiB | 44 |
| coding | Qwen3 32B, `qwen3:32b` q4_K_M | 22.1 GiB | 44 |
| vision | Qwen3-VL 30B-A3B Thinking, `qwen3-vl:30b` q4_K_M | 20.9 GiB | 436, MoE ceiling |
| reasoning | Qwen3 32B, `qwen3:32b` q4_K_M | 22.1 GiB | 44 |

The list behind them (fast bucket first, largest model first): the three 32B q4_K_M rows
(Qwen3, Qwen2.5-Coder, DeepSeek-R1) at 22.1 GiB and 44 tok/s, Qwen2.5-Coder 32B q5_K_M
24.9 GiB / 35 and q6_K 28.6 GiB / 30 still fast, the two 30B-A3B q4_K_M rows 20.9 and 19.9 GiB
at the 436 ceiling, Gemma 3 27B 18.4 GiB / 52 (QAT 19.3), Qwen3.8 27B q4_K_M 18.5 GiB / 126
with MTP (q8_0 29.9 GiB / 71 still fast), Mistral Small 3.1 24B 16.7 GiB / 60, Devstral 24B
15.8 GiB / 61, gpt-oss:20b 14.7 GiB at the 334 ceiling, the 14B rows around 97, the 12B / 8B /
7B / 4B rows from 118 up to 358. Tight: Gemma 3 27B q8_0 (30.5 GiB), the 14B fp16 rows
(30.4–30.9 GiB). Slow, with the cliff: llama3.3:70b q4_K_M 44.0 GiB, 20 → 3.6 tok/s
offloaded; the 32B q8_0 rows 36.1 GiB, 25 → 8.2; the 30B-A3B q8_0 rows 32–34 GiB. Won't run:
every 70B above q4_K_M, every 32B / 27B fp16, gpt-oss:120b (62.8 GiB against 31.8 GiB VRAM +
0.8 x 31 GiB RAM), the 30B-A3B bf16 / fp16 rows.
