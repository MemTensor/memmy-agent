!include "FileFunc.nsh"
!include "getProcessInfo.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"

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

; electron-builder omits its own $pid declaration whenever customCheckAppRunning exists, so this
; declaration must be visible while compiling both the installer and the generated uninstaller.
Var pid

; Keep electron-builder's localized running-app prompt and its normal-then-forced termination
; retries. Force the exact-image/current-user cmd fallback instead of the default $INSTDIR prefix
; check: a custom-drive uninstaller can otherwise resolve a stale/default install directory, miss
; the live Memmy process, and delete resources underneath the tray process. _CHECK_APP_RUNNING
; aborts before file or shortcut cleanup if the process still exists after the forced retry.
!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  StrCpy $IsPowerShellAvailable "1"
  !insertmacro _CHECK_APP_RUNNING

  ; Data migration is an installer transaction. The uninstaller only performs the shared
  ; close-and-verify flow above and must never prepare or mutate migration state.
  !ifndef BUILD_UNINSTALLER
    StrCmp $MemmyIsRelayedUpgrade "1" memmy_check_app_running_done
    StrCmp $MemmyStandardUpgradeSafe "1" memmy_check_app_running_done
    Call MemmyPrepareDirectDataMigration
    Pop $0
    StrCmp $0 "1" memmy_check_app_running_done
    ${IfNot} ${Silent}
      MessageBox MB_OK|MB_ICONSTOP "$R8"
    ${EndIf}
    SetErrorLevel 5
    Quit

    memmy_check_app_running_done:
      ; electron-builder checks $appExe before deciding whether the old uninstaller may keep
      ; shortcuts. A relayed directory move has no executable in the new target yet, so bridge
      ; only that probe to the verified source installation. customUnInstallCheck restores the
      ; packaged target before any new files or registry entries are written.
      StrCmp $MemmyIsRelayedUpgrade "1" 0 memmy_check_app_running_complete
      StrCpy $appExe "$MemmyUpgradeSourceInstallDir\${PRODUCT_FILENAME}.exe"

    memmy_check_app_running_complete:
  !endif
!macroend

!ifndef BUILD_UNINSTALLER
  !define MUI_CUSTOMFUNCTION_ABORT MemmyOnUserAbort
  Var MemmyIsRelayedUpgrade
  Var MemmyStandardUpgradeSafe
  Var MemmyInstalledExePath
  Var MemmyInstalledInstallDir
  Var MemmySelectedInstallDir
  Var MemmyUpgradeRoute
  Var MemmyFinalDirectoryReady
  Var MemmyRelayInstallerMode
  Var MemmyUpgradeSourceInstallDir
  Var MemmyUpgradeTargetInstallDir
  Var MemmyStandardUpgradeCheckScriptPath
  Var MemmyUpgradeWorkDir
  Var MemmyUpgradeBackupRoot
  Var MemmyUpgradeReopenAfterInstall
  Var MemmyPreviousInstallDir
  Var MemmyPreviousInstalledVersion
  Var MemmyDirectMigrationPrepared
  Var MemmyPreparedInstallDir
  Var MemmyDirectSourceDataPath
  Var MemmyDirectSourceInstallDir
  Var MemmyDirectSourceAuthority
  Var MemmyTargetUserDataPath
  Var MemmyTargetRuntimeHomePath
  Var MemmyDataPointerPath
  Var MemmyMigrationStatePath
  Var MemmyInstallationRecordPath
  Var MemmyMigrationScriptPath
  Var MemmyMigrationLockPath
  Var MemmyMigrationLogPath
  Var MemmyInstallerPid

  ; Completed external-v1 installations can use electron-builder's standard NSIS upgrade.
  ; Legacy or uncertain layouts still relay through a copy outside $INSTDIR so old install-local
  ; data survives the uninstall. The relayed child carries an explicit marker to prevent recursion.
  !macro customInit
    StrCpy $MemmyDirectMigrationPrepared "0"
    StrCpy $MemmyStandardUpgradeSafe "0"
    StrCpy $MemmyPreparedInstallDir ""
    StrCpy $MemmyUpgradeRoute "relay"
    StrCpy $MemmyFinalDirectoryReady "0"
    System::Call 'kernel32::GetCurrentProcessId() i.r0'
    StrCpy $MemmyInstallerPid $0
    ReadRegStr $MemmyPreviousInstallDir HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
    ; electron-builder stores DisplayVersion under the uninstall key, while
    ; InstallLocation lives under the product key.
    ReadRegStr $MemmyPreviousInstalledVersion HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
    Call MemmyRelayLegacyUpgrade
    StrCmp $MemmyIsRelayedUpgrade "1" memmy_custom_init_done
    ${If} ${Silent}
      Call MemmyValidateSelectedDirectories
      Pop $0
      StrCmp $0 "1" memmy_custom_init_route memmy_custom_init_failed

      memmy_custom_init_route:
        StrCpy $MemmyFinalDirectoryReady "1"
        Call MemmyRelayLegacyUpgrade
        StrCmp $MemmyUpgradeRoute "blocked" memmy_custom_init_failed memmy_custom_init_done

      memmy_custom_init_failed:
        SetErrorLevel 5
        Quit
    ${EndIf}

    memmy_custom_init_done:
  !macroend

  !macro customPageAfterChangeDir
    Page custom MemmyValidateInstallPage
  !macroend

  ; A relay child is still visible for manual upgrades, but the relay owns the final reopen after
  ; migration completion and version verification. Skipping the child's finish page avoids a
  ; second launch through a shortcut while its proxy is being preserved or refreshed.
  !macro customFinishPage
    Function MemmySkipRelayedFinishPage
      StrCmp $MemmyIsRelayedUpgrade "1" memmy_skip_relayed_finish_page memmy_show_finish_page

      memmy_skip_relayed_finish_page:
        Abort

      memmy_show_finish_page:
    FunctionEnd

    Function MemmyStartAppAfterInstall
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    !define MUI_PAGE_CUSTOMFUNCTION_PRE MemmySkipRelayedFinishPage
    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION MemmyStartAppAfterInstall
    !insertmacro MUI_PAGE_FINISH
  !macroend

  ; electron-builder quits directly when the old uninstaller returns a failure code,
  ; so recover the prepared migration before preserving its existing error behavior.
  !macro customUnInstallCheck
    IfErrors memmy_uninstall_check_exec_failed memmy_uninstall_check_restore_target_app_exe

    memmy_uninstall_check_exec_failed:
      StrCmp $MemmyIsRelayedUpgrade "1" 0 memmy_uninstall_check_exec_failed_report
      StrCpy $appExe "$MemmyUpgradeTargetInstallDir\${PRODUCT_FILENAME}.exe"

    memmy_uninstall_check_exec_failed_report:
      DetailPrint `Uninstall was not successful. Not able to launch uninstaller!`
      Return

    memmy_uninstall_check_restore_target_app_exe:
      StrCmp $MemmyIsRelayedUpgrade "1" 0 memmy_uninstall_check_result
      StrCpy $appExe "$MemmyUpgradeTargetInstallDir\${PRODUCT_FILENAME}.exe"

    memmy_uninstall_check_result:
      ${If} $R0 != 0
        Call MemmyRecoverDirectDataMigration
        MessageBox MB_OK|MB_ICONEXCLAMATION "$(uninstallFailed): $R0"
        DetailPrint `Uninstall was not successful. Uninstaller error code: $R0.`
        SetErrorLevel 2
        Quit
      ${EndIf}
  !macroend

  !macro customInstall
    WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "InstallLocation" "$INSTDIR"
    Call MemmyAddCliToUserPath
    Call MemmyInstallLaunchProxy
    !insertmacro MemmyPointShortcutsToLaunchProxy
    Call MemmyClearRelayedUpgradeMarkers
    ; Release the direct-install barrier only after every install-time mutation is complete.
    Call MemmyCompleteDirectDataMigration
  !macroend
!endif

!ifdef BUILD_UNINSTALLER
  !macro customUnInstall
    Call un.MemmyRemoveCliFromUserPath
    Call un.MemmyRemoveLaunchProxy
  !macroend
!endif

!ifndef BUILD_UNINSTALLER
Function MemmyNormalizeInstallDirectory
  ${GetFileName} "$INSTDIR" $R4
  StrCmp $R4 "${APP_FILENAME}" memmy_normalize_install_done
  StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"

  memmy_normalize_install_done:
FunctionEnd

Function MemmyResolveMigrationPaths
  ${GetRoot} "$INSTDIR" $0
  StrCmp $0 "" memmy_resolve_use_profile
  StrCpy $1 $0 1
  StrCmp $1 "C" memmy_resolve_use_profile
  StrCmp $1 "c" memmy_resolve_use_profile
  StrCpy $MemmyTargetRuntimeHomePath "$0\MemmyData\.memmy"
  Goto memmy_resolve_runtime_done

  memmy_resolve_use_profile:
    StrCpy $MemmyTargetRuntimeHomePath "$PROFILE\.memmy"

  memmy_resolve_runtime_done:
    StrCpy $MemmyTargetUserDataPath "$APPDATA\Memmy"
    StrCpy $MemmyDataPointerPath "$MemmyTargetUserDataPath\data-root.txt"
    StrCpy $MemmyMigrationStatePath "$LOCALAPPDATA\Memmy\data-migration\state.json"
    StrCpy $MemmyInstallationRecordPath "$LOCALAPPDATA\Memmy\data-layout\last-install.json"
    StrCpy $MemmyMigrationLockPath "$LOCALAPPDATA\Memmy\upgrade-staging\active.lock"
    StrCpy $MemmyMigrationLogPath "$LOCALAPPDATA\Memmy\upgrade-logs\data-migration.log"
    StrCmp $MemmyPreviousInstallDir "" 0 memmy_resolve_previous_source
    StrCpy $MemmyDirectSourceDataPath "$INSTDIR\data"
    StrCpy $MemmyDirectSourceInstallDir "$INSTDIR"
    ; A user-selected directory is only a candidate. Without registry evidence, the
    ; migration helper may elevate only an exact persisted install-local record; an
    ; arbitrary residual must never replace already verified external data.
    StrCpy $MemmyDirectSourceAuthority "untrusted-residual"
    Return

  memmy_resolve_previous_source:
    StrCpy $MemmyDirectSourceDataPath "$MemmyPreviousInstallDir\data"
    StrCpy $MemmyDirectSourceInstallDir "$MemmyPreviousInstallDir"
    StrCpy $MemmyDirectSourceAuthority "current-install-authority"
FunctionEnd

; Input: $R0 is the exact directory to validate. Output: pushes "1" when
; that directory supports create/write/delete operations, else "0".
Function MemmyProbeWritableDirectory
  StrCpy $R1 ""
  StrCpy $R2 ""
  StrCpy $R3 ""
  StrCpy $R5 "0"

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

; Resolves and probes the selected install folder, roaming user-data folder, and
; installation-drive runtime folder. Output: pushes "1" on success, else "0".
Function MemmyValidateSelectedDirectories
  Call MemmyNormalizeInstallDirectory
  Call MemmyResolveMigrationPaths

  StrCpy $R0 "$INSTDIR"
  Call MemmyProbeWritableDirectory
  Pop $0
  StrCmp $0 "1" memmy_validate_user_data
  StrCpy $R8 "The selected installation folder $\"$INSTDIR$\" does not have permission. Choose another folder."
  StrCmp $LANGUAGE ${MEMMY_LANG_SIMPCHINESE} 0 memmy_validate_failed
  StrCpy $R8 "当前选择的安装文件夹“$INSTDIR”没有权限，请选择其它目录。"
  Goto memmy_validate_failed

  memmy_validate_user_data:
    StrCpy $R0 "$MemmyTargetUserDataPath"
    Call MemmyProbeWritableDirectory
    Pop $0
    StrCmp $0 "1" memmy_validate_runtime
    StrCpy $R8 "The Memmy account data folder $\"$MemmyTargetUserDataPath$\" is not writable."
    StrCmp $LANGUAGE ${MEMMY_LANG_SIMPCHINESE} 0 memmy_validate_failed
    StrCpy $R8 "Memmy 登录数据目录“$MemmyTargetUserDataPath”没有写入权限，无法继续安装。"
    Goto memmy_validate_failed

  memmy_validate_runtime:
    StrCpy $R0 "$MemmyTargetRuntimeHomePath"
    Call MemmyProbeWritableDirectory
    Pop $0
    StrCmp $0 "1" memmy_validate_succeeded
    StrCpy $R8 "The Memmy data folder $\"$MemmyTargetRuntimeHomePath$\" does not have permission. Choose another installation folder."
    StrCmp $LANGUAGE ${MEMMY_LANG_SIMPCHINESE} 0 memmy_validate_failed
    StrCpy $R8 "当前安装位置对应的数据文件夹“$MemmyTargetRuntimeHomePath”没有权限，请选择其它安装目录。"
    Goto memmy_validate_failed

  memmy_validate_succeeded:
    Push "1"
    Return

  memmy_validate_failed:
    Push "0"
FunctionEnd

Function MemmyExtractDataMigrationScript
  InitPluginsDir
  CreateDirectory "$PLUGINSDIR\MemmyDataMigration"
  SetOutPath "$PLUGINSDIR\MemmyDataMigration"
  File /oname=MemmyWindowsDataMigration.ps1 "${BUILD_RESOURCES_DIR}\MemmyWindowsDataMigration.ps1"
  StrCpy $MemmyMigrationScriptPath "$PLUGINSDIR\MemmyDataMigration\MemmyWindowsDataMigration.ps1"
FunctionEnd

Function MemmyExtractStandardUpgradeCheckScript
  InitPluginsDir
  CreateDirectory "$PLUGINSDIR\MemmyStandardUpgradeCheck"
  SetOutPath "$PLUGINSDIR\MemmyStandardUpgradeCheck"
  File /oname=MemmyWindowsStandardUpgradeCheck.ps1 "${BUILD_RESOURCES_DIR}\MemmyWindowsStandardUpgradeCheck.ps1"
  StrCpy $MemmyStandardUpgradeCheckScriptPath "$PLUGINSDIR\MemmyStandardUpgradeCheck\MemmyWindowsStandardUpgradeCheck.ps1"
FunctionEnd

; An installed application may bypass relay only when its completed external-v1 record, executable
; version, external data paths, migration state, legacy data directory, and installer location all
; pass the fail-closed PowerShell check. A missing installed executable is a normal fresh install.
Function MemmyEvaluateStandardUpgradeSafety
  StrCpy $MemmyStandardUpgradeSafe "0"
  StrCpy $MemmyUpgradeRoute "relay"
  StrCpy $MemmySelectedInstallDir "$INSTDIR"
  StrCpy $MemmyInstalledInstallDir "$INSTDIR"
  StrCpy $MemmyInstalledExePath "$INSTDIR\${PRODUCT_FILENAME}.exe"
  StrCmp $MemmyPreviousInstallDir "" memmy_standard_check_installed_exe
  StrCpy $MemmyInstalledInstallDir "$MemmyPreviousInstallDir"
  StrCpy $MemmyInstalledExePath "$MemmyPreviousInstallDir\${PRODUCT_FILENAME}.exe"

  memmy_standard_check_installed_exe:
    Call MemmyResolveMigrationPaths
    Call MemmyExtractStandardUpgradeCheckScript
    IfFileExists "$MemmyStandardUpgradeCheckScriptPath" 0 memmy_standard_check_failed
    StrCpy $R5 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
    IfFileExists "$R5" 0 memmy_standard_check_failed
    StrCpy $R4 ""
    IfFileExists "$MemmyInstalledExePath" memmy_standard_check_run
    StrCpy $R4 "-AllowMissingExecutable"

  memmy_standard_check_run:
    nsExec::ExecToStack '$\"$R5$\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $\"$MemmyStandardUpgradeCheckScriptPath$\" -InstallDir $\"$MemmyInstalledInstallDir$\" -TargetInstallDir $\"$MemmySelectedInstallDir$\" -TargetUserDataPath $\"$MemmyTargetUserDataPath$\" -TargetRuntimeHomePath $\"$MemmyTargetRuntimeHomePath$\" -InstalledExePath $\"$MemmyInstalledExePath$\" -InstallerPath $\"$EXEPATH$\" -InstallationRecordPath $\"$MemmyInstallationRecordPath$\" -MigrationStatePath $\"$MemmyMigrationStatePath$\" $R4'
    Pop $0
    Pop $1
    DetailPrint "$1"
    StrCmp $0 "0" memmy_standard_check_safe
    StrCmp $0 "2" memmy_standard_check_blocked

  memmy_standard_check_failed:
    DetailPrint "Installed data layout requires the compatibility upgrade relay."
    Return

  memmy_standard_check_safe:
    StrCpy $MemmyStandardUpgradeSafe "1"
    StrCpy $MemmyUpgradeRoute "standard"
    StrCmp $R4 "-AllowMissingExecutable" memmy_standard_check_fresh
    DetailPrint "Completed external-v1 data layout verified; using the standard NSIS upgrade."
    Return

  memmy_standard_check_fresh:
    DetailPrint "No installed Memmy.exe or trusted install-local source was found; using the standard NSIS install path."
    Return

  memmy_standard_check_blocked:
    StrCpy $MemmyUpgradeRoute "blocked"
    StrCpy $R8 "$1"
    DetailPrint "Installation target validation blocked the upgrade."
FunctionEnd

; Performs the migration while the old installation and its registered location still exist.
; Output: pushes "1" on success, else "0" and leaves a user-facing message in $R8.
Function MemmyPrepareDirectDataMigration
  StrCmp $MemmyDirectMigrationPrepared "1" memmy_direct_prepare_already
  Call MemmyResolveMigrationPaths
  Call MemmyExtractDataMigrationScript
  IfFileExists "$MemmyMigrationScriptPath" 0 memmy_direct_prepare_failed

  ; Refresh the previous installation's shortcut proxy before copying. If the
  ; installer later fails, it still points to the old app and becomes usable as
  ; soon as this function releases the lock.
  StrCmp $MemmyPreviousInstallDir "" memmy_direct_prepare_run
  StrCpy $R7 "$INSTDIR"
  StrCpy $INSTDIR "$MemmyPreviousInstallDir"
  Call MemmyInstallLaunchProxy
  StrCpy $INSTDIR "$R7"

  memmy_direct_prepare_run:
    StrCpy $R5 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
    nsExec::ExecToStack '$\"$R5$\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $\"$MemmyMigrationScriptPath$\" -Mode Prepare -SourceDataPath $\"$MemmyDirectSourceDataPath$\" -SourceAuthority $MemmyDirectSourceAuthority -SourceInstallDir $\"$MemmyDirectSourceInstallDir$\" -TargetInstallDir $\"$INSTDIR$\" -SourceInstalledVersion $\"$MemmyPreviousInstalledVersion$\" -InstallationRecordPath $\"$MemmyInstallationRecordPath$\" -LegacyRuntimeHomePath $\"$PROFILE\.memmy$\" -TargetUserDataPath $\"$MemmyTargetUserDataPath$\" -TargetRuntimeHomePath $\"$MemmyTargetRuntimeHomePath$\" -PointerPath $\"$MemmyDataPointerPath$\" -StatePath $\"$MemmyMigrationStatePath$\" -LockPath $\"$MemmyMigrationLockPath$\" -LogPath $\"$MemmyMigrationLogPath$\" -Owner installer -InstallerPid $MemmyInstallerPid -InstallerPath $\"$EXEPATH$\" -InstallerInstallDir $\"$INSTDIR$\" -AcquireLock'
    Pop $0
    Pop $1
    StrCmp $0 "0" memmy_direct_prepare_succeeded
    DetailPrint "Memmy data migration was skipped after a safe rollback; installation will continue."
    RMDir /r "$MemmyMigrationLockPath"
    Goto memmy_direct_prepare_skipped

  memmy_direct_prepare_failed:
    DetailPrint "Memmy data migration helper is unavailable; installation will continue without automatic migration."

  memmy_direct_prepare_skipped:
    StrCpy $MemmyDirectMigrationPrepared "0"
    Push "1"
    Return

  memmy_direct_prepare_succeeded:
    StrCpy $MemmyDirectMigrationPrepared "1"
    StrCpy $MemmyPreparedInstallDir "$INSTDIR"
    Push "1"
    Return

  memmy_direct_prepare_already:
    StrCmp $MemmyPreparedInstallDir $INSTDIR memmy_direct_prepare_already_valid
    DetailPrint "The installation folder changed after data migration started; rolling back and preparing the final folder."
    Call MemmyRecoverDirectDataMigration
    StrCpy $MemmyDirectMigrationPrepared "0"
    Call MemmyResolveMigrationPaths
    Goto memmy_direct_prepare_run

  memmy_direct_prepare_already_valid:
    Push "1"
FunctionEnd

Function MemmyCompleteDirectDataMigration
  StrCmp $MemmyDirectMigrationPrepared "1" 0 memmy_direct_complete_done
  StrCpy $R5 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  nsExec::ExecToStack '$\"$R5$\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $\"$MemmyMigrationScriptPath$\" -Mode Complete -SourceDataPath $\"$MemmyDirectSourceDataPath$\" -SourceAuthority $MemmyDirectSourceAuthority -SourceInstallDir $\"$MemmyDirectSourceInstallDir$\" -SourceInstalledVersion $\"$MemmyPreviousInstalledVersion$\" -InstallationRecordPath $\"$MemmyInstallationRecordPath$\" -LegacyRuntimeHomePath $\"$PROFILE\.memmy$\" -TargetUserDataPath $\"$MemmyTargetUserDataPath$\" -TargetRuntimeHomePath $\"$MemmyTargetRuntimeHomePath$\" -PointerPath $\"$MemmyDataPointerPath$\" -StatePath $\"$MemmyMigrationStatePath$\" -LockPath $\"$MemmyMigrationLockPath$\" -LogPath $\"$MemmyMigrationLogPath$\" -Owner installer'
  Pop $0
  Pop $1
  StrCmp $0 "0" memmy_direct_complete_succeeded
  DetailPrint "Memmy data migration completion failed; the migration will be rolled back and installation will continue."
  Call MemmyRecoverDirectDataMigration
  Goto memmy_direct_complete_done

  memmy_direct_complete_succeeded:
    RMDir /r "$MemmyMigrationLockPath"
    StrCpy $MemmyDirectMigrationPrepared "0"

  memmy_direct_complete_done:
FunctionEnd

Function MemmyRecoverDirectDataMigration
  StrCmp $MemmyDirectMigrationPrepared "1" 0 memmy_direct_recover_done
  StrCpy $R5 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  nsExec::ExecToStack '$\"$R5$\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $\"$MemmyMigrationScriptPath$\" -Mode Recover -SourceDataPath $\"$MemmyDirectSourceDataPath$\" -SourceAuthority $MemmyDirectSourceAuthority -SourceInstallDir $\"$MemmyDirectSourceInstallDir$\" -SourceInstalledVersion $\"$MemmyPreviousInstalledVersion$\" -InstallationRecordPath $\"$MemmyInstallationRecordPath$\" -LegacyRuntimeHomePath $\"$PROFILE\.memmy$\" -TargetUserDataPath $\"$MemmyTargetUserDataPath$\" -TargetRuntimeHomePath $\"$MemmyTargetRuntimeHomePath$\" -PointerPath $\"$MemmyDataPointerPath$\" -StatePath $\"$MemmyMigrationStatePath$\" -LockPath $\"$MemmyMigrationLockPath$\" -LogPath $\"$MemmyMigrationLogPath$\" -Owner installer'
  Pop $0
  Pop $1
  StrCmp $0 "0" 0 memmy_direct_recover_failed
  RMDir /r "$MemmyMigrationLockPath"
  StrCpy $MemmyDirectMigrationPrepared "0"
  Goto memmy_direct_recover_done

  memmy_direct_recover_failed:
    DetailPrint "Memmy data migration recovery failed with exit code $0; handing the prepared transaction to startup recovery."
    nsExec::ExecToStack '$\"$R5$\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $\"$MemmyMigrationScriptPath$\" -Mode RequireRecovery -SourceDataPath $\"$MemmyDirectSourceDataPath$\" -SourceAuthority $MemmyDirectSourceAuthority -SourceInstallDir $\"$MemmyDirectSourceInstallDir$\" -SourceInstalledVersion $\"$MemmyPreviousInstalledVersion$\" -InstallationRecordPath $\"$MemmyInstallationRecordPath$\" -LegacyRuntimeHomePath $\"$PROFILE\.memmy$\" -TargetUserDataPath $\"$MemmyTargetUserDataPath$\" -TargetRuntimeHomePath $\"$MemmyTargetRuntimeHomePath$\" -PointerPath $\"$MemmyDataPointerPath$\" -StatePath $\"$MemmyMigrationStatePath$\" -LockPath $\"$MemmyMigrationLockPath$\" -LogPath $\"$MemmyMigrationLogPath$\" -Owner installer'
    Pop $2
    Pop $3
    StrCmp $2 "0" memmy_direct_recover_handoff_done
    DetailPrint "Memmy startup recovery marker could not be updated; startup will conservatively recover the remaining prepared state."

  memmy_direct_recover_handoff_done:
    ; Never leave an installer-owned lock permanently after installation. Both `prepared`
    ; and `recovery-required` are mandatory rollback phases in the new app startup path.
    RMDir /r "$MemmyMigrationLockPath"
    StrCpy $MemmyDirectMigrationPrepared "0"

  memmy_direct_recover_done:
FunctionEnd

Function .onInstFailed
  Call MemmyRecoverDirectDataMigration
FunctionEnd

Function MemmyOnUserAbort
  Call MemmyRecoverDirectDataMigration
FunctionEnd

Function MemmyValidateInstallPage
  GetDlgItem $0 $HWNDPARENT 1
  EnableWindow $0 1
  ${If} ${Silent}
    Abort
  ${EndIf}
  StrCmp $MemmyIsRelayedUpgrade "1" 0 memmy_validate_page_direct
  Call MemmyValidateSelectedDirectories
  Pop $0
  StrCmp $0 "1" memmy_validate_page_relayed_target memmy_validate_page_show_error

  memmy_validate_page_relayed_target:
    GetFullPathName $1 "$INSTDIR"
    GetFullPathName $2 "$MemmyUpgradeTargetInstallDir"
    StrCmp $1 $2 0 memmy_validate_page_relayed_target_failed
    Abort

  memmy_validate_page_relayed_target_failed:
    StrCpy $R8 "The relayed upgrade target changed after compatibility migration started. Go back and select $\"$MemmyUpgradeTargetInstallDir$\"."
    StrCmp $LANGUAGE ${MEMMY_LANG_SIMPCHINESE} 0 memmy_validate_page_show_error
    StrCpy $R8 "兼容迁移开始后安装目录发生了变化。请返回并选择“$MemmyUpgradeTargetInstallDir”。"
    Goto memmy_validate_page_show_error

  memmy_validate_page_direct:
    Call MemmyValidateSelectedDirectories
    Pop $0
    StrCmp $0 "1" 0 memmy_validate_page_show_error
    StrCpy $MemmyFinalDirectoryReady "1"
    Call MemmyRelayLegacyUpgrade
    StrCmp $MemmyUpgradeRoute "blocked" memmy_validate_page_show_error
    Abort

  memmy_validate_page_show_error:
    nsDialogs::Create 1018
    Pop $2
    StrCmp $2 error 0 memmy_validate_page_show
    Abort

  memmy_validate_page_show:
    ${NSD_CreateLabel} 0 0 100% 75u "$R8"
    Pop $4
    GetDlgItem $0 $HWNDPARENT 1
    EnableWindow $0 0
    nsDialogs::Show
FunctionEnd

Function MemmyRelayLegacyUpgrade
  ${GetParameters} $R0

  ClearErrors
  ${GetOptions} $R0 "--memmy-upgrade-relayed" $R1
  IfErrors memmy_relay_check_legacy
  Call MemmyReadRelayedUpgradeContext
  Return

  memmy_relay_check_legacy:
    StrCmp $MemmyFinalDirectoryReady "1" memmy_relay_evaluate
    Return

  memmy_relay_evaluate:
    Call MemmyEvaluateStandardUpgradeSafety
    StrCmp $MemmyStandardUpgradeSafe "1" memmy_relay_done
    StrCmp $MemmyUpgradeRoute "blocked" memmy_relay_blocked
    StrCpy $MemmyUpgradeSourceInstallDir "$MemmyInstalledInstallDir"
    StrCpy $MemmyUpgradeTargetInstallDir "$MemmySelectedInstallDir"
    StrCpy $MemmyRelayInstallerMode "Interactive"
    ${If} ${Silent}
      StrCpy $MemmyRelayInstallerMode "Silent"
    ${EndIf}

    System::Call 'kernel32::GetCurrentProcessId() i .r2'
    StrCmp $2 "" memmy_relay_failed
    StrCmp $2 "0" memmy_relay_failed
    ${GetProcessInfo} $2 $2 $3 $4 $5 $6
    StrCmp $3 "" memmy_relay_failed
    StrCmp $3 "0" memmy_relay_failed
    StrCpy $R1 "$LOCALAPPDATA\Memmy\upgrade-staging\$2"
    StrCpy $R3 "$R1\MemmyWindowsUpgradeRelay.ps1"
    StrCpy $R4 "$R1\Memmy-${VERSION}-upgrade.exe"
    StrCpy $R5 "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
    StrCpy $R7 "$LOCALAPPDATA\Memmy\upgrade-logs\windows-upgrade.log"
    StrCpy $R8 "$R1\relay-ready"

    ; Direct/manual updates reopen Memmy. A prepared update without the boot-attempt marker was
    ; launched during normal app shutdown and must remain closed. Boot fallback writes .attempt.
    StrCpy $R6 "1"
    IfFileExists "$APPDATA\Memmy\prepared-required-update.json" memmy_relay_resolve_roaming_reopen memmy_relay_check_legacy_reopen

  memmy_relay_resolve_roaming_reopen:
    IfFileExists "$APPDATA\Memmy\prepared-required-update.json.attempt" memmy_relay_stage
    StrCpy $R6 "0"
    Goto memmy_relay_stage

  memmy_relay_check_legacy_reopen:
    IfFileExists "$MemmyUpgradeSourceInstallDir\data\Memmy\prepared-required-update.json" 0 memmy_relay_stage
    IfFileExists "$MemmyUpgradeSourceInstallDir\data\Memmy\prepared-required-update.json.attempt" memmy_relay_stage
    StrCpy $R6 "0"

  memmy_relay_stage:
    ; Refresh the launch proxy before the relay moves $INSTDIR\data. The 1.0.8 proxy only knows
    ; the install-local marker lock, which disappears with that move; the refreshed proxy also
    ; recognizes the relay lock outside $INSTDIR and keeps desktop launches blocked throughout.
    StrCpy $R2 "$INSTDIR"
    StrCpy $INSTDIR "$MemmyUpgradeSourceInstallDir"
    Call MemmyInstallLaunchProxy
    StrCpy $INSTDIR "$R2"
    ClearErrors
    CreateDirectory "$R1"
    SetOutPath "$R1"
    File /oname=MemmyWindowsUpgradeRelay.ps1 "${BUILD_RESOURCES_DIR}\MemmyWindowsUpgradeRelay.ps1"
    IfErrors memmy_relay_failed
    IfFileExists "$R3" 0 memmy_relay_failed
    File /oname=MemmyWindowsUpgradeCleanup.ps1 "${BUILD_RESOURCES_DIR}\MemmyWindowsUpgradeCleanup.ps1"
    IfErrors memmy_relay_failed
    IfFileExists "$R1\MemmyWindowsUpgradeCleanup.ps1" 0 memmy_relay_failed
    File /oname=MemmyWindowsDataMigration.ps1 "${BUILD_RESOURCES_DIR}\MemmyWindowsDataMigration.ps1"
    IfErrors memmy_relay_failed
    IfFileExists "$R1\MemmyWindowsDataMigration.ps1" 0 memmy_relay_failed

    ClearErrors
    FileOpen $0 "$R4" w
    IfErrors memmy_relay_failed
    FileClose $0
    CopyFiles /SILENT "$EXEPATH" "$R4"
    IfErrors memmy_relay_failed
    IfFileExists "$R4" 0 memmy_relay_failed
    IfFileExists "$R5" 0 memmy_relay_failed
    Delete "$R8"

    ClearErrors
    ExecShell "open" "$R5" '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File $\"$R3$\" -InstallerPath $\"$R4$\" -SourceInstallDir $\"$MemmyUpgradeSourceInstallDir$\" -TargetInstallDir $\"$MemmyUpgradeTargetInstallDir$\" -OriginalInstallerPid $2 -LegacyHelperPid $3 -ExpectedVersion $\"${VERSION}$\" -InstalledVersion $\"$MemmyPreviousInstalledVersion$\" -InstallerMode $MemmyRelayInstallerMode -ReopenAfterInstall $R6 -ReadyPath $\"$R8$\" -WorkDir $\"$R1$\" -LogPath $\"$R7$\"' SW_HIDE
    IfErrors memmy_relay_failed
    StrCpy $R9 "0"

  memmy_relay_wait_ready:
    IfFileExists "$R8" memmy_relay_ready
    Sleep 100
    IntOp $R9 $R9 + 1
    IntCmp $R9 100 memmy_relay_failed memmy_relay_wait_ready memmy_relay_failed

  memmy_relay_ready:

    ; The old 1.0.8 helper must not reopen the old executable while the relay owns the upgrade.
    StrCmp $MemmyRelayInstallerMode "Interactive" memmy_relay_interactive_parent_done
    SetErrorLevel 1602
    Quit

  memmy_relay_interactive_parent_done:
    SetErrorLevel 0
    Quit

  memmy_relay_blocked:
    ${If} ${Silent}
      SetErrorLevel 5
      Quit
    ${EndIf}
    Return

  memmy_relay_failed:
    SetOutPath "$INSTDIR"
    SetErrorLevel 2
    Quit

  memmy_relay_done:
FunctionEnd

Function MemmyReadRelayedUpgradeContext
  StrCpy $MemmyIsRelayedUpgrade "0"
  ReadEnvStr $MemmyUpgradeWorkDir "MEMMY_UPGRADE_WORK_DIR"
  ReadEnvStr $MemmyUpgradeBackupRoot "MEMMY_UPGRADE_BACKUP_ROOT"
  ReadEnvStr $MemmyUpgradeReopenAfterInstall "MEMMY_UPGRADE_REOPEN_AFTER_INSTALL"
  ReadEnvStr $MemmyUpgradeSourceInstallDir "MEMMY_UPGRADE_SOURCE_INSTALL_DIR"
  ReadEnvStr $MemmyUpgradeTargetInstallDir "MEMMY_UPGRADE_TARGET_INSTALL_DIR"
  StrCmp $MemmyUpgradeWorkDir "" memmy_relay_context_failed
  StrCmp $MemmyUpgradeBackupRoot "" memmy_relay_context_failed
  StrCmp $MemmyUpgradeSourceInstallDir "" memmy_relay_context_failed
  StrCmp $MemmyUpgradeTargetInstallDir "" memmy_relay_context_failed
  StrCmp $MemmyUpgradeReopenAfterInstall "0" memmy_relay_context_validate_path
  StrCmp $MemmyUpgradeReopenAfterInstall "1" memmy_relay_context_validate_path memmy_relay_context_failed

  memmy_relay_context_validate_path:
    GetFullPathName $6 "$MemmyUpgradeSourceInstallDir"
    StrCmp $6 $MemmyUpgradeSourceInstallDir 0 memmy_relay_context_failed
    GetFullPathName $7 "$MemmyUpgradeTargetInstallDir"
    StrCmp $7 $MemmyUpgradeTargetInstallDir 0 memmy_relay_context_failed
    GetFullPathName $8 "$INSTDIR"
    StrCmp $8 $MemmyUpgradeTargetInstallDir 0 memmy_relay_context_failed
    GetFullPathName $4 "$MemmyUpgradeWorkDir"
    StrCmp $4 $MemmyUpgradeWorkDir 0 memmy_relay_context_failed
    ; The backup root is optional when the previous installation has no data directory.
    ; Validate its exact deterministic path below without requiring it to exist yet.
    StrCpy $0 "$LOCALAPPDATA\Memmy\upgrade-staging\"
    StrLen $1 $0
    StrLen $2 $MemmyUpgradeWorkDir
    IntCmp $2 $1 memmy_relay_context_failed memmy_relay_context_failed memmy_relay_context_compare_path

  memmy_relay_context_compare_path:
    StrCpy $3 $MemmyUpgradeWorkDir $1
    StrCmp $3 $0 0 memmy_relay_context_failed
    StrCpy $4 $MemmyUpgradeWorkDir "" $1
    StrCmp $4 "" memmy_relay_context_failed
    ${GetFileName} "$MemmyUpgradeWorkDir" $5
    StrCmp $4 $5 0 memmy_relay_context_failed
    StrCpy $0 "$MemmyUpgradeSourceInstallDir.memmy-upgrade-backup\$4"
    StrCmp $MemmyUpgradeBackupRoot $0 0 memmy_relay_context_failed
    StrCpy $MemmyIsRelayedUpgrade "1"
    Return

  memmy_relay_context_failed:
    SetErrorLevel 2
    Quit
FunctionEnd

Function MemmyClearRelayedUpgradeMarkers
  StrCmp $MemmyIsRelayedUpgrade "1" 0 memmy_clear_relayed_markers_done
  StrCpy $0 "$INSTDIR\data\Memmy\prepared-required-update.json"
  Delete "$0"
  RMDir /r "$0.lock"
  Delete "$0.prompt"
  Delete "$0.attempt"

  memmy_clear_relayed_markers_done:
FunctionEnd

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
  File /oname=MemmyWindowsUpgradeRecovery.ps1 "${BUILD_RESOURCES_DIR}\MemmyWindowsUpgradeRecovery.ps1"
  File /oname=MemmyWindowsDataMigration.ps1 "${BUILD_RESOURCES_DIR}\MemmyWindowsDataMigration.ps1"

  FileOpen $1 "$0\MemmyLauncher.vbs" w
  FileWrite $1 "Set shell = CreateObject($\"WScript.Shell$\")$\r$\n"
  FileWrite $1 "Set fso = CreateObject($\"Scripting.FileSystemObject$\")$\r$\n"
  FileWrite $1 "appExe = $\"$INSTDIR\${PRODUCT_FILENAME}.exe$\"$\r$\n"
  FileWrite $1 "userDataRoot = shell.ExpandEnvironmentStrings($\"%APPDATA%$\") & $\"\Memmy$\"$\r$\n"
  FileWrite $1 "legacyUserDataRoot = $\"$INSTDIR\data\Memmy$\"$\r$\n"
  FileWrite $1 "powerShellPath = shell.ExpandEnvironmentStrings($\"%SystemRoot%$\") & $\"\System32\WindowsPowerShell\v1.0\powershell.exe$\"$\r$\n"
  FileWrite $1 "promptPath = $\"$0\MemmyUpdatePrompt.ps1$\"$\r$\n"
  FileWrite $1 "recoveryPath = $\"$0\MemmyWindowsUpgradeRecovery.ps1$\"$\r$\n"
  FileWrite $1 "migrationRecoveryPath = $\"$0\MemmyWindowsDataMigration.ps1$\"$\r$\n"
  FileWrite $1 "migrationStatePath = shell.ExpandEnvironmentStrings($\"%LOCALAPPDATA%$\") & $\"\Memmy\data-migration\state.json$\"$\r$\n"
  FileWrite $1 "migrationLogPath = shell.ExpandEnvironmentStrings($\"%LOCALAPPDATA%$\") & $\"\Memmy\upgrade-logs\data-migration.log$\"$\r$\n"
  FileWrite $1 "upgradeLogPath = shell.ExpandEnvironmentStrings($\"%LOCALAPPDATA%$\") & $\"\Memmy\upgrade-logs\windows-upgrade.log$\"$\r$\n"
  FileWrite $1 "languagePath = userDataRoot & $\"\update-prompt-language.txt$\"$\r$\n"
  FileWrite $1 "markerPath = userDataRoot & $\"\prepared-required-update.json$\"$\r$\n"
  FileWrite $1 "legacyMarkerPath = legacyUserDataRoot & $\"\prepared-required-update.json$\"$\r$\n"
  FileWrite $1 "If (Not fso.FileExists(markerPath)) And (fso.FileExists(legacyMarkerPath) Or fso.FolderExists(legacyMarkerPath & $\".lock$\")) Then$\r$\n"
  FileWrite $1 "  markerPath = legacyMarkerPath$\r$\n"
  FileWrite $1 "  languagePath = legacyUserDataRoot & $\"\update-prompt-language.txt$\"$\r$\n"
  FileWrite $1 "End If$\r$\n"
  FileWrite $1 "lockPath = markerPath & $\".lock$\"$\r$\n"
  FileWrite $1 "relayLockPath = shell.ExpandEnvironmentStrings($\"%LOCALAPPDATA%$\") & $\"\Memmy\upgrade-staging\active.lock$\"$\r$\n"
  FileWrite $1 "If fso.FolderExists(relayLockPath) And fso.FileExists(recoveryPath) Then$\r$\n"
  FileWrite $1 "  shell.Run Chr(34) & powerShellPath & Chr(34) & $\" -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File $\" & Chr(34) & recoveryPath & Chr(34) & $\" -InstallDir $\" & Chr(34) & fso.GetParentFolderName(appExe) & Chr(34) & $\" -LockPath $\" & Chr(34) & relayLockPath & Chr(34) & $\" -LogPath $\" & Chr(34) & upgradeLogPath & Chr(34) & $\" -DirectMigrationStatePath $\" & Chr(34) & migrationStatePath & Chr(34) & $\" -DirectMigrationScriptPath $\" & Chr(34) & migrationRecoveryPath & Chr(34) & $\" -DirectMigrationLogPath $\" & Chr(34) & migrationLogPath & Chr(34), 0, True$\r$\n"
  FileWrite $1 "End If$\r$\n"
  FileWrite $1 "If fso.FolderExists(relayLockPath) Then$\r$\n"
  FileWrite $1 "  lockPath = relayLockPath$\r$\n"
  FileWrite $1 "End If$\r$\n"
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
    ; Electron registers app.setLoginItemSettings under this per-user Run value.
    ; The keep-shortcuts upgrade branch returns above so the user's preference survives updates.
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
    ClearErrors
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
