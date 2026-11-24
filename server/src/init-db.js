import { assertRuntimeConfig, config } from './config.js'
import { closePool, initSchema } from './db.js'

// 本地执行一次建表 + 管理员初始化：
//   set DATABASE_URL=... && set JWT_SECRET=... && node src/init-db.js
const problems = assertRuntimeConfig()
if (problems.length) {
  console.error('配置不完整：')
  for (const item of problems) console.error(`  - ${item}`)
  process.exit(1)
}

try {
  await initSchema()
  console.log(`数据库已就绪（管理员：${config.adminEmail || '未配置'}）`)
} catch (error) {
  console.error('初始化失败：', error?.message || error)
  process.exitCode = 1
} finally {
  await closePool().catch(() => {})
}
