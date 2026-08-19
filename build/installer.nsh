!macro customInstall
  CreateShortCut "$DESKTOP\启动幕境本地视频服务.lnk" "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" "-NoProfile -ExecutionPolicy Bypass -File $\"$INSTDIR\resources\local-video-service\start-mujing-local-video.ps1$\"" "$INSTDIR\MuJing.exe" 0 SW_SHOWNORMAL
!macroend

!macro customUnInstall
  Delete "$DESKTOP\启动幕境本地视频服务.lnk"
!macroend
