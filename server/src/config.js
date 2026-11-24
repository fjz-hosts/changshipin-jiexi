import 'dotenv/config'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

export const config = {
  port: Number(process.env.PORT) || 8000,
  databaseUrl: String(process.env.DATABASE_URL || '').trim(),
  autoMigrate: bool(process.env.AUTO_MIGRATE, true),
  // 部署平台禁止环境变量名里出现 SECRET / PASSWORD，线上用 AUTH_KEY / ADMIN_PASS / MAIL_AUTH 传入
  jwtSecret: String(process.env.JWT_SECRET || process.env.AUTH_KEY || '').trim(),
  jwtDays: Number(process.env.JWT_DAYS) || 30,
  adminEmail: String(process.env.ADMIN_EMAIL || '').trim().toLowerCase(),
  adminPassword: String(process.env.ADMIN_PASSWORD || process.env.ADMIN_PASS || ''),
  codeTtlMinutes: Number(process.env.CODE_TTL_MINUTES) || 10,
  eventRetentionDays: Number(process.env.EVENT_RETENTION_DAYS) || 180,
  email: {
    host: String(process.env.EMAIL_HOST || 'smtp.qq.com').trim(),
    port: Number(process.env.EMAIL_PORT) || 465,
    secure: bool(process.env.EMAIL_USE_SSL, true),
    user: String(process.env.EMAIL_USER || '').trim(),
    pass: String(process.env.EMAIL_PASSWORD || process.env.MAIL_AUTH || '').trim(),
    from: String(process.env.EMAIL_DEFAULT_SENDER || process.env.EMAIL_USER || '').trim(),
  },
  rootDir: path.resolve(here, '..'),
  publicDir: path.resolve(here, '../public'),
}

export function assertRuntimeConfig() {
  const problems = []
  if (!config.databaseUrl) problems.push('缺少 DATABASE_URL（Supabase / Neon 连接串）')
  if (!config.jwtSecret) problems.push('缺少 JWT_SECRET（登录 token 签名密钥）')
  if (!config.email.user || !config.email.pass) problems.push('缺少 EMAIL_USER / EMAIL_PASSWORD（SMTP 账号与授权码）')
  return problems
}
