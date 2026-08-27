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
; Arc Power installer theme. These MUI values apply to the stock pages that
; remain in the assisted flow; the supplied header/sidebar BMPs carry the
; loader's visual language into the native wizard.
!ifndef MUI_BGCOLOR
  !define MUI_BGCOLOR "090B12"
!endif
!ifndef MUI_TEXTCOLOR
  !define MUI_TEXTCOLOR "EAF6FF"
!endif
!ifndef MUI_DIRECTORYPAGE_BGCOLOR
  !define MUI_DIRECTORYPAGE_BGCOLOR "0D111B"
!endif
!ifndef MUI_DIRECTORYPAGE_TEXTCOLOR
  !define MUI_DIRECTORYPAGE_TEXTCOLOR "EAF6FF"
!endif
!ifndef MUI_LICENSEPAGE_BGCOLOR
  !define MUI_LICENSEPAGE_BGCOLOR "0D111B"
!endif
!ifndef MUI_LICENSEPAGE_TEXTCOLOR
  !define MUI_LICENSEPAGE_TEXTCOLOR "EAF6FF"
!endif
!ifndef MUI_INSTFILESPAGE_COLORS
  !define MUI_INSTFILESPAGE_COLORS "EAF6FF 0D111B"
!endif
; Windows 11 normally paints the non-client caption and border with the
; user's system accent (red in the screenshots). Ask DWM for Arc Power's
; dark-blue caption, cyan-violet border, and light text instead. Older
; Windows versions simply return an unsupported-attribute code, which is
; harmless because the content theme still applies.
!ifdef BUILD_UNINSTALLER
  !define MUI_CUSTOMFUNCTION_UNGUIINIT "un.arcPowerInstallerGuiInit"
!else
  !define MUI_CUSTOMFUNCTION_GUIINIT "arcPowerInstallerGuiInit"
!endif
!define MUI_WELCOMEPAGE_TITLE "Welcome to Arc Power"
!define MUI_WELCOMEPAGE_TEXT "A focused control panel for Intel Arc graphics. Tune, monitor and manage your GPU from one clean workspace.$\r$\n$\r$\nSelect Next to continue with the installation."

!include "MUI2.nsh"

; Recoloring a dialog alone is not enough for native NSIS controls. Windows
; paints radio buttons, checkboxes and nested child dialogs through their own
; windows, so walk the complete child tree and remove the themed-control
; override before applying SetCtlColors. This keeps the page independent of
; electron-builder's generated control IDs.
!macro arcPowerThemeControlTreeBody
  Exch $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  ${If} $0 != 0
    SetCtlColors $0 "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
    System::Call 'UXTHEME::SetWindowTheme(p$0,w" ",w" ")'
    System::Call 'user32::GetWindow(i r0, i 5) i .r1'
    ${While} $1 != 0
      Push $1
      Call "${ARC_POWER_THEME_TREE}"
      Pop $1
      System::Call 'user32::GetWindow(i r1, i 2) i .r2'
      StrCpy $1 $2
    ${EndWhile}
  ${EndIf}
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Exch $0
!macroend

; The stock MUI footer is intentionally left alone on the welcome page. All
; subsequent pages use the same dark footer as their page body, including the
; Back/Next/Cancel buttons and the branding strip.
!macro arcPowerThemeWizardChromeBody
  Push $0
  Push $1
  Push $2
  Push $3
  GetDlgItem $0 $HWNDPARENT 1028
  SetCtlColors $0 "" "${MUI_BGCOLOR}"
  GetDlgItem $0 $HWNDPARENT 1256
  SetCtlColors $0 "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
  GetDlgItem $0 $HWNDPARENT 1035
  SetCtlColors $0 "" "${MUI_BGCOLOR}"
  GetDlgItem $0 $HWNDPARENT 1045
  SetCtlColors $0 "" "${MUI_BGCOLOR}"
  StrCpy $1 1
  ${While} $1 <= 3
    GetDlgItem $0 $HWNDPARENT $1
    ${If} $0 != 0
      SetCtlColors $0 "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
      System::Call 'UXTHEME::SetWindowTheme(p$0,w" ",w" ")'
    ${EndIf}
    IntOp $1 $1 + 1
  ${EndWhile}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro arcPowerInstallerGuiInitBody
  ; DWM COLORREF values are stored as BGR (the byte order is reversed from
  ; the usual CSS/RGB notation): #0D111B, #1E9EEB and #EAF6FF.
  Push $0
  Push $1
  StrCpy $1 0x001B110D
  System::Call 'dwmapi::DwmSetWindowAttribute(i $HWNDPARENT, i 35, *i r1, i 4) i'
  StrCpy $1 0x00EB9E1E
  System::Call 'dwmapi::DwmSetWindowAttribute(i $HWNDPARENT, i 34, *i r1, i 4) i'
  StrCpy $1 0x00FFF6EA
  System::Call 'dwmapi::DwmSetWindowAttribute(i $HWNDPARENT, i 36, *i r1, i 4) i'
  Pop $1
  Pop $0
!macroend

!ifdef BUILD_UNINSTALLER
  !define ARC_POWER_THEME_TREE "un.arcPowerThemeControlTree"
  !define ARC_POWER_THEME_CHROME "un.arcPowerThemeWizardChrome"
!else
  !define ARC_POWER_THEME_TREE "arcPowerThemeControlTree"
  !define ARC_POWER_THEME_CHROME "arcPowerThemeWizardChrome"
!endif

; The electron-builder multi-user page creates its own nsDialogs child and
; does not apply MUI_BGCOLOR. This hook runs after that page has created its
; controls, so the entire nested dialog and the native radio buttons receive
; the Arc Power palette too.
!macro arcPowerInstallModePageShowBody
  FindWindow $0 "#32770" "" $HWNDPARENT
  ${If} $0 != 0
    Push $0
    Call "${ARC_POWER_THEME_TREE}"
    Pop $0
  ${EndIf}
  Call "${ARC_POWER_THEME_CHROME}"
!macroend

; MUI's install-files page already has dark progress/log colors. The installer
; also receives a page-specific tree/chrome pass below. The uninstaller uses
; the shared MUI colors for this stock page because electron-builder's include
; hook is expanded after MUI_UNPAGE_INSTFILES; customUninstallPage remains
; available for the following finish-page callback.
!macro arcPowerInstallFilesPageShowBody
  FindWindow $0 "#32770" "" $HWNDPARENT
  ${If} $0 != 0
    Push $0
    Call "${ARC_POWER_THEME_TREE}"
    Pop $0
  ${EndIf}
  Call "${ARC_POWER_THEME_CHROME}"
!macroend

; Welcome pages keep the stock white button/footer strip by design; only the
; full-window page body is walked here.
!macro arcPowerWelcomePageShowBody
  FindWindow $0 "#32770" "" $HWNDPARENT
  ${If} $0 != 0
    Push $0
    Call "${ARC_POWER_THEME_TREE}"
    Pop $0
  ${EndIf}
!macroend

!ifdef BUILD_UNINSTALLER
  Function un.arcPowerThemeControlTree
    !insertmacro arcPowerThemeControlTreeBody
  FunctionEnd

  Function un.arcPowerThemeWizardChrome
    !insertmacro arcPowerThemeWizardChromeBody
  FunctionEnd

  Function un.arcPowerInstallerGuiInit
    !insertmacro arcPowerInstallerGuiInitBody
  FunctionEnd

  Function un.arcPowerInstallModePageShow
    !insertmacro arcPowerInstallModePageShowBody
  FunctionEnd

  Function un.arcPowerWelcomePageShow
    !insertmacro arcPowerWelcomePageShowBody
  FunctionEnd

  Function un.arcPowerFinishPageShow
    FindWindow $0 "#32770" "" $HWNDPARENT
    ${If} $0 != 0
      Push $0
      Call "${ARC_POWER_THEME_TREE}"
      Pop $0
    ${EndIf}
    Call "${ARC_POWER_THEME_CHROME}"
  FunctionEnd
!else
  Function arcPowerThemeControlTree
    !insertmacro arcPowerThemeControlTreeBody
  FunctionEnd

  Function arcPowerThemeWizardChrome
    !insertmacro arcPowerThemeWizardChromeBody
  FunctionEnd

  Function arcPowerInstallerGuiInit
    !insertmacro arcPowerInstallerGuiInitBody
  FunctionEnd

  Function arcPowerInstallModePageShow
    !insertmacro arcPowerInstallModePageShowBody
  FunctionEnd

  Function arcPowerInstallFilesPageShow
    !insertmacro arcPowerInstallFilesPageShowBody
  FunctionEnd

  Function arcPowerWelcomePageShow
    !insertmacro arcPowerWelcomePageShowBody
  FunctionEnd
!endif

!macro customInstallmode
  !ifdef BUILD_UNINSTALLER
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW "un.arcPowerInstallModePageShow"
  !else
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW "arcPowerInstallModePageShow"
  !endif
!macroend

; electron-builder calls this hook instead of adding its unbranded default
; welcome page. Keeping MUI's page preserves its navigation/accessibility,
; while the Arc Power artwork and palette make it part of the same design.
!macro customWelcomePage
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW "arcPowerWelcomePageShow"
  !insertmacro MUI_PAGE_WELCOME
!macroend

; The uninstaller normally adds its own welcome page. Use the same body-only
; hook so the page stays dark without changing its stock white footer.
!ifdef BUILD_UNINSTALLER
  !macro customUnWelcomePage
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW "un.arcPowerWelcomePageShow"
    !insertmacro MUI_UNPAGE_WELCOME
  !macroend
!endif

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
    ; The next generated stock page is MUI_PAGE_INSTFILES. Attach the hook
    ; here so its native page and footer are themed after they are created.
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW "arcPowerInstallFilesPageShow"
  !macroend

  Function ocClausePageCreate
    !insertmacro MUI_HEADER_TEXT_PAGE "Overclocking risk notice" "Please read before continuing"
    nsDialogs::Create 1018
    Pop $ocClauseDialog
    ${If} $ocClauseDialog == error
      Abort
    ${EndIf}
    SetCtlColors $ocClauseDialog "" "${MUI_BGCOLOR}"
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
    SetCtlColors $ocAcknowledgedCheckbox "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
    ${NSD_SetState} $ocAcknowledgedCheckbox 0
    ${NSD_CreateLabel} 0 32u 100% 220u "Arc Power changes GPU power limits, temperatures, core/VRAM clocks, voltages and fan curves beyond the Intel-standard envelope. Overclocking or overvolting may:$\r$\n  - void your warranty;$\r$\n  - reduce the lifetime of your GPU, PSU or other components;$\r$\n  - cause instability, crashes, data loss or display corruption;$\r$\n  - overheat or damage hardware when used carelessly.$\r$\n$\r$\nYou use Arc Power at your own risk. The developer provides no warranty and accepts no liability for any damage resulting from its use.$\r$\n$\r$\nThis notice is shown once per install; the settings you apply with the tool are always your own responsibility."
    Pop $0
    SetCtlColors $0 "B4C2D8" "${MUI_BGCOLOR}"
    Push $ocClauseDialog
    Call "${ARC_POWER_THEME_TREE}"
    Pop $0
    Call "${ARC_POWER_THEME_CHROME}"
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
    SetCtlColors $finishDialog "" "${MUI_BGCOLOR}"
    ${NSD_CreateLabel} 0 0 100% 40u "Arc Power is installed. Choose the finishing actions below."
    Pop $0
    SetCtlColors $0 "B4C2D8" "${MUI_BGCOLOR}"
    ; M4L fix round: the same manual-style checkbox creation as the OC
    ; page (the bundled ${NSD_CreateCheckbox} macro's buttons did not
    ; respond to clicks on the user's machine).
    nsDialogs::CreateControl "Button" "0x50010003" "0" 0 60u 100% 16u "Create .exe on Desktop"
    Pop $0
    SetCtlColors $0 "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
    ${NSD_SetState} $0 1
    ; keep a handle to the desktop-shortcut checkbox (the leave handler reads it)
    StrCpy $desktopShortcutChecked 1
    ${NSD_OnClick} $0 finishPageDesktopCheckboxChanged
    nsDialogs::CreateControl "Button" "0x50010003" "0" 0 84u 100% 16u "Launch now"
    Pop $0
    SetCtlColors $0 "${MUI_TEXTCOLOR}" "${MUI_BGCOLOR}"
    ${NSD_SetState} $0 1
    StrCpy $launchNowChecked 1
    ${NSD_OnClick} $0 finishPageLaunchCheckboxChanged
    Push $finishDialog
    Call "${ARC_POWER_THEME_TREE}"
    Pop $0
    Call "${ARC_POWER_THEME_CHROME}"
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
  ; The stock uninstaller finish page is full-window and has no page-specific
  ; hook in electron-builder. This macro is inserted immediately before
  ; MUI_UNPAGE_FINISH, so its custom SHOW callback is consumed by that page.
  !macro customUninstallPage
    !define MUI_PAGE_CUSTOMFUNCTION_SHOW "un.arcPowerFinishPageShow"
  !macroend

  !macro customUnInstall
    Delete "$DESKTOP\Arc Power.lnk"
    ; M52: remove only the disposable cache, never durable ArcPower data.
    RMDir /r "$APPDATA\ArcPowerCache"
    ClearErrors
  !macroend
!endif
