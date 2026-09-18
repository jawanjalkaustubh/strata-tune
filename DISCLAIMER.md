# Strata Tune — disclaimer

Version 2 · 2026-09-17 · applies to every build of Strata Tune

Strata Tune is free software by Kaustubh Jawanjal ("the author"). By installing or using it
you accept the terms below. If you do not accept them, do not use the app.

## 1. Free software, as is

Strata Tune is provided **as is**, without warranty of any kind, express or implied: no
warranty that it works, that it is free of errors, that its readings are accurate, or that it
is fit for any particular purpose. The source code is licensed under the MIT licence (see
`LICENSE`); this disclaimer covers the app you download and run.

## 2. No liability

**The author is not responsible for any damage or loss that results from using Strata Tune** —
including hardware damage, data loss, corrupted files, downtime, lost warranty coverage, lost
profits, or any other direct, indirect, incidental or consequential loss — under any legal
theory, even if warned of the possibility. Where the law where you live does not allow this
exclusion in full, the author's liability is limited to the greatest extent that law allows.
Strata Tune is free; nothing was paid and nothing can be refunded.

## 3. Hardware risk is real, and it is yours

- The monitoring, audit, capture and advisor features **change nothing** on your machine.
  They read sensors and run measured workloads.
- **Headroom** (the Tune page's hunt) is off by default and sits behind a warning. It tests
  small clock offsets on your graphics card for minutes at a time and puts the card back as it
  found it (unless you turn on *Keep my tune applied at startup*, which re-applies the offsets
  you entered yourself each time the app's collector starts); it never changes a voltage, a power limit or a fan curve, and it writes
  nothing to the CPU. The values it finds are yours to apply in your card vendor's tool. A
  test can still crash the driver or the machine and lose unsaved work in other programs, and
  any overclock you then apply yourself can crash the machine, shorten the life of or
  permanently damage components, and **may void your hardware warranty**.
- The stress workloads push the GPU and CPU to their limits by design. A machine with a
  marginal cooler, power supply or overclock may hang or reboot during a run.

Use Tune only on a machine where you can afford a crash, back up your work first, and stop if
anything looks wrong. **You do this at your own risk.**

## 4. Readings and advice are informational

Sensor values come from drivers, firmware and third-party libraries and can be wrong, missing
or mislabelled. The audit's findings, the advisor's model and token-rate estimates, the power
supply sizing, the stutter verdicts and every score are estimates derived from published
references and the app's own tests. They are **not professional, engineering, financial or
purchasing advice**. Verify before acting on anything that costs money or touches hardware.

## 5. Not affiliated with any vendor

NVIDIA, GeForce, AMD, Ryzen, Radeon, Intel, ASUS, ROG, MSI, Gigabyte, Microsoft, Windows,
DirectX, HWiNFO, Ollama and every other product name that appears in the app are trademarks
of their respective owners. Strata Tune is an independent project and is not endorsed by,
sponsored by or connected with any of them. AI model names belong to their publishers, and
each model comes under its own licence.

## 6. Your data stays yours

Strata Tune sends **no telemetry**, needs **no account**, and makes **no network connection
except the ones you start**: a local Ollama on `127.0.0.1`, links you click, and an update
check only if you turn one on. Sessions, logs and settings live under
`%LOCALAPPDATA%\Strata Tune` on your own disk. Reports and share cards you export contain
hardware names, clocks and temperatures — never serial numbers — and where they go is your
decision.

## 7. Third-party components

The libraries and tools that ship with the app, and their licences, are listed in
`THIRD-PARTY-NOTICES.md`. PawnIO is a separately installed driver under its own terms.
HWiNFO, if you run it, is yours under HWiNFO's terms; Strata Tune only reads the sensor data
HWiNFO publishes for other programs. Ollama and the models it serves are your own installs.

## 8. Donations

Donations are voluntary gifts. They buy nothing, unlock nothing, and are not tax-deductible
unless your own tax rules say so.

## 9. Language

The English text of this disclaimer is the one that counts. Translations, where they exist,
are provided for convenience.
