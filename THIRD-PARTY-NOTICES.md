# Third-party notices

Strata Tune ships or depends on the components below. Versions are pinned in
`docs/dependencies.md`; this file is the notice that travels with the built app.

The list is the collector's and worker's actual Release output, not just the packages named
in the csproj files: LibreHardwareMonitorLib pulls six libraries of its own into
`bin\x64\Release\net10.0\win-x64\`, and they ship whether or not this machine ever calls
them. To re-derive it after a package bump, list the DLLs in that folder and read the
licence of each from `collector\StrataTune.Collector\obj\project.assets.json` and the
nuspecs in `%USERPROFILE%\.nuget\packages`.

| Component | Licence | Shipped how |
|---|---|---|
| LibreHardwareMonitorLib 0.9.6 | MPL-2.0 | NuGet, unmodified, in the collector |
| BlackSharp.Core 1.0.7 | MPL-2.0 | transitive (LHM), unmodified, in the collector |
| DiskInfoToolkit 1.1.2 | MPL-2.0 | transitive (LHM), unmodified, in the collector |
| RAMSPDToolkit-NDD 1.4.2 | MPL-2.0 | transitive (LHM), unmodified, in the collector |
| HidSharp 2.6.4 | Apache-2.0 (Copyright 2010-2025 James F. Bellinger) | transitive (LHM), in the collector |
| Mono.Posix.NETStandard 1.0.0 | MIT (Mono project) | transitive (LHM), with its `MonoPosixHelper` natives |
| System.Diagnostics.PerformanceCounter 10.0.12 | MIT | NuGet, in the collector |
| System.Management 10.0.2 | MIT | NuGet (direct; also pulled by LHM), in the collector |
| System.CodeDom 10.0.2, System.IO.Ports 10.0.3, System.Configuration.ConfigurationManager 10.0.12, System.Diagnostics.EventLog 10.0.12, System.Security.Cryptography.ProtectedData 10.0.12 | MIT | transitive, in the collector |
| ComputeSharp 3.2.0 and ComputeSharp.Core 3.2.0 | MIT | NuGet, in the worker |
| PawnIO 2.2.0 | separate installer (namazso) | not redistributed; setup reports it and links to pawnio.eu |
| PresentMon 2.5.1 | MIT (Copyright 2017-2024 Intel Corporation) | exe downloaded by the setup script, not committed |
| .NET runtime (self-contained) | MIT + Microsoft .NET Library License for coreclr | embedded in the published exe |
| nvml.h prototypes | NVIDIA notice (royalty-free; disclaimer reproduced) | transcribed into `collector/StrataTune.Collector/Nvml.cs` |

## Runtime

| Component | Licence | Shipped how |
|---|---|---|
| Electron 34.5.8 | MIT (Copyright (c) Electron contributors, Copyright (c) 2013-2020 GitHub Inc.), with Chromium, Node.js and V8 under their own licences | the app's executable; Electron's `LICENSE` and `LICENSES.chromium.html` (every Chromium and Node component notice) ship beside it |

## JavaScript packages (production dependencies)

From `package.json`; the dev-only toolchain (Vite, TypeScript, Tailwind, vitest, electron-packager) is not shipped and is not listed.

| Package | Version | Licence |
|---|---|---|
| react | 18.3.1 | MIT (Copyright (c) Meta Platforms, Inc. and affiliates) |
| react-dom | 18.3.1 | MIT (Copyright (c) Meta Platforms, Inc. and affiliates) |
| lucide-react | 1.46.0 | ISC (Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather; all other copyright for Lucide are held by Lucide Contributors 2022) |
| clsx | 2.1.1 | MIT (Copyright (c) Luke Edwards) |
| tailwind-merge | 3.7.0 | MIT (Copyright (c) 2021 Dany Castillo) |

## The MIT licence text

Every component above marked MIT carries this permission notice; the copyright line for each
is given in its own section below.

> Permission is hereby granted, free of charge, to any person obtaining a copy of this
> software and associated documentation files (the "Software"), to deal in the Software
> without restriction, including without limitation the rights to use, copy, modify, merge,
> publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
> to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
> INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
> PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
> FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
> OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
> DEALINGS IN THE SOFTWARE.

## LibreHardwareMonitorLib 0.9.6 — Mozilla Public License 2.0

Copyright (C) LibreHardwareMonitor and Contributors. Partial Copyright (C) Michael Möller
and Contributors (OpenHardwareMonitor).

Source: https://github.com/LibreHardwareMonitor/LibreHardwareMonitor
Licence text: https://www.mozilla.org/MPL/2.0/

The library is used unmodified, as published on NuGet. MPL-2.0 is a file-level copyleft: the
covered files remain under MPL-2.0 and their source is available at the address above; the
rest of Strata Tune is not a derivative of them. If any of the library's files are ever
modified for this app, those modified files must be published under MPL-2.0.

## BlackSharp.Core 1.0.7, DiskInfoToolkit 1.1.2, RAMSPDToolkit-NDD 1.4.2 — Mozilla Public License 2.0

Copyright (c) Florian K. (Blacktempel).

- https://github.com/Blacktempel/BlackSharp
- https://github.com/Blacktempel/DiskInfoToolkit
- https://github.com/Blacktempel/RAMSPDToolkit

Licence text: https://www.mozilla.org/MPL/2.0/

LibreHardwareMonitor uses these for SMART data and DIMM SPD reads, and they land in the
collector's output folder with it. All three are used unmodified, as published on NuGet; the
same file-level copyleft note as above applies to each.

## HidSharp 2.6.4 — Apache License 2.0

Copyright 2010-2025 James F. Bellinger <http://software.seekye.com/hidsharp>

Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file
except in compliance with the License. You may obtain a copy of the License at

> http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under the
License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND,
either express or implied. See the License for the specific language governing permissions
and limitations under the License.

The full text is in `LICENSE.txt` inside the `hidsharp` package. The library is used
unmodified; LibreHardwareMonitor uses it to talk to USB HID devices such as AIO pumps.

## Mono.Posix.NETStandard 1.0.0 — MIT

Copyright (c) .NET Foundation and Contributors, and the Mono project contributors.

The package is published by Microsoft and its licence link is the Mono project's
(https://go.microsoft.com/fwlink/?linkid=869050); the source is
https://github.com/mono/mono. It ships with LibreHardwareMonitor for its Linux paths, along
with the native `MonoPosixHelper.dll` and `libMonoPosixHelper.dll`, and is unused on
Windows. MIT text above.

## ComputeSharp 3.2.0 and ComputeSharp.Core 3.2.0 — MIT

Copyright (c) Sergio Pedri and contributors.

Source and licence text: https://github.com/Sergio0694/ComputeSharp/blob/main/LICENSE
MIT text above.

## PresentMon 2.5.1 — MIT

Copyright (C) 2017-2024 Intel Corporation.

Source and licence text: https://github.com/GameTechDev/PresentMon/blob/main/LICENSE.txt

The x64 executable is downloaded and hash-checked by `scripts/setup-tools.ps1`; it is not
committed to this repository. MIT text above.

## Electron — MIT

Copyright (c) Electron contributors. Copyright (c) 2013-2020 GitHub Inc.

Source and licence text: https://github.com/electron/electron/blob/main/LICENSE. Electron
embeds Chromium (BSD-3-Clause) and Node.js (MIT), each with many third-party components;
their notices are the `LICENSES.chromium.html` file Electron ships, which the packaged app
carries beside its executable. MIT text above.

## lucide-react — ISC

ISC License. Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of
Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2022.

> Permission to use, copy, modify, and/or distribute this software for any purpose with or
> without fee is hereby granted, provided that the above copyright notice and this
> permission notice appear in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO
> THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT
> SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR
> ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION
> OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE
> USE OR PERFORMANCE OF THIS SOFTWARE.

Source: https://github.com/lucide-icons/lucide/blob/main/LICENSE

## react, react-dom, clsx, tailwind-merge — MIT

react and react-dom: Copyright (c) Meta Platforms, Inc. and affiliates
(https://github.com/facebook/react/blob/main/LICENSE). clsx: Copyright (c) Luke Edwards
(https://github.com/lukeed/clsx/blob/master/license). tailwind-merge: Copyright (c) 2021
Dany Castillo (https://github.com/dcastil/tailwind-merge/blob/main/LICENSE.md). MIT text above.

## The Microsoft packages — MIT

Copyright (c) .NET Foundation and Contributors.

`System.Diagnostics.PerformanceCounter`, `System.Management`, `System.CodeDom`,
`System.IO.Ports`, `System.Configuration.ConfigurationManager`,
`System.Diagnostics.EventLog` and `System.Security.Cryptography.ProtectedData`.
Licence text: https://github.com/dotnet/runtime/blob/main/LICENSE.TXT, and above.

## PawnIO 2.2.0 — not redistributed

PawnIO (by namazso) is the signed kernel driver LibreHardwareMonitor uses to read CPU and
super-IO registers. Strata Tune does not bundle it; `scripts/setup-tools.ps1` reports
whether it is installed and points the user to https://pawnio.eu to install it under its own
terms.

## .NET runtime — MIT and the Microsoft .NET Library License

The collector and worker are published self-contained, so the .NET 10 runtime is embedded in
the executables. The managed runtime libraries are MIT (Copyright (c) .NET Foundation and
Contributors, https://github.com/dotnet/runtime/blob/main/LICENSE.TXT). The native
CoreCLR components in the Windows x64 runtime pack are distributed under the Microsoft .NET
Library License (https://dotnet.microsoft.com/dotnet_library_license.htm), which permits
redistribution as part of an application; nuget.org's "MIT" label on those runtime packs is
incorrect metadata (dotnet/runtime issue #108905), so this notice names the licence that
actually applies.

## NVIDIA nvml.h — notice

The NVML function prototypes and structures in `collector/StrataTune.Collector/Nvml.cs`
are transcribed from NVIDIA's `nvml.h`. Its notice grants users a nonexclusive, royalty-free
licence to use the code in individual and commercial software and requires that the
following Disclaimer and U.S. Government End Users Notice be reproduced in the user
documentation and in the code:

> Copyright 1993-2024 NVIDIA Corporation. All rights reserved.
>
> NVIDIA MAKES NO REPRESENTATION ABOUT THE SUITABILITY OF THIS SOURCE CODE FOR ANY PURPOSE.
> IT IS PROVIDED "AS IS" WITHOUT EXPRESS OR IMPLIED WARRANTY OF ANY KIND. NVIDIA DISCLAIMS
> ALL WARRANTIES WITH REGARD TO THIS SOURCE CODE, INCLUDING ALL IMPLIED WARRANTIES OF
> MERCHANTABILITY, NONINFRINGEMENT, AND FITNESS FOR A PARTICULAR PURPOSE. IN NO EVENT SHALL
> NVIDIA BE LIABLE FOR ANY SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL DAMAGES, OR ANY
> DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF
> CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE
> USE OR PERFORMANCE OF THIS SOURCE CODE.
>
> U.S. Government End Users. This source code is a "commercial item" as that term is defined
> at 48 C.F.R. 2.101 (OCT 1995), consisting of "commercial computer software" and
> "commercial computer software documentation" as such terms are used in 48 C.F.R. 12.212
> (SEPT 1995) and is provided to the U.S. Government only as a commercial end item.
> Consistent with 48 C.F.R. 12.212 and 48 C.F.R. 227.7202-1 through 227.7202-4 (JUNE 1995),
> all U.S. Government End Users acquire the source code with only those rights set forth
> herein.

`nvml.dll` itself is not redistributed; the collector loads the copy the NVIDIA driver
installs in `C:\Windows\System32`.
