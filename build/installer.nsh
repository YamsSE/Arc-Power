; Arc Power - M4J (I) installer customizations.
;
;   (a) the overclocking-risk clause page + a mandatory acknowledgment
;       checkbox - Next is BLOCKED until checked (the leave handler aborts);
;       customPageAfterChangeDir is the insertion point; silent /S skips
;       every page, so the checkbox vars are DEFAULTED in customInit.
;   (b) the finish page is REBUILT (customFinishPage REPLACES the whole
;       MUI finish page): 'Create .exe on Desktop' (default checked) +
;       'Launch now' (default checked) - the launch via ExecShellAsUser,
;       the checkbox-gated CreateShortCut to $DESKTOP\Arc Power.lnk. The
;       shortcut itself is created in the install section (customInstall -
;       the SILENT path never sees the pages, so the defaulted-var gate
;       must live there); an interactive user who UNCHECKS the box on the
;       finish page gets the .lnk removed in the leave handler (the
;       checkbox is truthful in both modes).
;   (c) the custom uninstall section (customUnInstall) deletes
;       $DESKTOP\Arc Power.lnk (F3 - createDesktopShortcut:false would
;       otherwise leave the uninstaller blind to the .lnk we created).
;
; The clause text ships with this file (and therefore in the installer).
;
; Build mechanics: the CUSTOM include is inserted at the TOP of the
; generated script - BEFORE the main body's `!include "MUI2.nsh"` - so this
; file pulls its own macro dependencies (MUI2 has the MUI_INCLUDED guard -
; re-including is safe; it itself pulls WinMessages/LogicLib/nsDialogs;
; StdUtils is already included by the generated header before this file).
; The script is compiled TWICE (installer + uninstaller passes) with
; BUILD_UNINSTALLER defined on the second pass - electron-builder treats
; every makensis warning as fatal, so the install-side functions are only
; DEFINED in the installer pass (the uninstaller pass would otherwise warn
; 6010: "function not referenced").
!include "MUI2.nsh"

!ifndef BUILD_UNINSTALLER
  ; --- state vars (defaulted in customInit - the silent path never runs
  ; --- the page create/leave handlers) --------------------------------------
  Var ocAcknowledgedCheckbox
  Var ocAcknowledged
  Var desktopShortcutChecked
  Var launchNowChecked
  Var ocClauseDialog
  Var finishDialog

  !macro customInit
    ; silent /S skips every page: the vars are DEFAULTED here. The OC ack
    ; defaults CHECKED for silent installs (the clause ships in the
    ; installer itself - running the installer IS the acknowledgment on the
    ; silent path); interactive installs start the checkbox UNCHECKED (the
    ; leave handler blocks Next until the user ticks it).
    StrCpy $ocAcknowledged 1
    StrCpy $desktopShortcutChecked 1
    StrCpy $launchNowChecked 1
  !macroend

  ; --- (a) the overclocking-risk clause page (before the install starts) ----
  !macro customPageAfterChangeDir
    Page custom ocClausePageCreate ocClausePageLeave
  !macroend

  Function ocClausePageCreate
    !insertmacro MUI_HEADER_TEXT_PAGE "Overclocking risk notice" "Please read before continuing"
    nsDialogs::Create 1018
    Pop $ocClauseDialog
    ${If} $ocClauseDialog == error
      Abort
    ${EndIf}
    ; M4L fix round: the ${NSD_CreateCheckbox} macro in the bundled
    ; nsDialogs produced a NON-functioning checkbox on the user's machine
    ; (live-verified: a real mouse click did not toggle it - the installer
    ; was stuck on this page). The manual CreateControl with the explicit
    ; BS_AUTOCHECKBOX style (verified via GetWindowLong) + the checkbox
    ; placed ABOVE the clause label (nothing can cover it) is the fix.
    ; The accept also works via the keyboard (the checkbox is a tab-stop;
    ; SPACE toggles it - the page never blocks without a way out).
    nsDialogs::CreateControl "Button" "0x50010003" "0" 0 8u 100% 16u "I understand and accept the overclocking risk"
    Pop $ocAcknowledgedCheckbox
    ${NSD_SetState} $ocAcknowledgedCheckbox 0
    ${NSD_CreateLabel} 0 32u 100% 220u "Arc Power changes GPU power limits, temperatures, core/VRAM clocks, voltages and fan curves beyond the Intel-standard envelope. Overclocking or overvolting may:$\r$\n  - void your warranty;$\r$\n  - reduce the lifetime of your GPU, PSU or other components;$\r$\n  - cause instability, crashes, data loss or display corruption;$\r$\n  - overheat or damage hardware when used carelessly.$\r$\n$\r$\nYou use Arc Power at your own risk. The developer provides no warranty and accepts no liability for any damage resulting from its use.$\r$\n$\r$\nThis notice is shown once per install; the settings you apply with the tool are always your own responsibility."
    Pop $0
    nsDialogs::Show
  FunctionEnd

  Function ocClausePageLeave
    ${NSD_GetState} $ocAcknowledgedCheckbox $ocAcknowledged
    ${If} $ocAcknowledged == 0
      MessageBox MB_ICONEXCLAMATION|MB_OK "You must acknowledge the overclocking risk notice before you can install Arc Power."
      Abort
    ${EndIf}
  FunctionEnd

  ; --- the desktop shortcut (created in the install section so the SILENT
  ; --- path gets the defaulted-var behavior; removed again on the finish
  ; --- page when an interactive user unchecks the box) ----------------------
  !macro customInstall
    ; M52: cache is disposable; durable %APPDATA%\ArcPower profiles remain.
    RMDir /r "$APPDATA\ArcPowerCache"
    ClearErrors
    ${If} $desktopShortcutChecked == 1
      CreateShortCut "$DESKTOP\Arc Power.lnk" "$INSTDIR\${PRODUCT_FILENAME}.exe" "" "$INSTDIR\${PRODUCT_FILENAME}.exe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$DESKTOP\Arc Power.lnk" "${APP_ID}"
    ${EndIf}
  !macroend

  ; --- (b) the rebuilt finish page: two checkboxes + Finish -----------------
  !macro customFinishPage
    Page custom finishPageCreate finishPageLeave
  !macroend

  Function finishPageCreate
    !insertmacro MUI_HEADER_TEXT_PAGE "Completing Arc Power Setup" "Arc Power was installed successfully"
    nsDialogs::Create 1018
    Pop $finishDialog
    ${If} $finishDialog == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 40u "Arc Power is installed. Choose the finishing actions below."
    Pop $0
    ; M4L fix round: the same manual-style checkbox creation as the OC
    ; page (the bundled ${NSD_CreateCheckbox} macro's buttons did not
    ; respond to clicks on the user's machine).
    nsDialogs::CreateControl "Button" "0x50010003" "0" 0 60u 100% 16u "Create .exe on Desktop"
    Pop $0
    ${NSD_SetState} $0 1
    ; keep a handle to the desktop-shortcut checkbox (the leave handler reads it)
    StrCpy $desktopShortcutChecked 1
    ${NSD_OnClick} $0 finishPageDesktopCheckboxChanged
    nsDialogs::CreateControl "Button" "0x50010003" "0" 0 84u 100% 16u "Launch now"
    Pop $0
    ${NSD_SetState} $0 1
    StrCpy $launchNowChecked 1
    ${NSD_OnClick} $0 finishPageLaunchCheckboxChanged
    ; label the Next button "Finish" (this is the last page; WM_SETTEXT = 0x000C)
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 0x000C 0 "STR:Finish"
    nsDialogs::Show
  FunctionEnd

  Function finishPageDesktopCheckboxChanged
    Pop $0
    ${NSD_GetState} $0 $desktopShortcutChecked
  FunctionEnd

  Function finishPageLaunchCheckboxChanged
    Pop $0
    ${NSD_GetState} $0 $launchNowChecked
  FunctionEnd

  Function finishPageLeave
    ; an interactive user who uncheckED the desktop box: remove the .lnk the
    ; install section created (the checkbox is truthful in both modes).
    ${If} $desktopShortcutChecked == 0
      Delete "$DESKTOP\Arc Power.lnk"
      ClearErrors
    ${EndIf}
    ${If} $launchNowChecked == 1
      ${StdUtils.ExecShellAsUser} $0 "$INSTDIR\${PRODUCT_FILENAME}.exe" "open" ""
    ${EndIf}
  FunctionEnd
!else
  ; --- (c) the uninstaller removes the desktop .lnk --------------------------
  !macro customUnInstall
    Delete "$DESKTOP\Arc Power.lnk"
    ; M52: remove only the disposable cache, never durable ArcPower data.
    RMDir /r "$APPDATA\ArcPowerCache"
    ClearErrors
  !macroend
!endif
