'use strict'

// 账号 / 反馈 / 使用数据服务的地址。
// 部署完成后把 API_BASE 换成实际地址；调试时可以用 CHANGSPIN_API 覆盖。
const API_BASE = String(process.env.CHANGSPIN_API || 'https://37lmtdy5bz2ga6o5ozv.traesite.cn').replace(/\/+$/, '')

module.exports = { apiBase: API_BASE }
