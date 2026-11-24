import express from 'express'
import { many, one, query } from '../db.js'
import { adminRequired, authRequired } from '../auth.js'

export const adminRouter = express.Router()

adminRouter.use(authRequired, adminRequired)

function clampDays(value, fallback = 30) {
  const days = Number(value)
  if (!Number.isFinite(days)) return fallback
  return Math.min(365, Math.max(1, Math.round(days)))
}

adminRouter.get('/me', (req, res) => {
  res.json({ ok: true, user: { id: req.user.id, email: req.user.email, username: req.user.username, role: req.user.role } })
})

adminRouter.get('/overview', async (_req, res, next) => {
  try {
    const [online, dau, logins, newUsers, todayEvents, versions, feedbackToday, feedbackPending, totals] = await Promise.all([
      one("SELECT count(*)::int AS n FROM devices WHERE last_seen > now() - interval '5 minutes'"),
      one('SELECT count(DISTINCT install_id)::int AS n FROM usage_events WHERE created_at >= current_date'),
      one("SELECT count(*)::int AS n FROM user_login_logs WHERE success = true AND created_at >= current_date"),
      one('SELECT count(*)::int AS n FROM users WHERE created_at >= current_date'),
      many(
        `SELECT event, count(*)::int AS total, count(*) FILTER (WHERE result = 'ok')::int AS ok,
                avg(duration_ms)::int AS avg_ms
         FROM usage_events
         WHERE created_at >= current_date
         GROUP BY event`,
      ),
      many(
        `SELECT COALESCE(version, '未知') AS version, count(*)::int AS count
         FROM devices WHERE last_seen > now() - interval '7 days'
         GROUP BY 1 ORDER BY 2 DESC LIMIT 12`,
      ),
      one('SELECT count(*)::int AS n FROM feedback WHERE created_at >= current_date'),
      one('SELECT count(*)::int AS n FROM feedback WHERE status = 0'),
      Promise.all([
        one('SELECT count(*)::int AS n FROM users'),
        one('SELECT count(*)::int AS n FROM devices'),
        one('SELECT count(*)::int AS n FROM usage_events'),
      ]),
    ])

    const eventMap = Object.fromEntries(todayEvents.map((row) => [row.event, row]))
    const parses = eventMap.parse?.total || 0
    const parseOk = eventMap.parse?.ok || 0
    const downloads =
      (eventMap.download?.total || 0) + (eventMap.short_download?.total || 0) + (eventMap.music_download?.total || 0)
    res.json({
      ok: true,
      data: {
        online: online.n,
        dau: dau.n,
        logins: logins.n,
        newUsers: newUsers.n,
        parses,
        parseOk,
        parseRate: parses ? Number(((parseOk / parses) * 100).toFixed(1)) : null,
        avgMs: eventMap.parse?.avg_ms || null,
        shortParses: eventMap.short_resolve?.total || 0,
        musicSearches: eventMap.music_search?.total || 0,
        downloads,
        errors: eventMap.error?.total || 0,
        versions,
        feedbackToday: feedbackToday.n,
        feedbackPending: feedbackPending.n,
        totalUsers: totals[0].n,
        totalDevices: totals[1].n,
        totalEvents: totals[2].n,
        today: {
          parse: eventMap.parse?.total || 0,
          short: eventMap.short_resolve?.total || 0,
          music: eventMap.music_resolve?.total || 0,
          download: downloads,
          error: eventMap.error?.total || 0,
        },
      },
    })
  } catch (error) {
    next(error)
  }
})

adminRouter.get('/trend', async (req, res, next) => {
  try {
    const days = clampDays(req.query.days)
    const [rows, registrations] = await Promise.all([
      many(
        `WITH d AS (
           SELECT generate_series(current_date - ($1::int - 1), current_date, interval '1 day')::date AS day
         )
         SELECT d.day::text AS day,
                COALESCE(e.dau, 0)::int AS dau,
                COALESCE(e.logins, 0)::int AS logins,
                COALESCE(e.parses, 0)::int AS parses,
                COALESCE(e.parse_ok, 0)::int AS parse_ok,
                COALESCE(e.downloads, 0)::int AS downloads,
                COALESCE(e.errors, 0)::int AS errors,
                COALESCE(e.avg_ms, 0)::int AS avg_ms
         FROM d
         LEFT JOIN (
           SELECT created_at::date AS day,
                  count(DISTINCT install_id)::int AS dau,
                  count(*) FILTER (WHERE event = 'launch')::int AS logins,
                  count(*) FILTER (WHERE event = 'parse')::int AS parses,
                  count(*) FILTER (WHERE event = 'parse' AND result = 'ok')::int AS parse_ok,
                  count(*) FILTER (WHERE event IN ('download', 'short_download', 'music_download'))::int AS downloads,
                  count(*) FILTER (WHERE event = 'error')::int AS errors,
                  avg(duration_ms)::int AS avg_ms
           FROM usage_events
           WHERE created_at >= current_date - ($1::int - 1)
           GROUP BY 1
         ) e ON e.day = d.day
         ORDER BY d.day`,
        [days],
      ),
      many(
        `SELECT created_at::date::text AS day, count(*)::int AS count
         FROM users
         WHERE created_at >= current_date - ($1::int - 1)
         GROUP BY 1`,
        [days],
      ),
    ])
    const signupMap = Object.fromEntries(registrations.map((row) => [row.day, row.count]))
    res.json({
      ok: true,
      data: rows.map((row) => ({ ...row, signups: signupMap[row.day] || 0 })),
    })
  } catch (error) {
    next(error)
  }
})

adminRouter.get('/platforms', async (req, res, next) => {
  try {
    const days = clampDays(req.query.days)
    const rows = await many(
      `SELECT event, COALESCE(platform, '') AS platform, COALESCE(sub_platform, '') AS sub_platform,
              count(*)::int AS total, count(*) FILTER (WHERE result = 'ok')::int AS ok,
              avg(duration_ms)::int AS avg_ms
       FROM usage_events
       WHERE created_at >= now() - ($1::int * interval '1 day')
       GROUP BY 1, 2, 3
       ORDER BY total DESC
       LIMIT 300`,
      [days],
    )
    res.json({ ok: true, data: rows })
  } catch (error) {
    next(error)
  }
})

adminRouter.get('/quality', async (req, res, next) => {
  try {
    const days = clampDays(req.query.days)
    const [lines, errors] = await Promise.all([
      many(
        `SELECT COALESCE(line_kind, '未知') AS line_kind,
                count(*)::int AS total,
                count(*) FILTER (WHERE result = 'ok')::int AS ok,
                count(*) FILTER (WHERE result = 'fail')::int AS fail,
                avg(duration_ms)::int AS avg_ms
         FROM usage_events
         WHERE event IN ('parse', 'short_resolve', 'music_resolve')
           AND created_at >= now() - ($1::int * interval '1 day')
         GROUP BY 1 ORDER BY total DESC`,
        [days],
      ),
      many(
        `SELECT COALESCE(error_code, '未知') AS error_code, COALESCE(platform, '') AS platform,
                COALESCE(event, '') AS event, count(*)::int AS count
         FROM usage_events
         WHERE event = 'error' AND created_at >= now() - ($1::int * interval '1 day')
         GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 20`,
        [days],
      ),
    ])
    res.json({ ok: true, data: { lines, errors } })
  } catch (error) {
    next(error)
  }
})

adminRouter.get('/content', async (req, res, next) => {
  try {
    const days = clampDays(req.query.days)
    const [hosts, titles, keywords] = await Promise.all([
      many(
        `SELECT host, count(*)::int AS count
         FROM usage_events
         WHERE host IS NOT NULL AND host <> '' AND created_at >= now() - ($1::int * interval '1 day')
         GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
        [days],
      ),
      many(
        `SELECT title, COALESCE(platform, '') AS platform, count(*)::int AS count
         FROM usage_events
         WHERE title IS NOT NULL AND title <> '' AND event IN ('parse', 'short_resolve', 'music_resolve')
           AND created_at >= now() - ($1::int * interval '1 day')
         GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 30`,
        [days],
      ),
      many(
        `SELECT title AS keyword, count(*)::int AS count
         FROM usage_events
         WHERE event = 'music_search' AND title IS NOT NULL AND title <> ''
           AND created_at >= now() - ($1::int * interval '1 day')
         GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
        [days],
      ),
    ])
    res.json({ ok: true, data: { hosts, titles, keywords } })
  } catch (error) {
    next(error)
  }
})

adminRouter.get('/users', async (req, res, next) => {
  try {
    const days = clampDays(req.query.days)
    const [funnel, retention, registrations, activity, topUsers] = await Promise.all([
      one(
        `SELECT
           (SELECT count(*)::int FROM email_codes WHERE purpose = 'register' AND created_at >= now() - ($1::int * interval '1 day')) AS codes,
           (SELECT count(*)::int FROM users WHERE created_at >= now() - ($1::int * interval '1 day')) AS registered,
           (SELECT count(DISTINCT user_id)::int FROM user_login_logs WHERE success = true AND created_at >= now() - ($1::int * interval '1 day')) AS logged,
           (SELECT count(DISTINCT user_id)::int FROM feedback WHERE created_at >= now() - ($1::int * interval '1 day')) AS feedback_users`,
        [days],
      ),
      one(
        `SELECT count(*)::int AS cohort,
                count(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM user_login_logs l
                  WHERE l.user_id = u.id AND l.success = true
                    AND l.created_at >= u.created_at + interval '1 day'
                    AND l.created_at < u.created_at + interval '2 day'
                ))::int AS d1,
                count(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM user_login_logs l
                  WHERE l.user_id = u.id AND l.success = true
                    AND l.created_at >= u.created_at + interval '7 day'
                    AND l.created_at < u.created_at + interval '8 day'
                ))::int AS d7
         FROM users u
         WHERE u.created_at >= now() - interval '14 day' AND u.created_at < now() - interval '1 day'`,
      ),
      many(
        `SELECT created_at::date::text AS day, count(*)::int AS count
         FROM users WHERE created_at >= now() - ($1::int * interval '1 day')
         GROUP BY 1 ORDER BY 1`,
        [days],
      ),
      many(
        `SELECT bucket, count(*)::int AS users FROM (
           SELECT user_id,
             CASE WHEN count(DISTINCT created_at::date) = 1 THEN '1 天'
                  WHEN count(DISTINCT created_at::date) <= 3 THEN '2–3 天'
                  WHEN count(DISTINCT created_at::date) <= 7 THEN '4–7 天'
                  ELSE '8 天以上' END AS bucket
           FROM usage_events
           WHERE user_id IS NOT NULL AND created_at >= now() - interval '30 day'
           GROUP BY user_id
         ) t GROUP BY bucket`,
      ),
      many(
        `SELECT u.email, u.username, count(e.id)::int AS events
         FROM usage_events e JOIN users u ON u.id = e.user_id
         WHERE e.created_at >= now() - ($1::int * interval '1 day')
         GROUP BY u.id, u.email, u.username
         ORDER BY events DESC LIMIT 10`,
        [days],
      ),
    ])
    res.json({
      ok: true,
      data: { funnel, retention, registrations, activity, topUsers },
    })
  } catch (error) {
    next(error)
  }
})

adminRouter.get('/feedback/stats', async (req, res, next) => {
  try {
    const days = clampDays(req.query.days)
    const [summary, daily, types] = await Promise.all([
      one(
        `SELECT count(*)::int AS total,
                count(*) FILTER (WHERE status = 0)::int AS pending,
                count(*) FILTER (WHERE status = 1)::int AS processing,
                count(*) FILTER (WHERE status = 2)::int AS replied,
                count(*) FILTER (WHERE status = 3)::int AS closed,
                avg(rating)::numeric(3, 1) AS avg_rating,
                avg(nps)::numeric(4, 1) AS avg_nps
         FROM feedback WHERE created_at >= now() - ($1::int * interval '1 day')`,
        [days],
      ),
      many(
        `SELECT created_at::date::text AS day, count(*)::int AS count
         FROM feedback WHERE created_at >= now() - ($1::int * interval '1 day')
         GROUP BY 1 ORDER BY 1`,
        [days],
      ),
      many(
        `SELECT type, count(*)::int AS count
         FROM feedback WHERE created_at >= now() - ($1::int * interval '1 day')
         GROUP BY 1 ORDER BY 2 DESC`,
        [days],
      ),
    ])
    res.json({ ok: true, data: { summary, daily, types } })
  } catch (error) {
    next(error)
  }
})

adminRouter.get('/feedback', async (req, res, next) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1)
    const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 20))
    const status = req.query.status === undefined || req.query.status === '' ? null : Number(req.query.status)
    const keyword = String(req.query.q || '').trim().slice(0, 60)
    const where = `($1::int IS NULL OR f.status = $1::int)
      AND ($2::text = '' OR f.content ILIKE '%' || $2::text || '%' OR COALESCE(f.email, '') ILIKE '%' || $2::text || '%')`
    const [rows, total] = await Promise.all([
      many(
        `SELECT f.id, f.email, f.type, f.rating, f.nps, f.content, f.contact, f.version, f.os,
                f.status, f.admin_reply, f.replied_at, f.created_at, u.username,
                (SELECT count(*)::int FROM feedback_replies r WHERE r.feedback_id = f.id) AS replies
         FROM feedback f LEFT JOIN users u ON u.id = f.user_id
         WHERE ${where}
         ORDER BY f.created_at DESC
         LIMIT $3 OFFSET $4`,
        [status, keyword, pageSize, (page - 1) * pageSize],
      ),
      one(`SELECT count(*)::int AS total FROM feedback f WHERE ${where}`, [status, keyword]),
    ])
    res.json({ ok: true, data: { items: rows, total: total.total, page, pageSize } })
  } catch (error) {
    next(error)
  }
})

adminRouter.get('/feedback/:id', async (req, res, next) => {
  try {
    const feedback = await one(
      `SELECT f.*, u.username FROM feedback f LEFT JOIN users u ON u.id = f.user_id WHERE f.id = $1`,
      [req.params.id],
    )
    if (!feedback) return res.status(404).json({ ok: false, error: '反馈不存在' })
    const replies = await many(
      `SELECT id, author, content, seen, created_at FROM feedback_replies WHERE feedback_id = $1 ORDER BY created_at`,
      [req.params.id],
    )
    res.json({ ok: true, data: { ...feedback, replies } })
  } catch (error) {
    next(error)
  }
})

adminRouter.post('/feedback/:id/reply', async (req, res, next) => {
  try {
    const content = String(req.body?.content || '').trim()
    if (!content) return res.status(400).json({ ok: false, error: '回复内容不能为空' })
    if (content.length > 2000) return res.status(400).json({ ok: false, error: '回复最多 2000 字' })
    const feedback = await one('SELECT id FROM feedback WHERE id = $1', [req.params.id])
    if (!feedback) return res.status(404).json({ ok: false, error: '反馈不存在' })
    await query(
      `INSERT INTO feedback_replies (feedback_id, author, content) VALUES ($1, 'admin', $2)`,
      [req.params.id, content],
    )
    await query(
      `UPDATE feedback SET status = 2, admin_reply = $2, replied_at = now() WHERE id = $1`,
      [req.params.id, content],
    )
    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

adminRouter.post('/feedback/:id/status', async (req, res, next) => {
  try {
    const status = Number(req.body?.status)
    if (![0, 1, 2, 3].includes(status)) return res.status(400).json({ ok: false, error: '状态值不正确' })
    const result = await query('UPDATE feedback SET status = $2 WHERE id = $1', [req.params.id, status])
    if (!result.rowCount) return res.status(404).json({ ok: false, error: '反馈不存在' })
    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})
