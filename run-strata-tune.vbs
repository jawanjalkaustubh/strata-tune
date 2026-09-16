Set FSO = CreateObject("Scripting.FileSystemObject")
ScriptDir = FSO.GetParentFolderName(WScript.ScriptFullName)
Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = ScriptDir
' Full path in the cmd /s /c ""..."" form: cmd does not search the current
' directory when NoDefaultCurrentDirectoryInExePath is set, and the folder may
' contain spaces or parentheses. Hidden window (0), no wait: the .bat shows its
' own message box if the install or build fails.
WshShell.Run "cmd /s /c """"" & FSO.BuildPath(ScriptDir, "run-strata-tune.bat") & """""", 0, False
