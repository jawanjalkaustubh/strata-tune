# PresentMon (vendored)

The console build of Intel's PresentMon, spawned by the collector as a child process to get
one CSV row per present. The exe is gitignored; `scripts/setup-tools.ps1` downloads and
verifies it. Pins and verified facts live in `docs/dependencies.md`; this file is the
operator's card for the binary that sits next to it.

| | |
|---|---|
| Version | 2.5.1 (2.5.0 was withdrawn upstream; do not pin it) |
| File | `PresentMon-2.5.1-x64.exe` (x64 only; not the 157 MB MSI, which is the service + GUI) |
| URL | https://github.com/GameTechDev/PresentMon/releases/download/v2.5.1/PresentMon-2.5.1-x64.exe |
| Size | 956,768 bytes |
| SHA-256 | `9BEC3083069F58F911E6A512F4806DB51A27BD096103087BC1D05EF54C80A191` |
| Licence | MIT, Copyright 2017-2024 Intel Corporation. Notice goes in THIRD-PARTY-NOTICES.md. |

## Invocation the collector uses

```
PresentMon-2.5.1-x64.exe --process_id <pid> --output_stdout --qpc_time --stop_existing_session --terminate_on_proc_exit --session_name StrataTune
```

- `--process_id`, not `--process_name`: non-elevated, PresentMon lists other accounts' and
  elevated processes as `<unknown>`, which `--process_name` cannot match.
- `--terminate_on_proc_exit` only fires once the target has been seen presenting. The
  collector also waits on the process handle itself and kills PresentMon as a fallback.
- `--timed N` on its own only stops *recording*; add `--terminate_after_timed` when a
  bounded run must exit (tests, probes).

## Session-name rule

Always pass `--session_name StrataTune`. The default ETW session name is `PresentMon`, and
`--stop_existing_session` stops whatever session has that name, which would kill a running
CapFrameX or RTSS capture. Names are case-insensitive and must be unique per concurrent
capture; probes use `StrataTuneProbe`. This is not hypothetical on the dev box: NVIDIA's
FrameView SDK service (`nvfvsdksvc_x64.exe`) runs its own `PresentMon_x64.exe` with an ETW
session of its own, so a default session name here has something to collide with.

## Pipe-encoding rule

Stdout to a pipe is narrow (ANSI) text with CRLF line endings; a console or `--output_file`
gets UTF-16. Read the child's stdout as ASCII/Latin-1, never UTF-8, and split on `\r\n`.
Verified 2026-09-15: 377,149 bytes, first bytes `41 70 70 6C` (no BOM), zero bytes above
0x7F, every line CRLF.

Stderr is diagnostics, not data. Non-elevated it carries a multi-line warning about
`<unknown>` processes on every run; the version banner also lands there. Do not treat
stderr output as failure, use the exit code.

## CSV

28 columns, parsed by header name, never by index (the upstream README's column table is
stale). Header verified byte-for-byte on 2026-09-15; the header plus ten rows are in
`docs/phase0-presentmon-sample.csv`.

That sample was captured from `claude.exe`, an Electron window in Hardware Composed:
Independent Flip — not from a game, which master-plan section 22 step 3 asks for. It proves
the column list, the encoding and the QPC clock, and nothing about the `--process_id` path
against a real game or about the anti-cheat behaviour noted above.

- `TimeInQPC` and `CPUStartQPC` are raw QPC ticks on the same clock as
  `Stopwatch.GetTimestamp()` (10,000,000 Hz on this box).
- Optional columns print `NA` and must be nullable: `MsBetweenSimulationStart`,
  `MsFlipDelay`, `MsAllInputToPhotonLatency`, `MsClickToPhotonLatency` were `NA` on every
  row of the probe; `MsAnimationError` is `NA` on the first row of a swap chain.
- `MsBetweenPresents` is the classic frame time; `MsBetweenAppStart = MsCPUBusy + MsCPUWait`
  is the v2 frame time (holds in the sample: 3.8472 + 0.0467 = 3.8939).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | bad arguments |
| 6 | failed to start the trace session: not admin and not in Performance Log Users, or an anti-cheat blocked `StartTraceW`. Start PresentMon before the game. |
| 7 | terminating the existing session failed |

Non-admin works for members of Performance Log Users (well-known SID `S-1-5-32-559`);
`scripts/setup-tools.ps1` reports membership and prints the `net localgroup` command
to add the user. Membership is read from the logon token, so a new member signs out first.
