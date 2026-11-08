Unicode true
!include "MUI2.nsh"
!include "x64.nsh"

Name "Suno Local"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\Suno Local"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "This package requires 64-bit Windows 11."
    Abort
  ${EndIf}
FunctionEnd

Section "Suno Local"
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD}/*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\Suno Local"
  CreateShortcut "$SMPROGRAMS\Suno Local\Suno Local.lnk" "$INSTDIR\Suno Local.exe"
  CreateShortcut "$SMPROGRAMS\Suno Local\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SunoLocal" "DisplayName" "Suno Local"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SunoLocal" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SunoLocal" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SunoLocal" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SunoLocal" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SunoLocal" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  Delete "$SMPROGRAMS\Suno Local\Suno Local.lnk"
  Delete "$SMPROGRAMS\Suno Local\Uninstall.lnk"
  RMDir "$SMPROGRAMS\Suno Local"
  Delete /REBOOTOK "$INSTDIR\bin\node.exe"
  Delete /REBOOTOK "$INSTDIR\bin\ffmpeg.exe"
  Delete /REBOOTOK "$INSTDIR\bin\ffprobe.exe"
  RMDir /REBOOTOK "$INSTDIR\bin"
  Delete "$INSTDIR\chrome-link\manifest.json"
  Delete "$INSTDIR\chrome-link\background.js"
  Delete "$INSTDIR\chrome-link\connect.html"
  Delete "$INSTDIR\chrome-link\connect.mjs"
  Delete "$INSTDIR\chrome-link\page-request.mjs"
  RMDir "$INSTDIR\chrome-link"
  Delete "$INSTDIR\Third-Party\Node-LICENSE.txt"
  Delete "$INSTDIR\Third-Party\FFmpeg-LICENSE.txt"
  Delete "$INSTDIR\Third-Party\FFmpeg-build.txt"
  Delete "$INSTDIR\Third-Party\LAME-LICENSE.txt"
  Delete "$INSTDIR\Third-Party\Zig-LICENSE.txt"
  Delete "$INSTDIR\Third-Party\MinGW-COPYING.txt"

  Delete "$INSTDIR\Third-Party\Sources.txt"
  RMDir "$INSTDIR\Third-Party"
  Delete "$INSTDIR\app.mjs"
  Delete "$INSTDIR\audio.mjs"
  Delete "$INSTDIR\suno.mjs"
  Delete "$INSTDIR\browser-link.mjs"
  Delete "$INSTDIR\index.html"
  Delete "$INSTDIR\ui.js"
  Delete "$INSTDIR\README.md"
  Delete "$INSTDIR\README.zh-CN.md"
  Delete "$INSTDIR\LICENSE"
  Delete /REBOOTOK "$INSTDIR\Suno Local.exe"
  Delete /REBOOTOK "$INSTDIR\Uninstall.exe"
  RMDir /REBOOTOK "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\SunoLocal"
SectionEnd
