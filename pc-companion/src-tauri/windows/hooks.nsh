; Open Dock installer hooks. PawnIO (pawnio.eu) is the signed driver Open Dock uses to read the CPU
; temperature; the bundled official PawnIO_setup.exe is offered once, when PawnIO isn't installed yet.
!macro NSIS_HOOK_POSTINSTALL
  SetRegView 64
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PawnIO" "DisplayVersion"
  SetRegView lastused
  ${If} $0 == ""
  ${AndIfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION "Install PawnIO so Open Dock can show your CPU temperature?$\r$\n$\r$\nPawnIO is a small signed driver, also used by LibreHardwareMonitor. Windows will ask for permission." IDNO opendock_skip_pawnio
    ExecWait '"$INSTDIR\PawnIO_setup.exe" -install'
    opendock_skip_pawnio:
  ${EndIf}
!macroend
