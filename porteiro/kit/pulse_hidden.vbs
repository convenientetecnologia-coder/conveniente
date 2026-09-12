' Pulse invisivel. schtasks + powershell.exe Interactive ainda pisca console.
' wscript.exe //B + Run 0 nao abre janela.
Option Explicit
Dim sh, ps, cmd
Set sh = CreateObject("WScript.Shell")
ps = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
cmd = """" & ps & """ -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File C:\auto_vigia\manutencao.ps1 -Action pulse"
sh.Run cmd, 0, True
