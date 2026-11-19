# releases\ · 最新安装包存档

这个目录**只放当前最新一版**的安装包，旧版本会被自动清掉。

## 规则

- 每次项目更新 / 发版后，把最新安装包放进来，并删除之前版本的安装包；
- 只留三样东西：`changshipin-Setup-<最新版本>.exe`、`latest.yml`、本说明；
- 二进制**不进 git**（单个约 116MB，超过 GitHub 100MB 单文件上限），`.gitignore` 已忽略；
  安装包的正本在 [GitHub Releases](https://github.com/fjz-hosts/changshipin-jiexi/releases/latest)。

## 怎么同步

在项目根目录执行：

```powershell
node scripts\sync-releases.mjs            # 同步最新 Release，并清理旧版本
node scripts\sync-releases.mjs --check    # 只检查：本地是不是最新版（落后则退出码 1）
```

脚本会取最新 Release 版本 → 镜像断点续传下载 → 用 `latest.yml` 的 `sha512`/`size` 校验 →
原子落地 → 删掉 `changshipin-Setup-*.exe` / `*.blockmap` / `.part` 的旧文件。

## 注意

- 这里的包只用于**存档和发给用户**，不要执行安装，也不要覆盖正式安装目录
  `D:\长视频解析\changshipin-jiexi`（完整规则见项目根目录 `AGENTS.md`）。
- 别用 curl / `gh release download` 下大文件：沙箱里 curl 会 `SEC_E_NO_CREDENTIALS`，
  gh 不支持续传（实测 121MB 下到 18MB 被重置）。
