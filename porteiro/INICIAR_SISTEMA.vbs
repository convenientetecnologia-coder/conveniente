Set sh = CreateObject("Wscript.Shell")
sh.Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""C:\conveniente\scripts\iniciarSistema.ps1""", 0, False
