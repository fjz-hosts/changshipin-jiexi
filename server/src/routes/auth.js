import express from 'express'
import bcrypt from 'bcryptjs'
import { config } from '../config.js'
import { one, query } from '../db.js'
import { sendCodeMail } from '../mail.js'
import {
  authRequired,
  clientMeta,
  codeHash,
  generateCode,
  isEmail,
  normalizeEmail,
  normalizeIp,
  publicUser,
  rateLimit,
  signToken,
} from '../auth.js'

export const authRouter = express.Router()

const CODE_TTL_MINUTES = config.codeTtlMinutes

function fail(res, status, error) {
  return res.status(status).json({ ok: false, error })
}

async function issueCode({ email, purpose, req }) {
  const ip = normalizeIp(req)
  if (!rateLimit(`code:email:${email}`, 1, 60_000)) {
    return { error: '验证码发送太频繁，请 60 秒后再试' }
  }
  if (!rateLimit(`code:ip:${ip}`, 10, 60_000)) {
    return { error: '请求过于频繁，请稍后再试' }
  }
  const code = generateCode()
  const expires = new Date(Date.now() + CODE_TTL_MINUTES * 60_000)
  await query('UPDATE email_codes SET used = true WHERE email = $1 AND purpose = $2 AND used = false', [email, purpose])
  await query(
    `INSERT INTO email_codes (email, purpose, code_hash, ip, expires_at) VALUES ($1, $2, $3, $4, $5)`,
    [email, purpose, codeHash(email, purpose, code), ip, expires],
  )
  await sendCodeMail(email, code, purpose)
  return { ok: true, ttlMinutes: CODE_TTL_MINUTES }
}

async function verifyCode({ email, purpose, code }) {
  const row = await one(
    `SELECT * FROM email_codes
     WHERE email = $1 AND purpose = $2 AND used = false AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1`,
    [email, purpose],
  )
  if (!row) return { error: '验证码已失效，请重新获取' }
  if (row.attempts >= 5) {
    await query('UPDATE email_codes SET used = true WHERE id = $1', [row.id])
    return { error: '验证码错误次数过多，请重新获取' }
  }
  if (row.code_hash !== codeHash(email, purpose, code)) {
    await query('UPDATE email_codes SET attempts = attempts + 1 WHERE id = $1', [row.id])
    return { error: '验证码不正确' }
  }
  await query('UPDATE email_codes SET used = true WHERE id = $1', [row.id])
  return { ok: true }
}

async function finishLogin(req, res, user, body, account) {
  const meta = clientMeta(req, body)
  await query('UPDATE users SET last_login_at = now(), last_ip = $2 WHERE id = $1', [user.id, meta.ip])
  await query(
    `INSERT INTO user_login_logs (user_id, account, ip, ua, version, success) VALUES ($1, $2, $3, $4, $5, true)`,
    [user.id, account.slice(0, 64), meta.ip, meta.ua, meta.version],
  )
  return res.json({ ok: true, token: signToken(user), user: publicUser({ ...user, last_login_at: new Date() }) })
}

async function logFailure(req, account, reason, userId = null) {
  const meta = clientMeta(req)
  await query(
    `INSERT INTO user_login_logs (user_id, account, ip, ua, version, success, fail_reason)
     VALUES ($1, $2, $3, $4, $5, false, $6)`,
    [userId, String(account || '').slice(0, 64), meta.ip, meta.ua, meta.version, reason],
  )
}

// 注册第一步：给未注册邮箱发验证码
authRouter.post('/register/send-code', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email)
    if (!isEmail(email)) return fail(res, 400, '请输入有效的邮箱地址')
    if (!rateLimit(`reg-ip:${normalizeIp(req)}`, 10, 3_600_000)) return fail(res, 429, '注册请求过多，请稍后再试')
    const exists = await one('SELECT id FROM users WHERE email = $1', [email])
    if (exists) return fail(res, 409, '该邮箱已注册，请直接登录')
    const result = await issueCode({ email, purpose: 'register', req })
    if (result.error) return fail(res, 429, result.error)
    res.json({ ok: true, ttlMinutes: result.ttlMinutes })
  } catch (error) {
    next(error)
  }
})

// 注册第二步：校验验证码并建号（直接返回登录 token）
authRouter.post('/register', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email)
    const code = String(req.body?.code || '').trim()
    const username = String(req.body?.username || '').trim()
    const password = String(req.body?.password || '')
    if (!isEmail(email)) return fail(res, 400, '请输入有效的邮箱地址')
    if (!/^[\w\u4e00-\u9fa5.-]{2,20}$/.test(username)) return fail(res, 400, '用户名 2–20 位，可用中文、字母、数字')
    if (password.length < 6 || password.length > 64) return fail(res, 400, '密码长度需要 6–64 位')
    const verified = await verifyCode({ email, purpose: 'register', code })
    if (verified.error) return fail(res, 400, verified.error)
    const hash = await bcrypt.hash(password, 10)
    const meta = clientMeta(req, req.body)
    const inserted = await one(
      `INSERT INTO users (email, username, password_hash, register_version, register_os, last_ip)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [email, username, hash, meta.version, String(req.body?.os || '').slice(0, 64), meta.ip],
    )
    await finishLogin(req, res, inserted, req.body, email)
  } catch (error) {
    if (error?.code === '23505') {
      const field = /email/.test(error.detail || '') ? '邮箱' : '用户名'
      return fail(res, 409, `${field}已被占用，请换一个`)
    }
    next(error)
  }
})

// 密码登录：account 可以是邮箱或用户名
authRouter.post('/login', async (req, res, next) => {
  try {
    const account = String(req.body?.account || '').trim()
    const password = String(req.body?.password || '')
    if (!account || !password) return fail(res, 400, '请输入账号和密码')
    if (!rateLimit(`login:${normalizeIp(req)}`, 20, 600_000)) return fail(res, 429, '尝试次数过多，请 10 分钟后再试')
    const user = await one('SELECT * FROM users WHERE email = $1 OR username = $1', [normalizeEmail(account)])
    if (!user) {
      await logFailure(req, account, '账号不存在')
      return fail(res, 401, '账号或密码错误')
    }
    if (!(await bcrypt.compare(password, user.password_hash))) {
      await logFailure(req, account, '密码错误', user.id)
      return fail(res, 401, '账号或密码错误')
    }
    if (!user.status) {
      await logFailure(req, account, '账号已禁用', user.id)
      return fail(res, 403, '账号已被禁用，请联系管理员')
    }
    await finishLogin(req, res, user, req.body, account)
  } catch (error) {
    next(error)
  }
})

// 验证码登录第一步
authRouter.post('/login/send-code', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email)
    if (!isEmail(email)) return fail(res, 400, '请输入有效的邮箱地址')
    const user = await one('SELECT id, status FROM users WHERE email = $1', [email])
    if (!user) return fail(res, 404, '该邮箱尚未注册')
    if (!user.status) return fail(res, 403, '账号已被禁用，请联系管理员')
    const result = await issueCode({ email, purpose: 'login', req })
    if (result.error) return fail(res, 429, result.error)
    res.json({ ok: true, ttlMinutes: result.ttlMinutes })
  } catch (error) {
    next(error)
  }
})

// 验证码登录第二步
authRouter.post('/login/code', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email)
    const code = String(req.body?.code || '').trim()
    if (!isEmail(email) || !code) return fail(res, 400, '请输入邮箱和验证码')
    if (!rateLimit(`login-code:${normalizeIp(req)}`, 20, 600_000)) return fail(res, 429, '尝试次数过多，请稍后再试')
    const user = await one('SELECT * FROM users WHERE email = $1', [email])
    if (!user) return fail(res, 404, '该邮箱尚未注册')
    const verified = await verifyCode({ email, purpose: 'login', code })
    if (verified.error) return fail(res, 400, verified.error)
    if (!user.status) return fail(res, 403, '账号已被禁用，请联系管理员')
    await finishLogin(req, res, user, req.body, email)
  } catch (error) {
    next(error)
  }
})

// 找回密码第一步
authRouter.post('/password/send-code', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email)
    if (!isEmail(email)) return fail(res, 400, '请输入有效的邮箱地址')
    const user = await one('SELECT id FROM users WHERE email = $1', [email])
    if (!user) return fail(res, 404, '该邮箱尚未注册')
    const result = await issueCode({ email, purpose: 'reset', req })
    if (result.error) return fail(res, 429, result.error)
    res.json({ ok: true, ttlMinutes: result.ttlMinutes })
  } catch (error) {
    next(error)
  }
})

// 找回密码第二步
authRouter.post('/password/reset', async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email)
    const code = String(req.body?.code || '').trim()
    const password = String(req.body?.password || '')
    if (!isEmail(email)) return fail(res, 400, '请输入有效的邮箱地址')
    if (password.length < 6 || password.length > 64) return fail(res, 400, '密码长度需要 6–64 位')
    const verified = await verifyCode({ email, purpose: 'reset', code })
    if (verified.error) return fail(res, 400, verified.error)
    const user = await one('SELECT id FROM users WHERE email = $1', [email])
    if (!user) return fail(res, 404, '该邮箱尚未注册')
    const hash = await bcrypt.hash(password, 10)
    await query('UPDATE users SET password_hash = $2 WHERE id = $1', [user.id, hash])
    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

authRouter.get('/me', authRequired, async (req, res, next) => {
  try {
    const unread = await one(
      `SELECT count(*)::int AS count FROM feedback_replies r
       JOIN feedback f ON f.id = r.feedback_id
       WHERE f.user_id = $1 AND r.author = 'admin' AND r.seen = false`,
      [req.user.id],
    )
    res.json({ ok: true, user: publicUser(req.user), unread: unread?.count || 0, serverTime: new Date().toISOString() })
  } catch (error) {
    next(error)
  }
})

authRouter.post('/password/change', authRequired, async (req, res, next) => {
  try {
    const oldPassword = String(req.body?.oldPassword || '')
    const newPassword = String(req.body?.newPassword || '')
    if (newPassword.length < 6 || newPassword.length > 64) return fail(res, 400, '新密码长度需要 6–64 位')
    if (!(await bcrypt.compare(oldPassword, req.user.password_hash))) return fail(res, 400, '原密码不正确')
    const hash = await bcrypt.hash(newPassword, 10)
    await query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.id, hash])
    res.json({ ok: true })
  } catch (error) {
    next(error)
  }
})

authRouter.post('/logout', (_req, res) => {
  res.json({ ok: true })
})
