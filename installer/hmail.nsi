; hMail Desktop — NSIS installer (MIT License, Copyright (c) 2026 HQV Software)
; Compiled by build\build.ps1:
;   makensis /DVERSION=0.1.0 /DAPPDIR=<work\app> /DOUTDIR=<dist> installer\hmail.nsi

!include "MUI2.nsh"
!include "LogicLib.nsh"

!ifndef VERSION
  !define VERSION "0.1.1"
!endif
!ifndef APPDIR
  !define APPDIR "..\work\app"
!endif
!ifndef OUTDIR
  !define OUTDIR "..\dist"
!endif

!define PRODUCT_NAME  "hMail Desktop"
!define COMPANY       "HQV Software"
!define AUMID         "HQVSoftware.hMailDesktop"
!define ARP_KEY       "Software\Microsoft\Windows\CurrentVersion\Uninstall\hMailDesktop"
!define MAILCLIENT    "SOFTWARE\Clients\Mail\hMail Desktop"

Var DataDir

Name "${PRODUCT_NAME}"
OutFile "${OUTDIR}\hMailDesktopSetup-${VERSION}.exe"
InstallDir "$PROGRAMFILES64\hMail Desktop"
InstallDirRegKey HKLM "${ARP_KEY}" "InstallLocation"
RequestExecutionLevel admin
Unicode true
SetCompressor /SOLID lzma

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=0 "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey /LANG=0 "CompanyName" "${COMPANY}"
VIAddVersionKey /LANG=0 "FileDescription" "${PRODUCT_NAME} Setup"
VIAddVersionKey /LANG=0 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=0 "ProductVersion" "${VERSION}"
VIAddVersionKey /LANG=0 "LegalCopyright" "(c) ${COMPANY}. Based on Mozilla Thunderbird (MPL 2.0)."

; Windows will not let the installer overwrite a running program, and the
; failure arrives file by file as a wall of "cannot write" errors. So: ask,
; then close it properly — a request to quit first, so anything half-written
; to a mailbox is flushed, and a forced kill only if it will not go.
!macro CloseHMail un
Function ${un}CloseRunningApp
  Push $0
  Push $1
  StrCpy $1 0

  hmail_loop:
    nsExec::ExecToStack 'cmd /c tasklist /FI "IMAGENAME eq hmail.exe" /NH | find /I "hmail.exe"'
    Pop $0
    ${If} $0 != 0
      Goto hmail_done
    ${EndIf}

    ${If} $1 == 0
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "hMail Desktop đang chạy. Bấm OK để đóng lại và tiếp tục." IDOK +2
      Goto hmail_abort
    ${EndIf}

    ${If} $1 < 3
      nsExec::ExecToStack 'cmd /c taskkill /IM hmail.exe'
      Pop $0
      Sleep 3000
    ${Else}
      nsExec::ExecToStack 'cmd /c taskkill /F /IM hmail.exe'
      Pop $0
      Sleep 2000
      Goto hmail_done
    ${EndIf}

    IntOp $1 $1 + 1
    Goto hmail_loop

  hmail_abort:
    Pop $1
    Pop $0
    Abort

  hmail_done:
    Pop $1
    Pop $0
FunctionEnd
!macroend
!insertmacro CloseHMail ""
!insertmacro CloseHMail "un."

Function .onInit
  ; The usual place, so anyone who does not care can press Next twice.
  StrCpy $DataDir "$APPDATA\hMail Desktop"
  Call CloseRunningApp
FunctionEnd

Function un.onInit
  Call un.CloseRunningApp
FunctionEnd

!define MUI_ICON "..\branding\hmail.ico"
!define MUI_UNICON "..\branding\hmail.ico"
!define MUI_ABORTWARNING

!insertmacro MUI_PAGE_WELCOME

; The terms are accepted before anything is installed. A disclaimer that only
; lives in a Help menu is worth far less than one the user agreed to first.
!define MUI_LICENSEPAGE_TEXT_TOP "Vui lòng đọc kỹ điều khoản sử dụng."
!define MUI_LICENSEPAGE_TEXT_BOTTOM "Nếu bạn đồng ý với các điều khoản trên, hãy chọn Tôi đồng ý để tiếp tục cài đặt."
!define MUI_LICENSEPAGE_BUTTON "Tôi đồng ý"
!insertmacro MUI_PAGE_LICENSE "..\installer\EULA.txt"

!insertmacro MUI_PAGE_DIRECTORY

; Where the mail itself lives. This is a different question from where the
; program lives, and a much more consequential one: a mailbox grows without
; limit, and plenty of machines have a small system disk and a large second
; one. Thunderbird never asks, which is how people end up with forty gigabytes
; of mail on a full C: drive and no way to move it that does not involve
; editing preferences by hand.
!define MUI_DIRECTORYPAGE_VARIABLE $DataDir
!define MUI_PAGE_HEADER_TEXT "Nơi lưu dữ liệu"
!define MUI_PAGE_HEADER_SUBTEXT "Chọn ổ đĩa và thư mục để hMail lưu thư, lịch, danh bạ và mô hình AI."
!define MUI_DIRECTORYPAGE_TEXT_TOP "Thư và toàn bộ dữ liệu của bạn sẽ nằm ở đây. Hộp thư lớn dần theo thời gian, nên hãy chọn ổ đĩa còn nhiều chỗ. Có thể đổi lại sau trong Cài đặt."
!define MUI_DIRECTORYPAGE_TEXT_DESTINATION "Thư mục dữ liệu"
!insertmacro MUI_PAGE_DIRECTORY

!insertmacro MUI_PAGE_INSTFILES
!define MUI_FINISHPAGE_RUN "$INSTDIR\hmail.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Khởi động hMail Desktop"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Vietnamese"
!insertmacro MUI_LANGUAGE "English"

Section "hMail Desktop" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"
  File /r "${APPDIR}\*.*"
  ; Keep the terms with the program, so they can be read after installing.
  File "..\installer\EULA.txt"

  ; Force a one-shot startup-cache purge after every (re)install
  FileOpen $0 "$INSTDIR\.purgecaches" w
  FileClose $0

  ; --- where the mail lives ---
  ; The profile location is compiled into the application, so it is redirected
  ; the only way that works from outside: profiles.ini with an absolute path.
  ;
  ; Written only when there is no profiles.ini yet. An upgrade must never point
  ; an existing installation at an empty folder — that reads to the user as
  ; "all my mail is gone", and the mail is still on disk where they cannot see
  ; it.
  IfFileExists "$APPDATA\Thunderbird\profiles.ini" keep_profiles 0
    CreateDirectory "$DataDir"
    CreateDirectory "$APPDATA\Thunderbird"
    WriteINIStr "$APPDATA\Thunderbird\profiles.ini" "Profile0" "Name" "default"
    WriteINIStr "$APPDATA\Thunderbird\profiles.ini" "Profile0" "IsRelative" "0"
    WriteINIStr "$APPDATA\Thunderbird\profiles.ini" "Profile0" "Path" "$DataDir"
    WriteINIStr "$APPDATA\Thunderbird\profiles.ini" "Profile0" "Default" "1"
    WriteINIStr "$APPDATA\Thunderbird\profiles.ini" "General" "StartWithLastProfile" "1"
    WriteINIStr "$APPDATA\Thunderbird\profiles.ini" "General" "Version" "2"
  keep_profiles:

  ; Remember the choice so the uninstaller and the application can report it.
  WriteRegStr HKLM "${ARP_KEY}" "DataDirectory" "$DataDir"

  ; Taskbar AppUserModelID — key path is fixed by the compiled-in app name
  WriteRegStr HKLM "SOFTWARE\Mozilla\Thunderbird\TaskBarIDs" "$INSTDIR" "${AUMID}"

  ; Hard block on Mozilla app update (defence in depth, survives file edits)
  WriteRegDWORD HKLM "SOFTWARE\Policies\Mozilla\Thunderbird" "DisableAppUpdate" 1

  ; --- Default Programs / MAPI registration ---
  WriteRegStr HKLM "${MAILCLIENT}" "" "${PRODUCT_NAME}"
  WriteRegStr HKLM "${MAILCLIENT}\DefaultIcon" "" "$INSTDIR\hmail.exe,0"
  WriteRegStr HKLM "${MAILCLIENT}\shell\open\command" "" '"$INSTDIR\hmail.exe" -mail'
  WriteRegStr HKLM "${MAILCLIENT}\Capabilities" "ApplicationName" "${PRODUCT_NAME}"
  WriteRegStr HKLM "${MAILCLIENT}\Capabilities" "ApplicationDescription" "hMail Desktop - ứng dụng email của HQV Software"
  WriteRegStr HKLM "${MAILCLIENT}\Capabilities" "ApplicationIcon" "$INSTDIR\hmail.exe,0"
  WriteRegStr HKLM "${MAILCLIENT}\Capabilities\URLAssociations" "mailto" "hMail.Url.mailto"
  WriteRegStr HKLM "${MAILCLIENT}\Capabilities\StartMenu" "Mail" "${PRODUCT_NAME}"
  WriteRegStr HKLM "SOFTWARE\RegisteredApplications" "${PRODUCT_NAME}" "${MAILCLIENT}\Capabilities"

  ; mailto ProgID
  WriteRegStr HKLM "SOFTWARE\Classes\hMail.Url.mailto" "" "hMail Desktop URL"
  WriteRegStr HKLM "SOFTWARE\Classes\hMail.Url.mailto" "URL Protocol" ""
  WriteRegStr HKLM "SOFTWARE\Classes\hMail.Url.mailto\DefaultIcon" "" "$INSTDIR\hmail.exe,0"
  WriteRegStr HKLM "SOFTWARE\Classes\hMail.Url.mailto\shell\open\command" "" '"$INSTDIR\hmail.exe" -osint -compose "%1"'

  ; hmail:// deep links (OAuth callbacks from the system browser, app links)
  WriteRegStr HKLM "SOFTWARE\Classes\hmail" "" "hMail Desktop Link"
  WriteRegStr HKLM "SOFTWARE\Classes\hmail" "URL Protocol" ""
  WriteRegStr HKLM "SOFTWARE\Classes\hmail\DefaultIcon" "" "$INSTDIR\hmail.exe,0"
  WriteRegStr HKLM "SOFTWARE\Classes\hmail\shell\open\command" "" '"$INSTDIR\hmail.exe" -osint -hmail-url "%1"'

  ; --- Shortcuts ---
  CreateDirectory "$SMPROGRAMS\hMail Desktop"
  CreateShortCut "$SMPROGRAMS\hMail Desktop\hMail Desktop.lnk" "$INSTDIR\hmail.exe" "" "$INSTDIR\hmail.exe" 0
  CreateShortCut "$DESKTOP\hMail Desktop.lnk" "$INSTDIR\hmail.exe" "" "$INSTDIR\hmail.exe" 0

  ; --- Add/Remove Programs ---
  WriteRegStr HKLM "${ARP_KEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKLM "${ARP_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${ARP_KEY}" "Publisher" "${COMPANY}"
  WriteRegStr HKLM "${ARP_KEY}" "DisplayIcon" "$INSTDIR\hmail.exe,0"
  WriteRegStr HKLM "${ARP_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${ARP_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKLM "${ARP_KEY}" "URLInfoAbout" "https://github.com/haoquangviet/hMail-Desktop"
  WriteRegStr HKLM "${ARP_KEY}" "HelpLink" "https://github.com/haoquangviet/hMail-Desktop/issues"
  WriteRegDWORD HKLM "${ARP_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${ARP_KEY}" "NoRepair" 1

  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd

Section "Uninstall"
  ; Application files only — user mail profiles under %APPDATA% are kept.
  RMDir /r "$INSTDIR"

  Delete "$SMPROGRAMS\hMail Desktop\hMail Desktop.lnk"
  RMDir "$SMPROGRAMS\hMail Desktop"
  Delete "$DESKTOP\hMail Desktop.lnk"

  DeleteRegValue HKLM "SOFTWARE\Mozilla\Thunderbird\TaskBarIDs" "$INSTDIR"
  DeleteRegKey HKLM "${MAILCLIENT}"
  DeleteRegValue HKLM "SOFTWARE\RegisteredApplications" "${PRODUCT_NAME}"
  DeleteRegKey HKLM "SOFTWARE\Classes\hMail.Url.mailto"
  DeleteRegKey HKLM "SOFTWARE\Classes\hmail"
  DeleteRegKey HKLM "${ARP_KEY}"
SectionEnd
