; 无论全新安装还是自动更新，都强制重建桌面 / 开始菜单快捷方式，
; 避免某些情况下 NSIS 更新跳过快方式创建，出现「程序还在但快捷方式没了」。
!macro customInstall
  ; 改名后清掉旧名字的快捷方式，避免桌面同时出现两个入口
  Delete "$DESKTOP\长视频解析.lnk"
  Delete "$SMPROGRAMS\长视频解析.lnk"
  Delete "$DESKTOP\视频解析.lnk"
  Delete "$SMPROGRAMS\视频解析.lnk"
  CreateShortCut "$DESKTOP\音视频解析.lnk" "$INSTDIR\音视频解析.exe" "" "$INSTDIR\音视频解析.exe" 0 SW_SHOWNORMAL "" "音视频解析 · 长视频 / 短视频 / 音乐链接解析播放"
  CreateShortCut "$SMPROGRAMS\音视频解析.lnk" "$INSTDIR\音视频解析.exe" "" "$INSTDIR\音视频解析.exe" 0 SW_SHOWNORMAL "" "音视频解析 · 长视频 / 短视频 / 音乐链接解析播放"
!macroend
