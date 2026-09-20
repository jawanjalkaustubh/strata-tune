; =============================================================================
;  STRATA TUNE - SETUP (Inno Setup 6)
;  Built by installer\package.ps1 from the staged folder the portable zip is made of:
;    ISCC.exe /DAppVersion=0.1.0 /DStageDir=<release\Strata-Tune-Windows-x64> /DRepoRoot=<repo> /DOutputDir=<release> installer\strata-tune.iss
;  One installer, one click to run (user direction 2026-09-19: "everything is installed and the app
;  is launched with a single click", a desktop shortcut the user can choose):
;    - the app under Program Files (the collector must live where a standard user cannot write;
;      collector\README.md "Where the collector may be installed"), a Start Menu entry, a desktop
;      shortcut behind a checkbox, "Launch Strata Tune" ticked on the last page;
;    - the PawnIO driver, which the sensor library needs for the CPU and the board: fetched at install
;      time from its official GitHub release with a pinned SHA-256 and run in its own silent mode
;      (it is GPL-2.0 and not ours to redistribute, plan section 21, so nothing of it is in this
;      package); skipped when already installed, and a failed download is one message, never a
;      failed install (the app runs without it and says so on the Monitor page);
;    - the account into Performance Log Users, so Capture can open PresentMon's trace session
;      without elevation (a checkbox; takes effect at the next sign-in);
;    - uninstall removes the app and asks about the sessions, logs and settings; PawnIO stays,
;      because other tools share it.
;  The setup is not code-signed: SmartScreen shows "Windows protected your PC" (More info, Run anyway).
; =============================================================================

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef StageDir
  #error StageDir is required: the staged release folder (installer\package.ps1 passes it)
#endif
#ifndef RepoRoot
  #error RepoRoot is required
#endif
#ifndef OutputDir
  #define OutputDir RepoRoot + "\release"
#endif

; PawnIO 2.2.0 from https://github.com/namazso/PawnIO.Setup/releases (the official release the
; pawnio.eu button links to). The hash was taken from the file on 2026-09-19 and is checked before
; the file is run; a new PawnIO release means a new hash here, never an unpinned download.
#define PawnIoUrl "https://github.com/namazso/PawnIO.Setup/releases/download/2.2.0/PawnIO_setup.exe"
#define PawnIoSha256 "1f519a22e47187f70a1379a48ca604981c4fcf694f4e65b734aaa74a9fba3032"
#define PawnIoVersion "2.2.0"

[Setup]
AppId={{B7E2C6E1-6F4A-4C1D-9A5B-5E3F2D7A8C10}
AppName=Strata Tune
AppVersion={#AppVersion}
AppVerName=Strata Tune {#AppVersion}
AppPublisher=Kaustubh Jawanjal
AppPublisherURL=https://github.com/jawanjalkaustubh/strata-tune
AppSupportURL=https://github.com/jawanjalkaustubh/strata-tune/issues
AppUpdatesURL=https://github.com/jawanjalkaustubh/strata-tune/releases
DefaultDirName={autopf}\Strata Tune
DefaultGroupName=Strata Tune
DisableProgramGroupPage=yes
; An administrator install by design: the collector's folder must not be writable by a standard user.
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19041
OutputDir={#OutputDir}
OutputBaseFilename=Strata-Tune-Setup-x64
SetupIconFile={#RepoRoot}\assets\strata-tune-st.ico
UninstallDisplayIcon={app}\Strata Tune.exe
UninstallDisplayName=Strata Tune
Compression=lzma2
SolidCompression=yes
LZMAUseSeparateProcess=yes
WizardStyle=modern
; A running Strata Tune holds its files: Setup asks to close it rather than failing half-way (the
; collector exits on its own once the app is gone, plan section 5).
CloseApplications=yes
RestartApplications=no
ShowLanguageDialog=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "pawnio"; Description: "Install the &PawnIO driver {#PawnIoVersion} (CPU and board sensors need it; downloaded from its official release, about 3 MB)"; GroupDescription: "Sensors:"; Check: not PawnIoInstalled
Name: "perflog"; Description: "Let Capture record &frame times without an administrator prompt (adds your account to the Performance Log Users group; takes effect after you sign out and back in)"; GroupDescription: "Capture:"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Strata Tune"; Filename: "{app}\Strata Tune.exe"; WorkingDir: "{app}"; Comment: "PC tuning and diagnostics"
Name: "{group}\Uninstall Strata Tune"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Strata Tune"; Filename: "{app}\Strata Tune.exe"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
; net.exe exits 2 when the account is already a member; that is fine and never fails the install.
Filename: "{sys}\net.exe"; Parameters: "localgroup ""Performance Log Users"" ""{username}"" /add"; Flags: runhidden; StatusMsg: "Adding your account to Performance Log Users..."; Tasks: perflog
Filename: "{app}\Strata Tune.exe"; Description: "&Launch Strata Tune"; Flags: nowait postinstall skipifsilent

[Code]
var
  DownloadPage: TDownloadWizardPage;
  PawnIoFetched: Boolean;

{ The driver's own uninstall entry is what pawnio.eu's setup writes; the service key is what the
  collector's health check opens. Either means "installed". }
function PawnIoInstalled: Boolean;
begin
  Result := RegKeyExists(HKLM, 'SYSTEM\CurrentControlSet\Services\PawnIO')
    or RegKeyExists(HKLM, 'SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PawnIO');
end;

function OnDownloadProgress(const Url, FileName: String; const Progress, ProgressMax: Int64): Boolean;
begin
  Result := True;
end;

procedure InitializeWizard;
begin
  DownloadPage := CreateDownloadPage(SetupMessage(msgWizardPreparing), SetupMessage(msgPreparingDesc), @OnDownloadProgress);
  DownloadPage.ShowBaseNameInsteadOfUrl := True;
  PawnIoFetched := False;
end;

{ The download happens between Ready and Install, so a machine without internet learns it before
  anything is copied: one message, and the install goes on without the driver. }
function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = wpReady) and WizardIsTaskSelected('pawnio') and not PawnIoInstalled then
  begin
    DownloadPage.Clear;
    DownloadPage.Add('{#PawnIoUrl}', 'PawnIO_setup.exe', '{#PawnIoSha256}');
    DownloadPage.Show;
    try
      try
        DownloadPage.Download;
        PawnIoFetched := True;
      except
        SuppressibleMsgBox(
          'PawnIO could not be downloaded (' + GetExceptionMessage + ').' + #13#10#13#10 +
          'Strata Tune will be installed without it: the app runs, but the CPU and board sensors stay off until you install PawnIO from https://pawnio.eu and restart the app.',
          mbInformation, MB_OK, IDOK);
      end;
    finally
      DownloadPage.Hide;
    end;
  end;
end;

{ PawnIO's setup: -install -silent (its own usage text). 3010 is "installed, restart needed". }
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if (CurStep = ssPostInstall) and PawnIoFetched then
  begin
    if Exec(ExpandConstant('{tmp}\PawnIO_setup.exe'), '-install -silent', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    begin
      Log('PawnIO setup exit code ' + IntToStr(ResultCode));
      if (ResultCode <> 0) and (ResultCode <> 3010) then
        SuppressibleMsgBox(
          'The PawnIO driver setup returned code ' + IntToStr(ResultCode) + '. Strata Tune is installed; install PawnIO from https://pawnio.eu and restart the app to get the CPU and board sensors.',
          mbInformation, MB_OK, IDOK);
    end
    else
      SuppressibleMsgBox(
        'The PawnIO driver setup could not be started (' + SysErrorMessage(ResultCode) + '). Strata Tune is installed; install PawnIO from https://pawnio.eu and restart the app to get the CPU and board sensors.',
        mbInformation, MB_OK, IDOK);
  end;
end;

// The app's own data lives outside the install folder; it is the user's, so the uninstaller asks.
// PawnIO is left alone: HWiNFO, LibreHardwareMonitor and others share it.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{localappdata}\Strata Tune');
    if DirExists(DataDir) then
      if SuppressibleMsgBox(
           'Also delete your Strata Tune sessions, logs and settings?' + #13#10 + DataDir + #13#10#13#10 +
           'Choose No to keep them for a later install. (The PawnIO driver is left installed either way; other tools use it.)',
           mbConfirmation, MB_YESNO, IDNO) = IDYES then
        DelTree(DataDir, True, True, True);
  end;
end;
