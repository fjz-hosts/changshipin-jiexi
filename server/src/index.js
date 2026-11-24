import express from 'express'
import path from 'node:path'
import { config, assertRuntimeConfig } from './config.js'
import { closePool, initSchema, one, query } from './db.js'
import { authRouter } from './routes/auth.js'
import { feedbackRouter } from './routes/feedback.js'
import { telemetryRouter } from './routes/telemetry.js'
import { adminRouter } from './routes/admin.js'

const app = express()

app.set('trust proxy', 1)
app.disable('x-powered-by')
app.use(express.json({ limit: '256kb' }))

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'same-origin')
  if (req.path.startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    if (req.method === 'OPTIONS') return res.sendStatus(204)
  }
  next()
})

app.get('/', (_req, res) => res.redirect('/admin/'))
app.get('/api/health', async (_req, res) => {
  try {
    await one('SELECT 1 AS ok')
    res.json({ ok: true, time: new Date().toISOString(), version: '1.0.0' })
  } catch (error) {
    res.status(500).json({ ok: false, error: '数据库连接失败', detail: String(error?.message || error).slice(0, 160) })
  }
})

app.use('/api/auth', authRouter)
app.use('/api/feedback', feedbackRouter)
app.use('/api/telemetry', telemetryRouter)
app.use('/api/admin', adminRouter)

// 后台页面会被桌面端的 webview 内嵌，改版后不能让客户端继续用缓存的旧页面：
// HTML / CSS / JS 一律 no-store，只有图标这类静态资源允许短缓存。
app.use(
  '/admin',
  express.static(path.join(config.publicDir, 'admin'), {
    index: 'index.html',
    etag: true,
    setHeaders: (res, filePath) => {
      if (/\.(?:html|css|js)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-store, must-revalidate')
      } else {
        res.setHeader('Cache-Control', 'public, max-age=3600')
      }
    },
  }),
)

app.use('/api', (_req, res) => res.status(404).json({ ok: false, error: '接口不存在' }))

app.use((error, req, res, _next) => {
  console.error(`[server] ${req.method} ${req.path} 出错：`, error?.message || error)
  if (res.headersSent) return
  res.status(500).json({ ok: false, error: '服务器开小差了，请稍后再试' })
})

async function rollup() {
  try {
    await query(
      `INSERT INTO daily_stats (day, metric, dim, value)
       SELECT created_at::date, 'event', event, count(*)
       FROM usage_events
       WHERE created_at >= current_date - interval '2 day'
       GROUP BY 1, 2, 3
       ON CONFLICT (day, metric, dim) DO UPDATE SET value = EXCLUDED.value`,
    )
    await query(
      `INSERT INTO daily_stats (day, metric, dim, value)
       SELECT created_at::date, 'platform', COALESCE(platform, '未知'), count(*)
       FROM usage_events
       WHERE created_at >= current_date - interval '2 day'
       GROUP BY 1, 2, 3
       ON CONFLICT (day, metric, dim) DO UPDATE SET value = EXCLUDED.value`,
    )
    await query(
      `INSERT INTO daily_stats (day, metric, dim, value)
       SELECT created_at::date, 'active_device', '', count(DISTINCT install_id)
       FROM usage_events
       WHERE created_at >= current_date - interval '2 day'
       GROUP BY 1, 2, 3
       ON CONFLICT (day, metric, dim) DO UPDATE SET value = EXCLUDED.value`,
    )
    await query(
      `DELETE FROM usage_events WHERE created_at < now() - ($1::text || ' days')::interval`,
      [String(config.eventRetentionDays)],
    )
    await query('DELETE FROM email_codes WHERE created_at < now() - interval \'7 day\'')
  } catch (error) {
    console.error('[server] 汇总任务失败：', error?.message || error)
  }
}

const problems = assertRuntimeConfig()
if (problems.length) {
  console.error('[server] 启动失败，配置不完整：')
  for (const item of problems) console.error(`  - ${item}`)
  process.exit(1)
}

const server = app.listen(config.port, '0.0.0.0', async () => {
  console.log(`[server] 已启动：http://0.0.0.0:${config.port}`)
  try {
    if (config.autoMigrate) {
      await initSchema()
      console.log('[server] 数据表已就绪')
    }
    rollup().catch(() => {})
    setInterval(rollup, 60 * 60 * 1000).unref()
  } catch (error) {
    console.error('[server] 初始化数据库失败：', error?.message || error)
    process.exit(1)
  }
})

server.keepAliveTimeout = 65_000
server.headersTimeout = 70_000

async function shutdown(signal) {
  console.log(`[server] 收到 ${signal}，正在退出…`)
  server.close(async () => {
    await closePool().catch(() => {})
    process.exit(0)
  })
  setTimeout(() => process.exit(1), 8_000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('unhandledRejection', (reason) => {
  console.error('[server] 未处理的 Promise 异常：', reason)
})
