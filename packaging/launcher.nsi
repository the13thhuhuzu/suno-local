Unicode true
Name "Suno Local"
OutFile "${OUTPUT}"
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true

Section
  System::Call 'Kernel32::SetEnvironmentVariableW(w "NO_PROXY", w "localhost,127.0.0.1,::1") i .r0'
  nsExec::Exec '"$EXEDIR\bin\node.exe" --use-env-proxy "$EXEDIR\app.mjs"'
  Pop $0
  StrCmp $0 "0" done
    MessageBox MB_OK|MB_ICONEXCLAMATION "Suno Local could not start. Reinstall and try again."
  done:
SectionEnd
