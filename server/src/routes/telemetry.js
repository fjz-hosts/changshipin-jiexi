import express from 'express'
import { query } from '../db.js'
import { authOptional, normalizeIp, rateLimit } from '../auth.js'

export const telemetryRouter = express.Router()

const EVENTS = new Set([
  'launch',
  'parse',
  'short_resolve',
  'short_download',
  'music_search',
  'music_resolve',
  'music_download',
  'download',
  'cast',
  'error',
])

function trim(value, max) {
  return value === undefined || value === null ? null : String(value).slice(0, max)
}

function hostOf(url) {
  try {
    const host = new URL(String(url)).hostname.toLowerCase()
    return host.slice(0, 100)
  } catch {
    return null
  }
}

function sanitizeEvent(raw) {
  const event = String(raw?.event || '')
  if (!EVENTS.has(event)) return null
  return {
    event,
    platform: trim(raw.platform, 24),
    subPlatform: trim(raw.subPlatform, 24),
    lineKind: trim(raw.lineKind, 24),
    result: raw.result === 'ok' || raw.result === 'fail' ? raw.result : null,
    errorCode: trim(raw.errorCode, 80),
    durationMs: Number.isFinite(Number(raw.durationMs)) ? Math.max(0, Math.min(3_600_000, Math.round(Number(raw.durationMs)))) : null,
    title: trim(raw.title, 180),
    host: trim(raw.host, 100) || hostOf(raw.url),
    version: trim(raw.version, 32),
    os: trim(raw.os, 64),
  }
}

telemetryRouter.post('/events', authOptional, async (req, res, next) => {
  try {
    const installId = String(req.body?.installId || '').trim().slice(0, 64)
    if (!installId) return res.status(400).json({ ok: false, error: '缺少 installId' })
    if (!rateLimit(`telemetry:${normalizeIp(req)}`, 120, 60_000)) {
      return res.status(429).json({ ok: false, error: '上报过于频繁' })
    }
    const version = trim(req.body?.version, 32)
    const os = trim(req.body?.os, 64)
    const list = Array.isArray(req.body?.events) ? req.body.events.slice(0, 100) : []
    const events = list.map(sanitizeEvent).filter(Boolean)
    await query(
      `INSERT INTO devices (install_id, user_id, version, os, last_seen)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (install_id) DO UPDATE SET
         user_id = COALESCE(EXCLUDED.user_id, devices.user_id),
         version = COALESCE(EXCLUDED.version, devices.version),
         os = COALESCE(EXCLUDED.os, devices.os),
         last_seen = now()`,
      [installId, req.user?.id || null, version, os],
    )
    if (events.length) {
      const values = []
      const params = []
      events.forEach((item, index) => {
        const base = index * 12
        values.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12})`,
        )
        params.push(
          installId,
          req.user?.id || null,
          item.event,
          item.platform,
          item.subPlatform,
          item.lineKind,
          item.result,
          item.errorCode,
          item.durationMs,
          item.title,
          item.host,
          version || item.version,
        )
      })
      await query(
        `INSERT INTO usage_events
         (install_id, user_id, event, platform, sub_platform, line_kind, result, error_code, duration_ms, title, host, version)
         VALUES ${values.join(',')}`,
        params,
      )
    }
    res.json({ ok: true, accepted: events.length })
  } catch (error) {
    next(error)
  }
})

telemetryRouter.post('/heartbeat', authOptional, async (req, res, next) => {
  try {
    const installId = String(req.body?.installId || '').trim().slice(0, 64)
    if (!installId) return res.status(400).json({ ok: false, error: '缺少 installId' })
    const version = trim(req.body?.version, 32)
    const os = trim(req.body?.os, 64)
    await query(
      `INSERT INTO devices (install_id, user_id, version, os, last_seen)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (install_id) DO UPDATE SET
         user_id = COALESCE(EXCLUDED.user_id, devices.user_id),
         version = COALESCE(EXCLUDED.version, devices.version),
         os = COALESCE(EXCLUDED.os, devices.os),
         last_seen = now()`,
      [installId, req.user?.id || null, version, os],
    )
    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})
