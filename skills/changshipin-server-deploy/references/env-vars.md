# 运行时环境变量

服务端读取 `server/src/config.js`，线上通过部署执行配置的 `runtime.environment` 注入。
本地开发把同样的键写在 `server/.env`（已被 `.gitignore` 忽略）。

| 变量（线上名） | 本地名 | 必填 | 说明 |
|---|---|---|---|
| `DATABASE_URL` | 同 | ✅ | Postgres 连接串。Supabase 用 **Connect → Session pooler** 那一串；服务端会自动对 supabase / neon 开启 SSL |
| `AUTH_KEY` | `JWT_SECRET` | ✅ | 登录 token 签名密钥，建议 32 位以上随机十六进制 |
| `ADMIN_EMAIL` | 同 | ✅ | 管理员邮箱，首次启动自动建号 / 升级为 `role=admin` |
| `ADMIN_PASS` | `ADMIN_PASSWORD` | ⬜ | 仅首次创建管理员时使用；已有账号后改这里不会改密码（改密码走客户端或后台） |
| `MAIL_AUTH` | `EMAIL_PASSWORD` | ✅ | SMTP 授权码（QQ 邮箱在「设置 → 账户 → POP3/IMAP/SMTP」生成） |
| `EMAIL_HOST` | 同 | ✅ | 默认 `smtp.qq.com` |
| `EMAIL_PORT` | 同 | ✅ | 默认 `465` |
| `EMAIL_USE_SSL` | 同 | ⬜ | 默认 `True`；465 端口必须为 true |
| `EMAIL_USER` | 同 | ✅ | 发信邮箱 |
| `EMAIL_DEFAULT_SENDER` | 同 | ⬜ | 默认同 `EMAIL_USER` |
| `PORT` | 同 | ✅ | 必须与执行配置 `runtime.port` 一致（本项目固定 8000） |
| `AUTO_MIGRATE` | 同 | ⬜ | 默认 `true`，启动时建表 + 初始化管理员 |
| `JWT_DAYS` | 同 | ⬜ | 登录有效期，默认 30 天 |
| `EVENT_RETENTION_DAYS` | 同 | ⬜ | 使用事件保留天数，默认 180 |
| `PG_POOL_MAX` | 同 | ⬜ | 连接池上限，默认 5 |

## 命名限制

部署平台会拒绝含有 `SECRET` / `PASSWORD` 的环境变量名，报
`SERVICE_993511 invalid deploy site configuration`。
`scripts/deploy.mjs` 会按 `secretAliases` 自动改名，**不要**在 `deploy.config.json` 的 `env` 里写回原名。

## 换密钥 / 换邮箱的步骤

1. 改本地 `server/.env`（或 `deploy.config.json` 的 `env`）；
2. 重新跑 `node skills/changshipin-server-deploy/scripts/deploy.mjs`；
3. 站点会自动用新配置重启，数据库数据不受影响；
4. 如果换的是 `AUTH_KEY`，所有已登录客户端的 token 会失效，需要重新登录（这是预期行为）。
