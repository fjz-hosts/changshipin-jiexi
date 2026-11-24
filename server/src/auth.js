import crypto from 'node:crypto'
import jwt from 'jsonwebtoken'
import { config } from './config.js'
import { one } from './db.js'

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase()
}

export function isEmail(value) {
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(String(value || '').trim())
}

export function normalizeIp(req) {
  const raw = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim()
  return raw.replace(/^::ffff:/, '')
}

// 只落库脱敏后的 IP：IPv4 保留前两段，IPv6 保留前两组
export function maskIp(ip) {
  const value = String(ip || '')
  if (!value) return ''
  if (value.includes(':')) return value.split(':').slice(0, 2).join(':') + '::'
  const parts = value.split('.')
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.x.x`
  return value.slice(0, 12)
}

export function codeHash(email, purpose, code) {
  return crypto
    .createHash('sha256')
    .update(`${normalizeEmail(email)}|${purpose}|${code}|${config.jwtSecret || 'dev'}`)
    .digest('hex')
}

export function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
}

export function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, email: user.email }, config.jwtSecret || 'dev-secret', {
    expiresIn: `${config.jwtDays}d`,
  })
}

export function publicUser(row) {
  if (!row) return null
  return {
    id: row.id,
    email: row.email,
    username: row.username,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
  }
}

function readToken(req) {
  const header = String(req.headers.authorization || '')
  if (!header.toLowerCase().startsWith('bearer ')) return ''
  return header.slice(7).trim()
}

export async function authRequired(req, res, next) {
  const token = readToken(req)
  if (!token) return res.status(401).json({ ok: false, error: '请先登录' })
  let payload
  try {
    payload = jwt.verify(token, config.jwtSecret || 'dev-secret')
  } catch {
    return res.status(401).json({ ok: false, error: '登录已过期，请重新登录' })
  }
  const user = await one('SELECT * FROM users WHERE id = $1', [payload.sub])
  if (!user) return res.status(401).json({ ok: false, error: '账号不存在' })
  if (!user.status) return res.status(403).json({ ok: false, error: '账号已被禁用，请联系管理员' })
  req.user = user
  next()
}

export function adminRequired(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ ok: false, error: '需要管理员权限' })
  }
  next()
}

// 可选的登录态：带 token 就解析，不带也放行（埋点接口用）
export async function authOptional(req, _res, next) {
  const token = readToken(req)
  if (!token) return next()
  try {
    const payload = jwt.verify(token, config.jwtSecret || 'dev-secret')
    const user = await one('SELECT id, role, status FROM users WHERE id = $1', [payload.sub])
    if (user && user.status) req.user = user
  } catch {
    /* 忽略无效 token */
  }
  next()
}

const buckets = new Map()

// 简单的单实例限流：key 维度在窗口内最多 limit 次
export function rateLimit(key, limit, windowMs) {
  const now = Date.now()
  const list = (buckets.get(key) || []).filter((time) => now - time < windowMs)
  if (list.length >= limit) {
    buckets.set(key, list)
    return false
  }
  list.push(now)
  buckets.set(key, list)
  if (buckets.size > 5000) {
    for (const [k, times] of buckets) {
      if (!times.length || now - times[times.length - 1] > windowMs) buckets.delete(k)
    }
  }
  return true
}

export function clientMeta(req, body = {}) {
  return {
    ip: maskIp(normalizeIp(req)),
    ua: String(req.headers['user-agent'] || '').slice(0, 240),
    version: String(body.version || '').slice(0, 32),
  }
}
