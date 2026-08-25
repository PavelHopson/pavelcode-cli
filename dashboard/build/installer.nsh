!define MUI_BGCOLOR "050507"
!define MUI_TEXTCOLOR "F2F5F9"
!define MUI_INSTFILESPAGE_COLORS "C7CDD6 050507"
!define MUI_FINISHPAGE_NOAUTOCLOSE

!macro customHeader
  BrandingText "Eclipse Forge · Ultron ${VERSION}"
!macroend

!macro customInit
  IfFileExists "E:\*.*" 0 +2
  StrCpy $INSTDIR "E:\ADMIN_HOPSON_PC\Программы\Eclipse Ultron"
!macroend
