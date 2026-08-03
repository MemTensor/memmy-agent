!ifndef MEMMY_WM_SETTINGCHANGE
  !define MEMMY_WM_SETTINGCHANGE 0x001A
!endif

!ifndef MEMMY_LANG_SIMPCHINESE
  !define MEMMY_LANG_SIMPCHINESE 2052
!endif

!macro customHeader
  !ifdef BUILD_UNINSTALLER
    ; Keep unsigned QA uninstallers usable if Windows or transfer tools touch the NSIS stub.
    CRCCheck off
  !endif
!macroend

; Force per-user installation by skipping the all-users versus current-user choice and using
; %LOCALAPPDATA%\Programs\Memmy, which remains writable by the current user.
; 1) Program Files requires elevation, and a locked uninstaller can make overwrite installation fail.
; 2) Silent background upgrades use NSIS /currentuser and must match the original installation scope.
; 3) A writable per-user directory enables zero-click silent upgrades without elevation.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!ifndef BUILD_UNINSTALLER
  !macro customPageAfterChangeDir
    Page custom MemmyValidateInstallDirectoryPage

    Function MemmyProbeInstallDirectory
      ${StrContains} $R4 "${APP_FILENAME}" $INSTDIR
      ${If} $R4 == ""
        StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
      ${EndIf}

      StrCpy $R0 "$INSTDIR"
      Call MemmyProbeWritableDirectory
    FunctionEnd

    ; Input: $R0 is the exact directory to validate. Output: pushes "1" when
    ; that directory supports create/write/delete operations, else "0".
    Function MemmyProbeWritableDirectory
      StrCpy $R1 ""
      StrCpy $R2 ""
      StrCpy $R3 ""
      StrCpy $R5 "0"

      ; Probe the final target instead of walking upward, so an inaccessible
      ; existing path cannot be mistaken for a missing path with a writable parent.
      ; Remove the target afterward only when this probe created it.
      IfFileExists "$R0\*.*" memmy_writable_probe_target_ready
      ClearErrors
      CreateDirectory "$R0"
      IfErrors memmy_writable_probe_failed
      StrCpy $R5 "1"

      memmy_writable_probe_target_ready:
        ClearErrors
        GetTempFileName $R1 "$R0"
        IfErrors memmy_writable_probe_failed
        Delete "$R1"
        IfErrors memmy_writable_probe_cleanup_failed
        CreateDirectory "$R1"
        IfErrors memmy_writable_probe_cleanup_failed
        StrCpy $R2 "$R1\write-test.tmp"
        FileOpen $R3 "$R2" w
        IfErrors memmy_writable_probe_cleanup_failed
        FileWrite $R3 "Memmy"
        IfErrors memmy_writable_probe_close_failed
        FileClose $R3
        StrCpy $R3 ""
        ClearErrors
        Delete "$R2"
        IfErrors memmy_writable_probe_cleanup_failed
        StrCpy $R2 ""
        ClearErrors
        RMDir "$R1"
        IfErrors memmy_writable_probe_cleanup_failed
        StrCpy $R1 ""
        ${If} $R5 == "1"
          ClearErrors
          RMDir "$R0"
          IfErrors memmy_writable_probe_failed
          StrCpy $R5 "0"
        ${EndIf}
        Push "1"
        Return

      memmy_writable_probe_close_failed:
        FileClose $R3
        StrCpy $R3 ""

      memmy_writable_probe_cleanup_failed:
        ClearErrors
        ${If} $R2 != ""
          Delete "$R2"
        ${EndIf}
        ${If} $R1 != ""
          Delete "$R1"
          RMDir "$R1"
        ${EndIf}
        ClearErrors

      memmy_writable_probe_failed:
        ${If} $R5 == "1"
          ClearErrors
          RMDir "$R0"
        ${EndIf}
        Push "0"
    FunctionEnd

    ; Keep the install-time preflight aligned with resolveMemmyDataRoot in the
    ; desktop main process: retain existing legacy data, otherwise place new
    ; data beside a non-system-drive installation.
    Function MemmyResolveDataDirectory
      ClearErrors
      ReadEnvStr $R6 "MEMMY_HOME"
      IfErrors memmy_data_no_explicit_home
      StrCmp $R6 "" memmy_data_no_explicit_home
      StrCmp $R6 "~" memmy_data_use_legacy
      StrCpy $R7 $R6 2
      StrCmp $R7 "~\" memmy_data_expand_explicit_home
      StrCmp $R7 "~/" memmy_data_expand_explicit_home
      Return

      memmy_data_expand_explicit_home:
        StrCpy $R7 $R6 "" 2
        StrCpy $R6 "$PROFILE\$R7"
        Return

      memmy_data_no_explicit_home:
      IfFileExists "$PROFILE\.memmy\*.*" memmy_data_use_legacy

      ${GetRoot} "$INSTDIR" $R6
      ${GetRoot} "$WINDIR" $R7
      StrCmp $R6 "" memmy_data_use_legacy
      StrCmp $R6 $R7 memmy_data_use_legacy
      StrCpy $R6 "$R6\MemmyData\.memmy"
      Return

      memmy_data_use_legacy:
        StrCpy $R6 "$PROFILE\.memmy"
    FunctionEnd

    Function MemmyValidateInstallDirectoryPage
      GetDlgItem $0 $HWNDPARENT 1
      EnableWindow $0 1

      ${If} ${Silent}
        Abort
      ${EndIf}
      ${If} ${isUpdated}
        Abort
      ${EndIf}

      Call MemmyProbeInstallDirectory
      Pop $1
      StrCmp $1 "1" 0 memmy_install_directory_invalid

      Call MemmyResolveDataDirectory
      StrCpy $R0 "$R6"
      Call MemmyProbeWritableDirectory
      Pop $1
      StrCmp $1 "1" 0 memmy_data_directory_invalid
      Abort

      memmy_install_directory_invalid:
        StrCpy $3 "The selected directory is not writable.$\r$\n$\r$\nChoose a directory your Windows account can write to, such as D:\Memmy. To keep silent updates working, do not choose a directory that requires administrator permission, such as Program Files."
        StrCmp $LANGUAGE ${MEMMY_LANG_SIMPCHINESE} 0 memmy_install_directory_create_page
        StrCpy $3 "所选目录无法写入。$\r$\n$\r$\n请选择当前 Windows 账户可写入的目录，例如 D:\Memmy。为保证静默升级，请勿选择需要管理员权限的目录，例如 Program Files。"
        Goto memmy_install_directory_create_page

      memmy_data_directory_invalid:
        StrCpy $3 "The Memmy data directory is not writable: $R6.$\r$\n$\r$\nChoose an installation drive whose root directory your Windows account can write to, or install Memmy on the Windows system drive."
        StrCmp $LANGUAGE ${MEMMY_LANG_SIMPCHINESE} 0 memmy_install_directory_create_page
        StrCpy $3 "Memmy 数据目录无法写入：$R6。$\r$\n$\r$\n请选择当前 Windows 账户可写入根目录的安装盘，或将 Memmy 安装到 Windows 系统盘。"

      memmy_install_directory_create_page:
        nsDialogs::Create 1018
        Pop $2
        StrCmp $2 error 0 memmy_install_directory_show
        Abort

      memmy_install_directory_show:
        ${NSD_CreateLabel} 0 0 100% 70u "$3"
        Pop $4
        GetDlgItem $0 $HWNDPARENT 1
        EnableWindow $0 0
        nsDialogs::Show
    FunctionEnd
  !macroend
!endif

!ifndef BUILD_UNINSTALLER
  !macro customInstall
    Call MemmyAddCliToUserPath
    Call MemmyInstallLaunchProxy
    !insertmacro MemmyPointShortcutsToLaunchProxy
  !macroend
!endif

!ifdef BUILD_UNINSTALLER
  !macro customUnInstall
    Call un.MemmyRemoveCliFromUserPath
    Call un.MemmyRemoveLaunchProxy
  !macroend
!endif

!ifndef BUILD_UNINSTALLER
Function MemmyPathContains
  Exch $R1
  Exch
  Exch $R0
  StrCpy $R5 "0"
  StrLen $R2 $R1
  StrLen $R3 $R0
  StrCpy $R4 0

  memmy_path_contains_loop:
    StrCpy $R5 $R0 $R2 $R4
    StrCmp $R5 $R1 memmy_path_contains_found
    IntOp $R4 $R4 + 1
    IntCmp $R4 $R3 memmy_path_contains_not_found memmy_path_contains_loop memmy_path_contains_not_found

  memmy_path_contains_found:
    StrCpy $R5 "1"
    Goto memmy_path_contains_done

  memmy_path_contains_not_found:
    StrCpy $R5 "0"

  memmy_path_contains_done:
    Pop $R1
    Exch $R5
FunctionEnd

Function MemmyAddCliToUserPath
  StrCpy $0 "$INSTDIR\resources\cli"
  IfFileExists "$0\memmy.cmd" 0 memmy_add_cli_done
  IfFileExists "$0\memmy-memory.cmd" 0 memmy_add_cli_done

  ReadRegStr $1 HKCU "Environment" "Path"
  StrCmp $1 "" memmy_add_cli_empty

  Push ";$1;"
  Push ";$0;"
  Call MemmyPathContains
  Pop $2
  StrCmp $2 "1" memmy_add_cli_done
  WriteRegExpandStr HKCU "Environment" "Path" "$1;$0"
  Goto memmy_add_cli_broadcast

  memmy_add_cli_empty:
    WriteRegExpandStr HKCU "Environment" "Path" "$0"

  memmy_add_cli_broadcast:
    System::Call 'user32::SendMessageTimeout(i 0xffff, i ${MEMMY_WM_SETTINGCHANGE}, i 0, t "Environment", i 0x0002, i 5000, *i .r0)'

  memmy_add_cli_done:
FunctionEnd

Function MemmyInstallLaunchProxy
  StrCpy $0 "$LOCALAPPDATA\Memmy\launcher"
  CreateDirectory "$0"
  SetOutPath "$0"
  File /oname=Memmy.ico "${BUILD_RESOURCES_DIR}\icon.ico"
  File /oname=MemmyUpdatePrompt.ps1 "${BUILD_RESOURCES_DIR}\MemmyUpdatePrompt.ps1"

  FileOpen $1 "$0\MemmyLauncher.vbs" w
  FileWrite $1 "Set shell = CreateObject($\"WScript.Shell$\")$\r$\n"
  FileWrite $1 "Set fso = CreateObject($\"Scripting.FileSystemObject$\")$\r$\n"
  FileWrite $1 "appExe = $\"$INSTDIR\${PRODUCT_FILENAME}.exe$\"$\r$\n"
  FileWrite $1 "powerShellPath = shell.ExpandEnvironmentStrings($\"%SystemRoot%$\") & $\"\System32\WindowsPowerShell\v1.0\powershell.exe$\"$\r$\n"
  FileWrite $1 "promptPath = $\"$0\MemmyUpdatePrompt.ps1$\"$\r$\n"
  FileWrite $1 "languagePath = shell.ExpandEnvironmentStrings($\"%APPDATA%$\") & $\"\Memmy\update-prompt-language.txt$\"$\r$\n"
  FileWrite $1 "markerPath = shell.ExpandEnvironmentStrings($\"%APPDATA%$\") & $\"\Memmy\prepared-required-update.json$\"$\r$\n"
  FileWrite $1 "lockPath = markerPath & $\".lock$\"$\r$\n"
  FileWrite $1 "promptMarkerPath = markerPath & $\".prompt$\"$\r$\n"
  FileWrite $1 "If fso.FolderExists(lockPath) And fso.FileExists(promptMarkerPath) Then$\r$\n"
  FileWrite $1 "  If fso.FileExists(powerShellPath) And fso.FileExists(promptPath) Then$\r$\n"
  FileWrite $1 "    shell.Run Chr(34) & powerShellPath & Chr(34) & $\" -STA -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $\" & Chr(34) & promptPath & Chr(34) & $\" -LockPath $\" & Chr(34) & lockPath & Chr(34) & $\" -AppExe $\" & Chr(34) & appExe & Chr(34) & $\" -LanguagePath $\" & Chr(34) & languagePath & Chr(34), 0, True$\r$\n"
  FileWrite $1 "  End If$\r$\n"
  FileWrite $1 "  WScript.Quit 0$\r$\n"
  FileWrite $1 "End If$\r$\n"
  FileWrite $1 "If fso.FolderExists(lockPath) Or Not fso.FileExists(appExe) Then$\r$\n"
  FileWrite $1 "  WScript.Quit 0$\r$\n"
  FileWrite $1 "End If$\r$\n"
  FileWrite $1 "shell.CurrentDirectory = fso.GetParentFolderName(appExe)$\r$\n"
  FileWrite $1 "shell.Run Chr(34) & appExe & Chr(34), 1, False$\r$\n"
  FileClose $1

  SetOutPath "$INSTDIR"
FunctionEnd

!macro MemmyPointShortcutsToLaunchProxy
  StrCpy $0 "$LOCALAPPDATA\Memmy\launcher"
  StrCpy $1 "$0\MemmyLauncher.vbs"
  StrCpy $2 "$0\Memmy.ico"
  StrCpy $4 "0"
  IfFileExists "$1" 0 memmy_point_shortcuts_done

  StrCpy $3 "$newStartMenuLink"
  IfFileExists "$3" 0 memmy_point_desktop_shortcut
  CreateShortCut "$3" "$SYSDIR\wscript.exe" "$\"$1$\"" "$2" 0 "" "" "${APP_DESCRIPTION}"
  ClearErrors
  StrCpy $4 "1"

  memmy_point_desktop_shortcut:
    Push "$CMDLINE"
    Push "no-desktop-shortcut"
    Call MemmyPathContains
    Pop $5
    StrCmp $5 "1" memmy_point_shortcuts_done

    StrCmp $keepShortcuts "false" memmy_point_new_desktop_shortcut
    StrCmp $oldDesktopLink $newDesktopLink memmy_point_existing_new_desktop_shortcut
    IfFileExists "$oldDesktopLink" 0 memmy_point_existing_new_desktop_shortcut
    Rename "$oldDesktopLink" "$newDesktopLink"
    ClearErrors
    Goto memmy_point_new_desktop_shortcut

  memmy_point_existing_new_desktop_shortcut:
    IfFileExists "$newDesktopLink" 0 memmy_point_shortcuts_done

  memmy_point_new_desktop_shortcut:
    StrCpy $3 "$newDesktopLink"
    CreateShortCut "$3" "$SYSDIR\wscript.exe" "$\"$1$\"" "$2" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    StrCpy $4 "1"

  memmy_point_shortcuts_done:
    StrCmp $4 "1" 0 memmy_point_no_shortcut_refresh
    System::Call 'Shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'

  memmy_point_no_shortcut_refresh:
!macroend
!endif

!ifdef BUILD_UNINSTALLER
Function un.MemmyRemoveCliFromUserPath
  StrCpy $0 "$INSTDIR\resources\cli"
  ReadRegStr $1 HKCU "Environment" "Path"
  StrCmp $1 "" memmy_remove_cli_done

  Push "$1"
  Push "$0;"
  Push ""
  Call un.MemmyRemovePathSegment
  Pop $1
  Push "$1"
  Push ";$0"
  Push ""
  Call un.MemmyRemovePathSegment
  Pop $1
  Push "$1"
  Push "$0"
  Push ""
  Call un.MemmyRemovePathSegment
  Pop $1
  WriteRegExpandStr HKCU "Environment" "Path" "$1"
  System::Call 'user32::SendMessageTimeout(i 0xffff, i ${MEMMY_WM_SETTINGCHANGE}, i 0, t "Environment", i 0x0002, i 5000, *i .r0)'

  memmy_remove_cli_done:
FunctionEnd

Function un.MemmyRemovePathSegment
  Exch $R2
  Exch
  Exch $R1
  Exch
  Exch 2
  Exch $R0
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  StrCpy $R3 ""
  StrLen $R4 $R0
  StrLen $R5 $R1
  StrCpy $R6 0

  un_memmy_remove_path_loop:
    StrCpy $R7 $R0 $R5 $R6
    StrCmp $R7 $R1 un_memmy_remove_path_match
    StrCpy $R7 $R0 1 $R6
    StrCpy $R3 "$R3$R7"
    IntOp $R6 $R6 + 1
    IntCmp $R6 $R4 un_memmy_remove_path_done un_memmy_remove_path_loop un_memmy_remove_path_done

  un_memmy_remove_path_match:
    StrCpy $R3 "$R3$R2"
    IntOp $R6 $R6 + $R5
    IntCmp $R6 $R4 un_memmy_remove_path_done un_memmy_remove_path_loop un_memmy_remove_path_done

  un_memmy_remove_path_done:
    StrCpy $R0 $R3
    Pop $R7
    Pop $R6
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
FunctionEnd

Function un.MemmyRemoveLaunchProxy
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5

  StrCpy $R0 "$CMDLINE"
  StrCpy $R1 "keep-shortcuts"
  StrLen $R2 $R1
  StrLen $R3 $R0
  StrCpy $R4 0

  un_memmy_keep_shortcuts_loop:
    StrCpy $R5 $R0 $R2 $R4
    StrCmp $R5 $R1 un_memmy_keep_launch_proxy
    IntOp $R4 $R4 + 1
    IntCmp $R4 $R3 un_memmy_remove_launch_proxy un_memmy_keep_shortcuts_loop un_memmy_remove_launch_proxy

  un_memmy_keep_launch_proxy:
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
    Return

  un_memmy_remove_launch_proxy:
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Pop $R0
    ReadRegStr $0 SHELL_CONTEXT "Software\${APP_GUID}" "ShortcutName"
    StrCmp $0 "" 0 un_memmy_delete_old_desktop_shortcut
    StrCpy $0 "${PRODUCT_FILENAME}"

  un_memmy_delete_old_desktop_shortcut:
    Delete "$DESKTOP\$0.lnk"
    Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
    ClearErrors
    RMDir /r "$LOCALAPPDATA\Memmy\launcher"
FunctionEnd
!endif
