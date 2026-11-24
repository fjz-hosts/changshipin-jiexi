import pg from 'pg'
import bcrypt from 'bcryptjs'
import { config } from './config.js'

const { Pool } = pg

let pool = null

export function getPool() {
  if (pool) return pool
  const needsSsl = /sslmode=require|supabase|neon\.tech/i.test(config.databaseUrl)
  pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
    max: Number(process.env.PG_POOL_MAX) || 5,
    idleTimeoutMillis: 30_000,
    // Supabase 免费实例偶尔会冷启动，10 秒容易直接超时，放宽到 20 秒
    connectionTimeoutMillis: 20_000,
    keepAlive: true,
  })
  pool.on('error', (error) => {
    console.error('[db] 空闲连接异常', error?.message || error)
  })
  return pool
}

export async function query(text, params = []) {
  const started = Date.now()
  const result = await getPool().query(text, params)
  const cost = Date.now() - started
  if (cost > 1500) console.warn(`[db] 慢查询 ${cost}ms: ${text.slice(0, 120)}`)
  return result
}

export async function one(text, params = []) {
  const result = await query(text, params)
  return result.rows[0] || null
}

export async function many(text, params = []) {
  const result = await query(text, params)
  return result.rows
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  username text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'user',
  status boolean NOT NULL DEFAULT true,
  register_version text,
  register_os text,
  last_ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE IF NOT EXISTS email_codes (
  id bigserial PRIMARY KEY,
  email text NOT NULL,
  purpose text NOT NULL,
  code_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  used boolean NOT NULL DEFAULT false,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_codes_lookup ON email_codes (email, purpose, created_at DESC);

CREATE TABLE IF NOT EXISTS user_login_logs (
  id bigserial PRIMARY KEY,
  user_id uuid,
  account text,
  ip text,
  ua text,
  version text,
  success boolean NOT NULL,
  fail_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_login_logs_user ON user_login_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_login_logs_time ON user_login_logs (created_at DESC);

CREATE TABLE IF NOT EXISTS devices (
  install_id text PRIMARY KEY,
  user_id uuid,
  version text,
  os text,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_devices_seen ON devices (last_seen DESC);

CREATE TABLE IF NOT EXISTS usage_events (
  id bigserial PRIMARY KEY,
  install_id text,
  user_id uuid,
  event text NOT NULL,
  platform text,
  sub_platform text,
  line_kind text,
  result text,
  error_code text,
  duration_ms integer,
  title text,
  host text,
  version text,
  os text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_time ON usage_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_event ON usage_events (event, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_platform ON usage_events (platform, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_install ON usage_events (install_id, created_at DESC);

CREATE TABLE IF NOT EXISTS daily_stats (
  day date NOT NULL,
  metric text NOT NULL,
  dim text NOT NULL DEFAULT '',
  value bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric, dim)
);

CREATE TABLE IF NOT EXISTS feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  email text,
  type text NOT NULL DEFAULT 'other',
  rating integer,
  nps integer,
  content text NOT NULL,
  contact text,
  version text,
  os text,
  status integer NOT NULL DEFAULT 0,
  admin_reply text,
  replied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_user ON feedback (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS feedback_replies (
  id bigserial PRIMARY KEY,
  feedback_id uuid NOT NULL,
  author text NOT NULL,
  content text NOT NULL,
  seen boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feedback_replies ON feedback_replies (feedback_id, created_at);
`

export async function initSchema() {
  await query(SCHEMA)
  await seedAdmin()
}

async function seedAdmin() {
  if (!config.adminEmail || !config.adminPassword) return
  const existing = await one('SELECT id, role FROM users WHERE email = $1', [config.adminEmail])
  if (!existing) {
    const hash = await bcrypt.hash(config.adminPassword, 10)
    const username = config.adminEmail.split('@')[0] || 'admin'
    try {
      await query(
        `INSERT INTO users (email, username, password_hash, role, register_version, register_os)
         VALUES ($1, $2, $3, 'admin', 'server-seed', 'server')`,
        [config.adminEmail, username, hash],
      )
      console.log(`[db] 已创建管理员账号 ${config.adminEmail}`)
    } catch (error) {
      // 用户名被占用时退化成带后缀的管理员名
      if (error?.code === '23505') {
        await query(
          `INSERT INTO users (email, username, password_hash, role, register_version, register_os)
           VALUES ($1, $2, $3, 'admin', 'server-seed', 'server')`,
          [config.adminEmail, `${username}_admin`, hash],
        )
        console.log(`[db] 已创建管理员账号 ${config.adminEmail}（用户名 ${username}_admin）`)
      } else {
        throw error
      }
    }
    return
  }
  if (existing.role !== 'admin') {
    await query("UPDATE users SET role = 'admin' WHERE id = $1", [existing.id])
    console.log(`[db] 已把 ${config.adminEmail} 升级为管理员`)
  }
}

export async function closePool() {
  if (pool) {
    await pool.end()
    pool = null
  }
}
