' BJTU Net AutoLogin - watchdog launcher (Windows).
'
' Starts watchdog.py with no console window. Put a SHORTCUT to this file in the
' Windows Startup folder (Win+R -> shell:startup) so the watchdog runs on boot.
'
' Do NOT copy this file out of the project folder. It looks for watchdog.py
' relative to its own location: this file lives in <project>\windows\ and
' watchdog.py lives in the project root, one level above. A copied-out launcher
' cannot find the script and exits silently, with no error message.
'
' Python is located automatically via "where pythonw.exe"; if that fails, a
' pythonw.exe sitting in windows\ or in the project root is used instead.
' Nothing is hard-coded.
'
' Debug log: %TEMP%\bjtu-net-autologin.log

Option Explicit

Dim fso, sh, pyw, here, root, scriptPath
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(here)
scriptPath = root & "\watchdog.py"

pyw = FindPythonw()
If pyw = "" Then WScript.Quit
If Not fso.FileExists(pyw) Then WScript.Quit
If Not fso.FileExists(scriptPath) Then WScript.Quit

' 0 = hidden window, False = do not wait for it to finish
sh.Run Chr(34) & pyw & Chr(34) & " " & Chr(34) & scriptPath & Chr(34), 0, False

Function FindPythonw()
    Dim ex, out, arr, line
    FindPythonw = ""
    On Error Resume Next
    ' 1) ask the system where pythonw.exe is
    Set ex = sh.Exec("where pythonw.exe")
    If Not ex Is Nothing Then
        out = ex.StdOut.ReadAll()
        out = Replace(out, vbCrLf, vbLf)
        out = Replace(out, vbCr, vbLf)
        arr = Split(out, vbLf)
        line = Trim(arr(0))
        If Len(line) > 0 Then
            If fso.FileExists(line) Then FindPythonw = line
        End If
    End If
    On Error GoTo 0
    ' 2) fall back to a pythonw.exe next to this script
    If FindPythonw = "" Then
        line = here & "\pythonw.exe"
        If fso.FileExists(line) Then FindPythonw = line
    End If
    ' 3) then one sitting in the project root
    If FindPythonw = "" Then
        line = root & "\pythonw.exe"
        If fso.FileExists(line) Then FindPythonw = line
    End If
End Function
