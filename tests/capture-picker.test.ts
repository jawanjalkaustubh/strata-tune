import { describe, expect, it } from 'vitest';
import { curate, detect, type ProcessInfo } from '../electron/picker';
import benchmarks from '../src/data/benchmarks.json';

const allowlist = new Set(['cyberpunk2077', 'eldenring']);
const proc = (pid: number, exe: string, path: string | null, title = exe): ProcessInfo => ({ pid, exe, path, title });

describe('the capture picker curation (plan section 11, user request 2026-09-16)', () => {
  it('names the benchmark by its exe, wildcards included', () => {
    expect(detect(proc(1, 'geekbench6.exe', 'C:\\Program Files\\Geekbench 6\\geekbench6.exe'), allowlist)).toBe('Geekbench');
    expect(detect(proc(2, 'geekbench_x86_64.exe', null), allowlist)).toBe('Geekbench');
    // The Windows GUI is installed as "Geekbench 6.exe" beside the CLI; Unigine's bin folders carry versioned names.
    expect(detect(proc(21, 'Geekbench 6.exe', 'C:\\Program Files\\Geekbench 6\\Geekbench 6.exe'), allowlist)).toBe('Geekbench');
    expect(detect(proc(22, 'superposition_1.1.exe', null), allowlist)).toBe('Unigine Superposition');
    expect(detect(proc(3, '3DMarkSteelNomadLight.exe', 'D:\\3DMark\\3DMarkSteelNomadLight.exe'), allowlist)).toBe('3DMark');
    expect(detect(proc(4, 'Cinebench.exe', null), allowlist)).toBe('Cinebench');
    expect(detect(proc(5, 'FurMark.exe', null), allowlist)).toBe('FurMark');
    expect(detect(proc(6, 'OCCT.exe', null), allowlist)).toBe('OCCT');
  });

  it('names the library a game runs from, or the allowlist, and asks nothing of a process without a path', () => {
    expect(detect(proc(1, 'witcher3.exe', 'D:\\SteamLibrary\\steamapps\\common\\The Witcher 3\\bin\\x64\\witcher3.exe'), allowlist)).toBe('Steam');
    expect(detect(proc(2, 'FortniteClient-Win64-Shipping.exe', 'C:\\Program Files\\Epic Games\\Fortnite\\FortniteGame\\Binaries\\Win64\\FortniteClient-Win64-Shipping.exe'), allowlist)).toBe('Epic Games');
    expect(detect(proc(3, 'Overwatch.exe', 'C:\\Program Files (x86)\\Battle.net\\Overwatch\\Overwatch.exe'), allowlist)).toBe('Battle.net');
    expect(detect(proc(4, 'Diablo IV.exe', 'D:\\Blizzard\\Diablo IV\\Diablo IV.exe'), allowlist)).toBe('Battle.net');
    expect(detect(proc(5, 'GTA5.exe', 'C:\\Program Files\\Rockstar Games\\Grand Theft Auto V\\GTA5.exe'), allowlist)).toBe('Rockstar Games');
    expect(detect(proc(6, 'Cyberpunk2077.exe', 'E:\\Games\\Cyberpunk 2077\\bin\\x64\\Cyberpunk2077.exe'), allowlist)).toBe('Game Mode allowlist');
    expect(detect(proc(7, 'Starfield.exe', 'C:\\Program Files\\WindowsApps\\BethesdaSoftworks.Starfield_1.0.0.0_x64__3275kfvn8vcwc\\Starfield.exe'), allowlist)).toBe('Microsoft Store');
    expect(detect(proc(8, 'Calculator.exe', 'C:\\Program Files\\WindowsApps\\Microsoft.WindowsCalculator_11_x64__8wekyb3d8bbwe\\Calculator.exe'), allowlist)).toBeNull();
    expect(detect(proc(9, 'notepad.exe', null), allowlist)).toBeNull();
    expect(detect(proc(10, 'ACValhalla.exe', 'D:\\Ubisoft Game Launcher\\games\\Assassin\'s Creed Valhalla\\ACValhalla.exe'), allowlist)).toBe('Ubisoft Connect');
    expect(detect(proc(11, 'bf6.exe', 'C:\\Program Files\\EA Games\\Battlefield 6\\bf6.exe'), allowlist)).toBe('EA app');
    // A game that runs elevated has no readable path: the allowlist still names it.
    expect(detect(proc(12, 'eldenring.exe', null), allowlist)).toBe('Game Mode allowlist');
  });

  it('a launcher in its own library folder is never a detected game, nor is an engine editor', () => {
    const launchers = [
      proc(30, 'EpicGamesLauncher.exe', 'C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe', 'Epic Games Launcher'),
      proc(31, 'Battle.net.exe', 'C:\\Program Files (x86)\\Battle.net\\Battle.net.exe', 'Battle.net'),
      proc(32, 'RiotClientServices.exe', 'C:\\Riot Games\\Riot Client\\RiotClientServices.exe', 'Riot Client'),
      proc(33, 'Launcher.exe', 'C:\\Program Files\\Rockstar Games\\Launcher\\Launcher.exe', 'Rockstar Games Launcher'),
      proc(34, 'UbisoftConnect.exe', 'C:\\Program Files (x86)\\Ubisoft\\Ubisoft Game Launcher\\UbisoftConnect.exe', 'Ubisoft Connect'),
      proc(35, 'EADesktop.exe', 'C:\\Program Files\\Electronic Arts\\EA Desktop\\EA Desktop\\EADesktop.exe', 'EA'),
      proc(36, 'GalaxyClient.exe', 'C:\\Program Files (x86)\\GOG Galaxy\\GalaxyClient.exe', 'GOG GALAXY'),
      proc(37, 'UnrealEditor.exe', 'C:\\Program Files\\Epic Games\\UE_5.4\\Engine\\Binaries\\Win64\\UnrealEditor.exe', 'Unreal Editor')
    ];
    expect(curate(launchers, allowlist).map((p) => [p.exe, p.group])).toEqual([['UnrealEditor.exe', 'other']]);
    // The games those launchers start are still theirs.
    expect(detect(proc(40, 'VALORANT-Win64-Shipping.exe', 'C:\\Riot Games\\VALORANT\\live\\ShooterGame\\Binaries\\Win64\\VALORANT-Win64-Shipping.exe'), allowlist)).toBe('Riot Games');
    expect(detect(proc(41, 'RDR2.exe', 'C:\\Program Files\\Rockstar Games\\Red Dead Redemption 2\\RDR2.exe'), allowlist)).toBe('Rockstar Games');
  });

  it('puts detected first, drops the shell, overlays and the Strata family, keeps browsers behind Show all', () => {
    const picks = curate(
      [
        proc(10, 'explorer.exe', 'C:\\Windows\\explorer.exe', 'Downloads'),
        proc(11, 'chrome.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'Docs - Google Chrome'),
        proc(12, 'NVIDIA Overlay.exe', null, 'NVIDIA GeForce Overlay'),
        proc(13, 'steam.exe', 'C:\\Program Files (x86)\\Steam\\steam.exe', 'Steam'),
        proc(14, 'Discord.exe', null, 'Discord'),
        proc(15, 'electron.exe', 'D:\\AntiGravity\\strata-tune\\node_modules\\electron\\dist\\electron.exe', 'Strata Tune'),
        proc(16, 'Strata Photo.exe', null, 'Strata Photo'),
        proc(17, 'eldenring.exe', 'D:\\Steam\\steamapps\\common\\ELDEN RING\\Game\\eldenring.exe', 'ELDEN RING'),
        proc(18, 'notepad.exe', 'C:\\Windows\\notepad.exe', 'Untitled - Notepad'),
        proc(19, 'geekbench6.exe', null, 'Geekbench 6'),
        proc(20, 'TextInputHost.exe', null, ''),
        proc(21, 'strata-tune-bench.exe', null, 'Strata Tune bench'),
        proc(22, 'Stratagem.exe', 'D:\\Games\\Stratagem\\Stratagem.exe', 'Stratagem')
      ],
      allowlist
    );
    // Only the family's own stems are dropped: Stratagem is a game.
    expect(picks.map((p) => [p.exe, p.group, p.source])).toEqual([
      ['eldenring.exe', 'detected', 'Steam'],
      ['geekbench6.exe', 'detected', 'Geekbench'],
      ['chrome.exe', 'other', null],
      ['notepad.exe', 'other', null],
      ['Stratagem.exe', 'other', null]
    ]);
  });

  it('carries the built-in bench beside the tables so both sides name the same exe', () => {
    expect(benchmarks.builtIn.exe).toBe('strata-tune-bench.exe');
    expect(benchmarks.builtIn.seconds).toBe(90);
    expect(benchmarks.builtIn.segments.map((s) => s.name)).toEqual(['warm-up', 'shader-compile', 'texture-stream', 'cpu-stall', 'gpu-load']);
  });
});
