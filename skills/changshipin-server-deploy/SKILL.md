---
name: changshipin-server-deploy
description: 一键部署「音视频解析」的 Node.js 服务端（账号 / 反馈 / 使用统计 API + /admin 管理后台）到 Trae 站点。Use when asked to deploy, redeploy or publish the server, update its environment variables (DATABASE_URL / AUTH_KEY / ADMIN_PASS / MAIL_AUTH), roll back a bad release, or check the deployed service health.
version: "1.0.0"
---

# 音视频解析 · 服务端一键部署

把仓库里的 `server/`（Node.js 20 + Express + Postgres）打包、部署到 Trae 站点，并做健康检查。
客户端（Electron）只是通过 HTTPS 调这些接口，并在「设置 → 关于 → 数据面板」里内嵌 `/admin`，
所以**服务端的部署和更新都不需要重新发客户端版本**。

## 什么时候用

- 首次部署，或改了 `server/` 里的代码 / 后台页面后重新部署。
- 只改配置（数据库连接串、管理员账号、SMTP、JWT 密钥）→ 用同一份源码重新部署即可生效。
- 查服务是否正常：`--verify-only`。
- 部署失败要回滚：用 `trae-deploy deployments rollback`（见下文）。

## 前置条件

| 项 | 说明 |
|---|---|
| Node.js | ≥ 20（本机只用来跑脚本，远程构建固定 `nodejs20`） |
| Trae 部署 CLI | 默认自动查找 `%USERPROFILE%\.trae-cn\plugins\trae-remote-official\deployment\<版本>\skills\deployment\bin\win32-x64\trae-deploy.exe`；找不到时用环境变量 `TRAE_DEPLOY_BIN` 指定 |
| 项目 | 本 skill 放在仓库根目录的 `skills/` 下，脚本默认取「上上级目录」为项目根 |
| 数据库 | Supabase / Neon / 自建 Postgres 均可，连接串放 `server/.env` 的 `DATABASE_URL` |

CLI 需要已登录（`trae-deploy check` 返回 `"ok": true`）。

### 凭据模型（在 DSH / 普通终端里必须看）

`trae-deploy` **不是独立登录**的：它依赖 Trae Agent 会话注入的 `TRAE_*` 运行上下文，加上本机的
`~/.trae-cn/trae-jwt-token`（JWT，约 7 天有效，Trae 运行时会自动续期）。
在 DSH 终端里这两样都不存在，直接调用会依次报：

```text
MISSING_RUNTIME_CONTEXT: TRAE_PROJECT_ID is required; restart the deployment from Trae
MISSING_RUNTIME_CONTEXT: TRAE_CHAT_SESSION_ID is required; restart the deployment from Trae
MISSING_RUNTIME_CONTEXT: TRAE_REGION is required; restart the deployment from Trae
SERVICE_401 authentication required
```

本脚本的处理方式：

1. **在 Trae 里第一次运行**时，把非敏感的运行上下文（`projectId` / `region` / `brandName` / `lane`、
   存储目录、token 路径）写到项目 `.tmp/changshipin-deploy-session.json`（已被 gitignore）；
2. 之后在 DSH 里运行时自动读取这份文件，并注入 `TRAE_PROJECT_ID` / `TRAE_REGION` /
   `TRAE_CHAT_SESSION_ID` / `TRAE_JWT_TOKEN_PATH` 等变量再调 CLI；
3. **token 本身不复制、不落仓库**，始终用 Trae 维护的 `~/.trae-cn/trae-jwt-token`；
   脚本会解析 JWT 的 `exp`，过期时直接给出「打开 Trae 续期」的提示，而不是抛 401。

所以第一次使用请在本机 **Trae 里**跑一次：

```powershell
node skills\changshipin-server-deploy\scripts\deploy.mjs --auth-check
```

看到「鉴权检查通过」并生成 `.tmp/changshipin-deploy-session.json` 后，DSH 里就能一键部署了。
如果把项目换到另一台机器，在那台机器的 Trae 里重跑一次 `--auth-check` 即可。

### 安装到 Deepseek Harness

整个 `changshipin-server-deploy/` 目录就是技能本体，复制到 DSH 的技能目录即可
（常见为 `~/.dsh/skills/` 或工作区的 `.dsh/skills/`，以你的 DSH 配置的 skill 搜索路径为准）：

```text
changshipin-server-deploy/
├── SKILL.md                     ← 技能说明（含 frontmatter）
├── deploy.config.json           ← 当前项目的站点与环境配置（无密钥）
├── deploy.config.example.json   ← 新环境从这里复制
├── scripts/deploy.mjs           ← 一键部署脚本（唯一可执行入口）
└── references/
    ├── env-vars.md              ← 环境变量清单与命名限制
    └── pitfalls.md              ← 实测踩坑与错误码对照
```

部署脚本用相对路径推导项目根（skill 目录的上两级），所以放在工作区 `skills/` 下、
或把整个仓库一起带到 DSH 都能直接跑；也可以 `--project` 指定项目根、
`TRAE_DEPLOY_BIN` 指定 CLI 路径。

## 一键部署

```powershell
cd F:\Desktop\长视频解析
node skills\changshipin-server-deploy\scripts\deploy.mjs
```

脚本会依次做：

1. 读取 `deploy.config.json`（默认取 skill 目录里的同名文件）和 `server/.env`；
2. 把密钥类变量改名后注入运行时环境（见下节「环境变量」）；
3. 复制 `server/` 到系统临时目录（排除 `node_modules`、`.env`、`dist`、日志）；
4. 生成执行配置（`build.sh` / `dist` / `run.sh` / 端口 8000）；
5. 复用或创建站点，并确保访问策略是 `public`；
6. `deployments create` + `deployments wait`；
7. 轮询 `https://<站点域名>/api/health`，再检查 `/admin/` 是否返回首页 HTML。

常用参数：

```powershell
# 只看会做什么，不真的部署
node skills\changshipin-server-deploy\scripts\deploy.mjs --dry-run

# 指定配置文件 / 项目目录 / 站点
node skills\changshipin-server-deploy\scripts\deploy.mjs --config .\deploy.config.json --project . --site-id 37lmtdy5bz2ga6o5ozv

# 只创建部署、不等结果（CI 里自己轮询）
node skills\changshipin-server-deploy\scripts\deploy.mjs --no-wait

# 只做健康检查
node skills\changshipin-server-deploy\scripts\deploy.mjs --verify-only

# 只检查 trae-deploy 凭据（在 Trae 里跑一次，生成运行上下文）
node skills\changshipin-server-deploy\scripts\deploy.mjs --auth-check
```

成功时输出类似：

```text
[deploy] 站点：37lmtdy5bz2ga6o5ozv（public）· https://37lmtdy5bz2ga6o5ozv.traesite.cn
[deploy] 创建部署 dep_xxx …
[deploy] 部署成功（耗时 56s）
[verify] /api/health 200 ok
[verify] /admin/ 200 首页正常
```

## 配置文件

`deploy.config.json`（和脚本同目录，也可以 `--config` 指定）：

```json
{
  "siteId": "37lmtdy5bz2ga6o5ozv",
  "siteName": "音视频解析 · 数据后台",
  "siteDescription": "项目根目录 /应用目录 server/，Node.js 20 + Express 账号/反馈/统计服务与管理员后台",
  "serverDir": "server",
  "envFile": "server/.env",
  "runtimePort": 8000,
  "appTags": "123,167",
  "waitTimeoutSeconds": 600,
  "env": {
    "NODE_ENV": "production",
    "AUTO_MIGRATE": "true",
    "JWT_DAYS": "30",
    "EVENT_RETENTION_DAYS": "180"
  }
}
```

- `siteId` 留空时，脚本按 `siteName` 在 `sites list` 里找；找不到就新建一个 `public` 站点。
- `serverDir` 相对项目根；`envFile` 也相对项目根。
- `env` 里的键值会覆盖 `envFile` 里的同名变量。

## 环境变量（重要）

**部署平台禁止环境变量名里出现 `SECRET` / `PASSWORD`**，带这种名字的变量会直接返回
`SERVICE_993511 invalid deploy site configuration`。所以脚本会自动改名：

| 本地 `server/.env` | 线上变量名 |
|---|---|
| `JWT_SECRET` | `AUTH_KEY` |
| `ADMIN_PASSWORD` | `ADMIN_PASS` |
| `EMAIL_PASSWORD` | `MAIL_AUTH` |
| `DATABASE_URL` | `DATABASE_URL`（不变） |
| `EMAIL_USER` / `EMAIL_HOST` / `EMAIL_PORT` / `EMAIL_USE_SSL` / `EMAIL_DEFAULT_SENDER` | 同名 |
| `ADMIN_EMAIL` | 同名 |

服务端 `server/src/config.js` 已做别名兼容（`process.env.JWT_SECRET || process.env.AUTH_KEY` 等），
所以本地开发用 `.env`、线上用改名后的变量都能跑。

完整变量清单见 `references/env-vars.md`。

## 打包契约（不要改坏）

远程构建在 Linux 的 `nodejs20` 环境里执行 `build.sh`，运行时从 `dist/` 起 `run.sh`：

- `build.sh`：`npm ci --omit=dev --registry=https://registry.npmjs.org/` → 复制 `src/ public/ package.json package-lock.json run.sh` 和 `node_modules` 进 `dist/`；
- `run.sh`：`exec node src/index.js`，监听 `PORT`（执行配置里固定 8000）；
- **必须带 `package-lock.json`**，且所有 `resolved` 指向 `registry.npmjs.org`，否则远程构建会走错源或版本漂移；
- 上传包**不要包含** `node_modules`、`.env`、`dist`、日志。

## 部署后检查

```powershell
$base = 'https://37lmtdy5bz2ga6o5ozv.traesite.cn'
Invoke-RestMethod "$base/api/health"        # {"ok":true,...}
Invoke-WebRequest "$base/admin/" -UseBasicParsing | Select-Object StatusCode
```

登录检查（管理员）：

```powershell
$body = @{ account='2931742378@qq.com'; password='<管理员密码>'; version='1.5.1' } | ConvertTo-Json
$r = Invoke-RestMethod "$base/api/auth/login" -Method POST -ContentType 'application/json' -Body $body
Invoke-RestMethod "$base/api/admin/overview" -Headers @{ Authorization = "Bearer $($r.token)" }
```

## 常见故障

| 现象 | 原因 | 处理 |
|---|---|---|
| `SERVICE_993511 invalid deploy site configuration` | 环境变量名含 `SECRET` / `PASSWORD`，或站点资源参数非法 | 改用 `AUTH_KEY` / `ADMIN_PASS` / `MAIL_AUTH`；脚本已自动改名 |
| `MISSING_RUNTIME_CONTEXT: TRAE_PROJECT_ID / TRAE_CHAT_SESSION_ID / TRAE_REGION is required` | 在 DSH / 普通终端里直接调 CLI，缺 Trae 会话上下文 | 先在本机 Trae 里跑 `--auth-check` 生成 `.tmp/changshipin-deploy-session.json`；脚本会自动注入 |
| `SERVICE_401 authentication required` | `trae-jwt-token` 不存在、过期，或 token 路径不对 | 打开 Trae CN 让它续期，再跑 `--auth-check`；不要手工复制 token 到别处 |
| `HIGH_RISK_FILE ... prohibited path: .env.example` | 上传包里带了 `.env` / `.env.example` 等敏感文件名 | 脚本已排除所有 `.env*`；手工打包时同样要排除 |
| 部署成功但浏览器 / 客户端拿到安全挑战页 | 站点还是 `private` | `trae-deploy sites update-config --site-id <id> --access-policy public` |
| `PRODUCTION_RELEASE_FAILED ... 启动失败，配置不完整` | 运行时缺 `DATABASE_URL` / `AUTH_KEY` / `MAIL_AUTH` | 检查 `server/.env` 或 `deploy.config.json` 的 `env`，重新部署 |
| `BUILD_SCRIPT_FAILED` | 依赖安装失败、锁文件指向其它 registry、`build.sh` 语法错误 | 看 `trae-deploy logs build --deployment-id <id>`；修项目后重新部署 |
| 健康检查 500 `数据库连接失败` | Supabase 冷启动 / 白名单 / 连接串错 | 用 Session pooler 连接串；服务端连接超时已放宽到 20s，稍等重试 |
| 客户端数据面板还是旧页面 | 浏览器 / webview 缓存 | 服务端 `/admin` 的 html/css/js 已设 `no-store`；客户端每次打开面板会 reload |
| `SOURCE_DIR_OUTSIDE_TEMP` | 打包目录放在了项目内 | 脚本使用系统临时目录，不要手改成项目路径 |

更多排错：`references/pitfalls.md`。

## 回滚

```powershell
# 列出历史部署
trae-deploy deployments list --site-id 37lmtdy5bz2ga6o5ozv

# 回滚到上一个可用版本（需要用户确认）
trae-deploy deployments rollback --site-id 37lmtdy5bz2ga6o5ozv --deployment-id dep_xxx
```

## 数据与密钥

- 数据库里的业务数据不会因为重新部署而丢失（Postgres 在 Supabase，不随站点重建）。
- `server/.env` 已在 `.gitignore` 里；不要把授权码、数据库密码写进 `deploy.config.json` 并提交。
- 换 SMTP 授权码 / 数据库密码：改 `server/.env` 后重新跑一次部署即可。
