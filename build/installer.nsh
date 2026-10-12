; Custom steps for electron-builder's NSIS installer (electron-builder.json5 → nsis.include).
;
; Windows gets two entry points to the same Openscreen.exe (electron/launchMode.ts):
;   "OpenScreen Studio"   Openscreen.exe              the app's AppUserModelID (the template
;                                                      creates it: nsis.shortcutName)
;   "OpenScreen Recorder" Openscreen.exe --recorder   its own ID and the REC-dot icon (here)
;
; The Recorder's ID must match RECORDER_APP_USER_MODEL_ID in electron/launchMode.ts: the
; HUD sets it on its window, and the taskbar only groups (and pins) the HUD under this
; shortcut when the two agree. electron/launchMode.test.ts checks they do.

!define RECORDER_APP_ID "com.etiennelescot.openscreen.recorder"
!define RECORDER_SHORTCUT_NAME "OpenScreen Recorder"

!ifdef MENU_FILENAME
  !define RECORDER_START_MENU_LINK "$SMPROGRAMS\${MENU_FILENAME}\${RECORDER_SHORTCUT_NAME}.lnk"
!else
  !define RECORDER_START_MENU_LINK "$SMPROGRAMS\${RECORDER_SHORTCUT_NAME}.lnk"
!endif
!define RECORDER_DESKTOP_LINK "$DESKTOP\${RECORDER_SHORTCUT_NAME}.lnk"

!macro customInstall
  ; Always (re)created, updates included: it is how the user finds the Recorder to pin it.
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    CreateShortCut "${RECORDER_START_MENU_LINK}" "$appExe" "--recorder" "$INSTDIR\resources\recorder.ico" 0 "" "" "${RECORDER_SHORTCUT_NAME}"
    ClearErrors
    WinShell::SetLnkAUMI "${RECORDER_START_MENU_LINK}" "${RECORDER_APP_ID}"
  !endif

  ; On the desktop only where the Studio has one: the template has already created, kept
  ; or skipped that one by the user's choice, so the Recorder follows it.
  !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
    ${if} ${FileExists} "$newDesktopLink"
      CreateShortCut "${RECORDER_DESKTOP_LINK}" "$appExe" "--recorder" "$INSTDIR\resources\recorder.ico" 0 "" "" "${RECORDER_SHORTCUT_NAME}"
      ClearErrors
      WinShell::SetLnkAUMI "${RECORDER_DESKTOP_LINK}" "${RECORDER_APP_ID}"
    ${endIf}
  !endif

  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  ; An update runs the old uninstaller with --keep-shortcuts; the new install refreshes them.
  ${ifNot} ${isKeepShortcuts}
    WinShell::UninstAppUserModelId "${RECORDER_APP_ID}"

    WinShell::UninstShortcut "${RECORDER_START_MENU_LINK}"
    Delete "${RECORDER_START_MENU_LINK}"

    WinShell::UninstShortcut "${RECORDER_DESKTOP_LINK}"
    Delete "${RECORDER_DESKTOP_LINK}"
  ${endIf}
!macroend
