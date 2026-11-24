import express from 'express'
import { many, one, query } from '../db.js'
import { authRequired } from '../auth.js'

export const feedbackRouter = express.Router()

const TYPES = new Set(['bug', 'feature', 'experience', 'other'])

function fail(res, status, error) {
  return res.status(status).json({ ok: false, error })
}

feedbackRouter.post('/', authRequired, async (req, res, next) => {
  try {
    const type = TYPES.has(req.body?.type) ? req.body.type : 'other'
    const content = String(req.body?.content || '').trim()
    const contact = String(req.body?.contact || '').trim().slice(0, 120)
    const version = String(req.body?.version || '').slice(0, 32)
    const os = String(req.body?.os || '').slice(0, 64)
    const rating = Number(req.body?.rating) || 0
    const nps = Number(req.body?.nps) || 0
    if (content.length < 5) return fail(res, 400, '反馈内容至少 5 个字')
    if (content.length > 2000) return fail(res, 400, '反馈内容最多 2000 个字')
    const row = await one(
      `INSERT INTO feedback (user_id, email, type, rating, nps, content, contact, version, os)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, created_at`,
      [
        req.user.id,
        req.user.email,
        type,
        rating >= 1 && rating <= 5 ? rating : null,
        nps >= 1 && nps <= 10 ? nps : null,
        content,
        contact || null,
        version || null,
        os || null,
      ],
    )
    res.json({ ok: true, id: row.id, createdAt: row.created_at })
  } catch (error) {
    next(error)
  }
})

feedbackRouter.get('/mine', authRequired, async (req, res, next) => {
  try {
    const rows = await many(
      `SELECT f.id, f.type, f.rating, f.nps, f.content, f.contact, f.version, f.status,
              f.admin_reply, f.replied_at, f.created_at,
              COALESCE(json_agg(json_build_object(
                'id', r.id, 'author', r.author, 'content', r.content,
                'createdAt', r.created_at, 'seen', r.seen
              ) ORDER BY r.created_at) FILTER (WHERE r.id IS NOT NULL), '[]') AS replies
       FROM feedback f
       LEFT JOIN feedback_replies r ON r.feedback_id = f.id
       WHERE f.user_id = $1
       GROUP BY f.id
       ORDER BY f.created_at DESC
       LIMIT 50`,
      [req.user.id],
    )
    res.json({ ok: true, items: rows })
  } catch (error) {
    next(error)
  }
})

feedbackRouter.get('/unread', authRequired, async (req, res, next) => {
  try {
    const row = await one(
      `SELECT count(*)::int AS count FROM feedback_replies r
       JOIN feedback f ON f.id = r.feedback_id
       WHERE f.user_id = $1 AND r.author = 'admin' AND r.seen = false`,
      [req.user.id],
    )
    res.json({ ok: true, count: row?.count || 0 })
  } catch (error) {
    next(error)
  }
})

feedbackRouter.post('/seen', authRequired, async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id) => typeof id === 'string').slice(0, 50) : []
    if (!ids.length) return res.json({ ok: true })
    await query(
      `UPDATE feedback_replies r SET seen = true
       FROM feedback f
       WHERE r.feedback_id = f.id AND f.user_id = $1 AND r.feedback_id = ANY($2::uuid[])`,
      [req.user.id, ids],
    )
    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})
