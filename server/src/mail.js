import nodemailer from 'nodemailer'
import { config } from './config.js'

let transporter = null

function getTransport() {
  if (transporter) return transporter
  transporter = nodemailer.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: config.email.secure,
    auth: {
      user: config.email.user,
      pass: config.email.pass,
    },
    pool: true,
    maxConnections: 1,
  })
  return transporter
}

const PURPOSE_TEXT = {
  register: '注册',
  login: '登录',
  reset: '重置密码',
}

export function mailReady() {
  return Boolean(config.email.user && config.email.pass)
}

export async function sendCodeMail(to, code, purpose) {
  if (!mailReady()) throw new Error('服务端未配置发信邮箱')
  const label = PURPOSE_TEXT[purpose] || '验证'
  const html = `
  <div style="max-width:520px;margin:0 auto;padding:28px 24px;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;background:#0f1420;border-radius:14px;color:#e6ecf7">
    <h2 style="margin:0 0 8px;font-size:18px;color:#ffffff">音视频解析 · ${label}验证码</h2>
    <p style="margin:0 0 18px;font-size:13px;color:#9aa7bd">你正在${label}「音视频解析」账号，验证码 10 分钟内有效。</p>
    <div style="font-size:32px;letter-spacing:10px;font-weight:700;color:#4cc2ff;background:#151c2c;border-radius:10px;padding:14px 0;text-align:center">${code}</div>
    <p style="margin:18px 0 0;font-size:12px;color:#7f8ba3">只允许本人操作，请勿把验证码告诉别人。如果不是你发的请求，忽略这封邮件即可。</p>
    <p style="margin:8px 0 0;font-size:12px;color:#5f6b80">此邮件由系统自动发送，请勿回复。</p>
  </div>`
  await getTransport().sendMail({
    from: `"音视频解析" <${config.email.from || config.email.user}>`,
    to,
    subject: `【音视频解析】${label}验证码 ${code}`,
    html,
  })
}
