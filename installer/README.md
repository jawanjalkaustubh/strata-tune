# Strata Tune

PC tuning and diagnostics for Windows: what is wrong with this PC, what it costs, and how
to fix it. Free, no accounts, no telemetry, no cloud calls. Everything runs on your machine.

## Run it

This is the portable zip: nothing is installed into Windows and nothing runs at startup. The
same release also has `Strata-Tune-Setup-x64.exe`, which does steps 1 and 2 for you (Program
Files, a Start Menu entry, a desktop shortcut if you tick it, the PawnIO driver fetched from its
official release, your account into *Performance Log Users* for Capture, and a launch at the end).

1. Unzip this folder anywhere you like (for example `C:\Program Files\Strata Tune` or your
   Desktop).
2. Install the **PawnIO** driver if you don't have it: <https://pawnio.eu>. It is a small,
   signed kernel driver that LibreHardwareMonitor uses to read CPU, board and memory sensors.
   Without it the sensor service cannot read your CPU and the Monitor's CPU panel says so.
3. Double-click **Strata Tune.exe**. On first launch the app shows its disclaimer and waits for
   *I understand*. Then Windows asks once, with a UAC prompt, to start
   `strata-tune-collector.exe` elevated. That is the sensor service; it listens only on
   `127.0.0.1` with a per-launch secret, answers only this app, and exits when the app closes.
   Decline the prompt and the app still opens, with a *Retry* where the sensors would be.

## Requirements

- Windows 10 or 11, 64-bit.
- Any CPU. Sensors and audit rules exist for AMD Ryzen and Intel Core.
- A GPU is optional. An NVIDIA GeForce card with a current driver gets everything: the GPU
  audit checks, the full card panel, this card's own figures on the AI Models page and the
  Headroom hunt. An AMD or Intel card shows what its driver reports (clocks, load, VRAM, power,
  temperatures, fan), sizes the AI models against its VRAM and runs the bench; the GPU audit
  checks and the Headroom hunt say in one sentence that they need an NVIDIA card.
- **Capture** (frame times with PresentMon) needs your account in the *Performance Log Users*
  group. When it is not, the Capture page says so and offers to add it: one UAC prompt, then
  sign out and back in.
- **AI Models**: install Ollama (<https://ollama.com>) to measure real tokens/s on your models.
  Without it the page still estimates from your hardware.

## What is where

- `Strata Tune.exe` and the Electron runtime.
- `resources\collector\`: the sensor service, the load worker and the stutter bench.
- `resources\presentmon\`: PresentMon 2.5.1 from Intel, unchanged.
- Your sessions, logs and settings: `%LOCALAPPDATA%\Strata Tune`. Delete that folder and the
  app is back to first launch.

## Overclocking

Tune's Headroom hunt is off by default, behind a settings switch and a warning. When you turn
it on it adds small clock steps on top of your current tune and tests each one for about a
minute with a workload whose result it can check. It stops at the first small mistake, long
before the card would hang, leaves the card exactly as it found it, and hands you the values
to type into your vendor's tool. Nothing changes voltage, power limits or fans. A crash can
still lose unsaved work in other apps: save first. Read `DISCLAIMER.md`.

## Windows SmartScreen and Smart App Control

This release is not code-signed. SmartScreen may show "Windows protected your PC" on first
run: click *More info*, then *Run anyway*. On a PC with Smart App Control turned on,
Windows may refuse to start the sensor service; Smart App Control can only be turned off, not
configured, so on such a PC the Monitor and Audit pages will not have sensor data.

## Legal

Free software, as is, no warranty, no liability; hardware risk is yours. The full text is in
`DISCLAIMER.md` and in the app under About → Legal. Code licence: `LICENSE` (MIT). Third-party
components and their licences: `THIRD-PARTY-NOTICES.md`. NVIDIA, GeForce, AMD, Ryzen, Intel,
Windows and all other names are trademarks of their owners; Strata Tune is an independent
project, not connected with any of them.

## Support

Bugs and questions: the GitHub repository's Issues page. Donations are voluntary and buy
nothing; the link is in About.
