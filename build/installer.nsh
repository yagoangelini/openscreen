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
;
; Identity migration (2.5.0): up to 2.4.0 both IDs were upstream's
; (com.etiennelescot.openscreen[.recorder]). Every shortcut that still carries an old ID
; would stop grouping with the app's windows: the pinned icon and the running window would
; show as two taskbar buttons. So every install retags them all (openscreenRetagShortcuts):
; idempotent, and a no-op on a machine that never had the old IDs.

!define RECORDER_APP_ID "com.yagoangelini.openscreen.recorder"
!define RECORDER_SHORTCUT_NAME "OpenScreen Recorder"

!ifdef MENU_FILENAME
  !define RECORDER_START_MENU_LINK "$SMPROGRAMS\${MENU_FILENAME}\${RECORDER_SHORTCUT_NAME}.lnk"
!else
  !define RECORDER_START_MENU_LINK "$SMPROGRAMS\${RECORDER_SHORTCUT_NAME}.lnk"
!endif
!define RECORDER_DESKTOP_LINK "$DESKTOP\${RECORDER_SHORTCUT_NAME}.lnk"

; Where Explorer keeps the user's taskbar pins, under %APPDATA%. Read from the environment
; rather than $APPDATA, which an all-users install points at ProgramData.
!define OPENSCREEN_TASKBAR_PINS "Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar"

; Retags the .lnk files in DIR that launch EXE: the ones whose arguments are exactly
; "--recorder" get RECORDER_ID, every other one STUDIO_ID. A pin is recognised by its target,
; not by its old ID, so only this app's pins are touched and any ID they carried is fixed.
; Reads target and arguments through IShellLinkW (WinShell has no getter).
!macro openscreenRetagPinnedLinks DIR EXE STUDIO_ID RECORDER_ID
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8

  ; Copied first: DIR may name one of the registers this macro is about to reuse.
  StrCpy $7 "${DIR}"
  FindFirst $0 $1 "$7\*.lnk"
  ${DoWhile} $1 != ""
    StrCpy $8 "$7\$1"
    StrCpy $5 ""
    StrCpy $6 ""
    ; String compares on the HRESULTs: a call System could not make leaves "error", which
    ; an integer compare would read as 0 (S_OK).
    StrCpy $4 "1"
    ; CLSID_ShellLink, CLSCTX_INPROC_SERVER, IID_IShellLinkW
    System::Call "ole32::CoCreateInstance(g '{00021401-0000-0000-C000-000000000046}', p 0, i 1, g '{000214F9-0000-0000-C000-000000000046}', *p .r2) i .r4"
    ${If} $4 == "0"
      StrCpy $4 "1"
      ; QueryInterface(IID_IPersistFile)
      System::Call "$2->0(g '{0000010b-0000-0000-C000-000000000046}', *p .r3) i .r4"
      ${If} $4 == "0"
        StrCpy $4 "1"
        ; IPersistFile::Load(path, STGM_READ). The path goes in by register, not inlined,
        ; so a quote in the user's profile name cannot break the call string.
        System::Call "$3->5(w r8, i 0) i .r4"
        ${If} $4 == "0"
          ; IShellLinkW::GetPath(buf, cch, NULL, 0) and ::GetArguments(buf, cch)
          System::Call "$2->3(w .r5, i ${NSIS_MAX_STRLEN}, p 0, i 0)"
          System::Call "$2->10(w .r6, i ${NSIS_MAX_STRLEN})"
        ${EndIf}
        System::Call "$3->2()"
      ${EndIf}
      System::Call "$2->2()"
    ${EndIf}

    ; StrCmp is case-insensitive, as Windows paths are.
    ${If} $5 == "${EXE}"
      ${If} $6 == "--recorder"
        WinShell::SetLnkAUMI "$8" "${RECORDER_ID}"
      ${Else}
        WinShell::SetLnkAUMI "$8" "${STUDIO_ID}"
      ${EndIf}
      ClearErrors
    ${EndIf}

    FindNext $0 $1
  ${Loop}
  FindClose $0
  ClearErrors

  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro openscreenRetagShortcuts
  ; An update run by the app (--updated) KEEPS the existing Studio shortcuts rather than
  ; recreating them, so the template never restamps them: they would keep the old ID.
  !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
    ${if} ${FileExists} "$newStartMenuLink"
      WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
      ClearErrors
    ${endIf}
  !endif
  !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
    ${if} ${FileExists} "$newDesktopLink"
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
      ClearErrors
    ${endIf}
    ; A Recorder desktop shortcut whose Studio twin the user deleted is not recreated
    ; below, but may still carry the old ID.
    ${if} ${FileExists} "${RECORDER_DESKTOP_LINK}"
      WinShell::SetLnkAUMI "${RECORDER_DESKTOP_LINK}" "${RECORDER_APP_ID}"
      ClearErrors
    ${endIf}
  !endif

  ; Taskbar pins: the shortcut Explorer made when the user pinned the Studio (or the running
  ; HUD, which pins "Openscreen.exe --recorder" from its relaunch command).
  Push $0
  ReadEnvStr $0 APPDATA
  ${if} $0 != ""
    !insertmacro openscreenRetagPinnedLinks "$0\${OPENSCREEN_TASKBAR_PINS}" "$appExe" "${APP_ID}" "${RECORDER_APP_ID}"
  ${endIf}
  Pop $0
!macroend

; ---------------------------------------------------------------------------------------------
; Taskbar pins survive every install (E2E 2.4.0, D-1).
;
; WinShell::UninstShortcut calls IStartMenuPinnedList::RemoveFromList: it UNPINS the shortcut
; from the taskbar, and Windows never lets an installer pin it back. electron-builder's
; template calls it on the "old" Studio shortcut in two places:
;   - the old version's uninstaller, which every install runs first. Only an update started
;     by the app (--updated) passes it --keep-shortcuts; a setup.exe run by hand, silent or
;     not, does not (allowToChangeInstallationDirectory), so it unpinned the Studio even with
;     an unchanged name;
;   - addStartMenuLink / addDesktopLink, when the shortcut name changed (2.1.1 -> 2.4.0:
;     "Openscreen" -> "OpenScreen Studio"): they Rename the old link, then UninstShortcut it.
; Both take the old shortcut's path from the registry value ShortcutName. So, right before
; the install section runs, openscreenShieldPins records the real old name and points that
; value at a shortcut that never exists: both calls then miss. The section reads the value
; before it runs the old uninstaller (setLinkVars), the shortcuts it creates overwrite the
; old ones in place, a renamed one is moved below without UninstShortcut, and
; registryAddInstallInfo writes the real name back. The pinned copy in "User Pinned" is
; never touched, so the pin keeps working and opens the new Openscreen.exe.
; Uninstallers built from this file also skip the unpin themselves (customUnInstall), which
; covers the Recorder's shortcuts too. nsis.shortcutName must still never change
; (electron/launchMode.test.ts): a rename is handled, but only by installers carrying this.

!define OPENSCREEN_PIN_SHIELD_NAME "OpenScreen pin shield - never a shortcut"

!ifndef BUILD_UNINSTALLER
  Var openscreenPreviousShortcutName
!endif

!macro openscreenShieldPins
  Push $0
  ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" ShortcutName
  ${if} $0 == "${OPENSCREEN_PIN_SHIELD_NAME}"
    ; An earlier install that stopped half way: its links carry the current name.
    StrCpy $openscreenPreviousShortcutName "${SHORTCUT_NAME}"
  ${elseif} $0 != ""
    StrCpy $openscreenPreviousShortcutName "$0"
  ${else}
    ; No value: a fresh machine, or an install older than the keepShortcuts mechanism,
    ; whose shortcut was named after the product.
    ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${if} $0 != ""
      StrCpy $openscreenPreviousShortcutName "${PRODUCT_FILENAME}"
    ${endIf}
  ${endIf}
  ${if} $openscreenPreviousShortcutName != ""
    WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" ShortcutName "${OPENSCREEN_PIN_SHIELD_NAME}"
  ${endIf}
  ClearErrors
  Pop $0
!macroend

; Moves a shortcut left under its previous name onto the current one, without UninstShortcut.
!macro openscreenMoveRenamedLink OLD NEW
  ${if} ${FileExists} "${OLD}"
    ${if} ${FileExists} "${NEW}"
      Delete "${OLD}"
    ${else}
      Rename "${OLD}" "${NEW}"
    ${endIf}
    ClearErrors
  ${endIf}
!macroend

!macro openscreenMoveRenamedShortcuts
  ${if} $openscreenPreviousShortcutName != ""
  ${andIf} $openscreenPreviousShortcutName != "${SHORTCUT_NAME}"
    !ifndef DO_NOT_CREATE_START_MENU_SHORTCUT
      !insertmacro openscreenMoveRenamedLink "$SMPROGRAMS\$openscreenPreviousShortcutName.lnk" "$newStartMenuLink"
    !endif
    !ifndef DO_NOT_CREATE_DESKTOP_SHORTCUT
      !insertmacro openscreenMoveRenamedLink "$DESKTOP\$openscreenPreviousShortcutName.lnk" "$newDesktopLink"
    !endif
  ${endIf}
!macroend

; A silent install (an update by the app, or setup.exe /S) shows no pages: shield here.
!macro customInit
  ${if} ${Silent}
    !insertmacro openscreenShieldPins
  ${endIf}
!macroend

; With the wizard, only after its last choice (install mode and folder), so a wizard closed
; before installing leaves the registry as it was.
!macro customPageAfterChangeDir
  Function openscreenShieldPinsPage
    ${ifNot} ${Silent}
      !insertmacro openscreenShieldPins
    ${endIf}
    Abort
  FunctionEnd
  Page custom openscreenShieldPinsPage
!macroend

!macro customInstall
  !insertmacro openscreenMoveRenamedShortcuts

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

  !insertmacro openscreenRetagShortcuts

  System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

!macro customUnInstall
  ; Run by a newer installer (it always passes --updated, and --keep-shortcuts only for an
  ; update the app started): the install that follows overwrites every shortcut in place, so
  ; none is removed here, and the template is pointed past the Studio's (see "Taskbar pins"
  ; above): its WinShell::UninstShortcut would unpin them.
  ${if} ${isUpdated}
    StrCpy $oldStartMenuLink "$PLUGINSDIR\${OPENSCREEN_PIN_SHIELD_NAME}.lnk"
    StrCpy $oldDesktopLink "$PLUGINSDIR\${OPENSCREEN_PIN_SHIELD_NAME}.lnk"
  ${elseif} $oldShortcutName == "${OPENSCREEN_PIN_SHIELD_NAME}"
    ; A real uninstall after an install that stopped half way: the links carry this name.
    StrCpy $oldStartMenuLink "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
    StrCpy $oldDesktopLink "$DESKTOP\${SHORTCUT_NAME}.lnk"
  ${endIf}

  ; A real uninstall only (not --keep-shortcuts, not run by an installer).
  ${ifNot} ${isKeepShortcuts}
  ${andIfNot} ${isUpdated}
    WinShell::UninstAppUserModelId "${RECORDER_APP_ID}"

    WinShell::UninstShortcut "${RECORDER_START_MENU_LINK}"
    Delete "${RECORDER_START_MENU_LINK}"

    WinShell::UninstShortcut "${RECORDER_DESKTOP_LINK}"
    Delete "${RECORDER_DESKTOP_LINK}"
  ${endIf}
!macroend
