# 踩坑记录（本项目实测）

## 1. 环境变量名不能带 SECRET / PASSWORD

`deployments create` 会先返回 `SERVICE_993511 invalid deploy site configuration`，看起来像站点配置错误，
实际是这个限制。改名对应关系见 `env-vars.md`。服务端已经做了别名兼容，本地 `.env` 可以保留原名。

## 2. 站点默认是 private，客户端会拿到安全挑战页

`sites create` 不带 `--access-policy` 时默认 `private`。表现是接口返回一段 HTML（字节跳动安全 SDK），
不是 JSON。必须：

```text
trae-deploy sites update-config --site-id <id> --access-policy public
```

脚本在部署前会检查并自动切换。

## 3. 上传包不能带 node_modules / .env

远程构建会自己 `npm ci`。带上本地 `node_modules` 会显著变大（本项目 100MB+），
而且 Windows 上编译的原生模块在 Linux 上不可用。`.env` 里有数据库密码和 SMTP 授权码，绝对不能进包。

另外 **`.env.example` 也会被拒**：CLI 返回
`HIGH_RISK_FILE: prepared source contains a prohibited path: .env.example`，
整个上传直接失败。打包时要排除所有 `.env*` 文件（`scripts/deploy.mjs` 已经处理）。

## 4. 锁文件必须指向 registry.npmjs.org

`package-lock.json` 里如果残留 `registry.npmmirror.com`，远程 `npm ci` 会按锁文件里的绝对地址下载，
可能失败或版本漂移。修复：

```powershell
cd server
Remove-Item package-lock.json
npm install --package-lock-only --registry=https://registry.npmjs.org/
node -e "const l=require('./package-lock.json');const s=new Set();for(const p of Object.values(l.packages)){if(p.resolved)try{s.add(new URL(p.resolved).host)}catch{}};console.log([...s])"
```

## 5. build.sh / run.sh 必须把运行所需文件放进 dist/

运行时只保留 `build.output_dir`（本项目 `dist`），之后从该目录执行 `run.sh`。
`build.sh` 要把 `src/`、`public/`、`package.json`、`package-lock.json`、`run.sh` 和
`node_modules` 一起复制进去，否则会 `MODULE_NOT_FOUND` 或 404 后台页面。

## 6. 静态资源缓存：桌面端 webview 会显示旧后台

`/admin` 的 html/css/js 必须 `Cache-Control: no-store`，否则 Electron 内嵌的 webview
可能一直用旧页面。服务端 `src/index.js` 已配置；客户端 `admin-panel.js` 每次打开面板也会 reload。

## 7. Supabase 冷启动超时

免费实例空闲后会休眠，首次查询可能要几秒。服务端连接超时已放宽到 20 秒并开启 keepAlive。
如果长期 500 `数据库连接失败`：

1. 到 Supabase 控制台确认项目未被暂停；
2. 确认连接串是 **Session pooler**（端口 5432）而不是直连；
3. 特别慢时先在控制台打开一次项目唤醒。

## 8. 部署失败看日志的命令

```powershell
trae-deploy deployments get --deployment-id <id>
trae-deploy logs build  --deployment-id <id>
trae-deploy logs deploy --deployment-id <id>
trae-deploy logs runtime --site-id <id> --since 30m
```

常见错误码：

| 错误码 | 含义 | 处理 |
|---|---|---|
| `SERVICE_993511` | 站点或部署配置非法 | 查环境变量名、资源参数 |
| `SERVICE_993505` | 站点已有进行中的部署 | 先 `deployments wait`，别重复创建 |
| `BUILD_SCRIPT_FAILED` | build.sh 失败 | 看 build 日志，多为依赖 / 锁文件问题 |
| `BUILD_OUTPUT_INVALID` | 产物校验失败 | 检查 dist 结构、软链接、体积 |
| `PRODUCTION_RELEASE_FAILED` | 进程起不来 | 日志里通常直接写了缺哪个环境变量 |

## 9. 不要重复创建部署

`deployments create` 返回网络错误时，先 `deployments list --site-id <id>` 确认是否已经创建成功，
不要直接重试，避免同时跑两个部署。

## 10. 在 DSH / 普通终端里部署：缺 Trae 运行上下文

`trae-deploy` 没有独立的账号密码登录，它靠 Trae Agent 会话注入的变量 + 本机 JWT 文件：

| 依赖 | 位置 / 说明 |
|---|---|
| `TRAE_PROJECT_ID` | 项目 ID，稳定，本项目为 `6aff20291b78165869310b56` |
| `TRAE_CHAT_SESSION_ID` | 会话 ID，每次对话不同；显式传 `--site-id` 时可用任意 uuid 代替 |
| `TRAE_REGION` | `cn`；`check` 不需要，但 `sites get/list`、`deployments create` 需要 |
| `TRAE_BRAND_NAME` / `TRAE_LANE` | `Trae CN` / `prod` |
| `TRAE_JWT_TOKEN_PATH` | `~/.trae-cn/trae-jwt-token`，JWT，约 7 天有效，Trae 运行时会续期 |

缺任何一个都会报 `MISSING_RUNTIME_CONTEXT: ... restart the deployment from Trae`；
token 缺失或过期则是 `SERVICE_401 authentication required`。

`scripts/deploy.mjs` 的解决方式：第一次在 Trae 里运行时把非敏感上下文写到
`.tmp/trae-deploy-session.json`，之后在 DSH 里自动读取并注入；token 始终留在
`~/.trae-cn/trae-jwt-token`，不复制、不进仓库。用法：

```powershell
# 在 Trae 里执行一次
node skills\trae-site-infra\scripts\deploy.mjs --auth-check

# 之后在 DSH 里直接部署（同一台机器、token 未过期）
node skills\trae-site-infra\scripts\deploy.mjs
```

token 过期后在 Trae 里打开一次即可续期；换机器要在新机器的 Trae 里重跑 `--auth-check`。
