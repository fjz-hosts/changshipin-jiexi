; 无论全新安装还是自动更新，都强制重建桌面 / 开始菜单快捷方式，
; 避免某些情况下 NSIS 更新跳过快方式创建，出现「程序还在但快捷方式没了」。
!macro customInstall
  CreateShortCut "$DESKTOP\长视频解析.lnk" "$INSTDIR\长视频解析.exe" "" "$INSTDIR\长视频解析.exe" 0 SW_SHOWNORMAL "" "长视频解析 · 四平台链接解析播放"
  CreateShortCut "$SMPROGRAMS\长视频解析.lnk" "$INSTDIR\长视频解析.exe" "" "$INSTDIR\长视频解析.exe" 0 SW_SHOWNORMAL "" "长视频解析 · 四平台链接解析播放"
!macroend