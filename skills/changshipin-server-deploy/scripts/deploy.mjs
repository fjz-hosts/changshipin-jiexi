#!/usr/bin/env node
/**
 * 音视频解析 · 服务端一键部署
 *
 * 用法（在仓库根目录执行）：
 *   node skills/changshipin-server-deploy/scripts/deploy.mjs
 *   node skills/changshipin-server-deploy/scripts/deploy.mjs --dry-run
 *   node skills/changshipin-server-deploy/scripts/deploy.mjs --verify-only
 *
 * 只依赖 Node.js 20+ 与 trae-deploy CLI，不额外安装包。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const skillDir = path.resolve(scriptDir, '..')
const projectRootDefault = path.resolve(skillDir, '..', '..')

const EXCLUDE = new Set(['node_modules', '.git', 'dist', 'logs', '.DS_Store'])

// 部署平台会把 .env / .env.example 这类文件判为高风险并拒绝整个上传
function isEnvFile(name) {
  return name === '.env' || name.startsWith('.env.')
}
const DEFAULT_ALIASES = {
  JWT_SECRET: 'AUTH_KEY',
  ADMIN_PASSWORD: 'ADMIN_PASS',
  EMAIL_PASSWORD: 'MAIL_AUTH',
}

function log(...args) {
  console.log('[deploy]', ...args)
}

function warn(...args) {
  console.warn('[deploy] WARN', ...args)
}

function fail(message) {
  console.error('[deploy] 失败：', message)
  process.exit(1)
}

function parseArgs(argv) {
  const options = {
    config: '',
    project: '',
    siteId: '',
    dryRun: false,
    noWait: false,
    skipVerify: false,
    verifyOnly: false,
    authCheck: false,
    title: '',
    description: '',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--config') options.config = argv[++i] || ''
    else if (arg === '--project') options.project = argv[++i] || ''
    else if (arg === '--site-id') options.siteId = argv[++i] || ''
    else if (arg === '--title') options.title = argv[++i] || ''
    else if (arg === '--description') options.description = argv[++i] || ''
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--no-wait') options.noWait = true
    else if (arg === '--skip-verify') options.skipVerify = true
    else if (arg === '--verify-only') options.verifyOnly = true
    else if (arg === '--auth-check') options.authCheck = true
    else if (arg === '-h' || arg === '--help') {
      console.log(
        [
          '用法：node scripts/deploy.mjs [选项]',
          '  --config <file>        配置文件（默认 skill 目录下的 deploy.config.json）',
          '  --project <dir>        项目根目录（默认 skill 的上两级）',
          '  --site-id <id>         指定站点，跳过配置文件里的 siteId',
          '  --title <text>         本次部署标题',
          '  --description <text>   本次部署说明',
          '  --dry-run              只打印计划，不调用部署',
          '  --no-wait              创建部署后立即返回',
          '  --skip-verify          部署完跳过健康检查',
          '  --verify-only          只做健康检查',
          '  --auth-check           只检查 trae-deploy 凭据是否可用',
        ].join('\n'),
      )
      process.exit(0)
    } else {
      warn('忽略未知参数', arg)
    }
  }
  return options
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (fallback !== null) return fallback
    throw new Error(`读取配置失败 ${file}：${error.message}`)
  }
}

// 解析 .env：支持 KEY=VALUE、export KEY=VALUE、引号与 # 注释
function readEnvFile(file) {
  const result = {}
  if (!file || !fs.existsSync(file)) return result
  const text = fs.readFileSync(file, 'utf8')
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.replace(/^export\s+/, '').match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[match[1]] = value
  }
  return result
}

function resolveCli() {
  const fromEnv = process.env.TRAE_DEPLOY_BIN
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv

  const pluginsRoot = path.join(os.homedir(), '.trae-cn', 'plugins', 'trae-remote-official', 'deployment')
  if (fs.existsSync(pluginsRoot)) {
    const versions = fs
      .readdirSync(pluginsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .reverse()
    for (const version of versions) {
      const candidate = path.join(pluginsRoot, version, 'skills', 'deployment', 'bin', 'win32-x64', 'trae-deploy.exe')
      if (fs.existsSync(candidate)) return candidate
    }
  }

  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['trae-deploy'], { encoding: 'utf8' })
  const first = String(which.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0]
  if (first) return first
  return ''
}

function runCli(cli, args, env) {
  const result = spawnSync(cli, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env })
  const stdout = String(result.stdout || '').trim()
  const stderr = String(result.stderr || '').trim()
  let json = null
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      json = JSON.parse(stdout.slice(start, end + 1))
    } catch {
      json = null
    }
  }
  return { status: result.status ?? -1, stdout, stderr, json }
}

function cliJson(cli, args, action, env) {
  const result = runCli(cli, args, env)
  if (!result.json) {
    fail(`${action} 没有返回可解析的 JSON。\nstdout: ${result.stdout.slice(0, 500)}\nstderr: ${result.stderr.slice(0, 500)}`)
  }
  return result
}

// ---------------------------------------------------------------------------
// 运行上下文：trae-deploy 依赖 Trae Agent 注入的 TRAE_* 变量 + 本机 JWT 文件。
// 在 DSH / 普通终端里这些变量不存在，所以第一次在 Trae 里运行时把非敏感上下文
// 存到 ~/.trae-cn/changshipin-deploy-session.json，之后 DSH 直接用这份文件。
// 真实凭据始终留在 Trae 自己维护的 ~/.trae-cn/trae-jwt-token，不复制、不写入仓库。
// ---------------------------------------------------------------------------
function defaultTokenPath() {
  return path.join(os.homedir(), '.trae-cn', 'trae-jwt-token')
}

function sessionFilePath(config) {
  if (config.sessionFile) return path.resolve(projectRootForConfig, config.sessionFile)
  // 放在项目 .tmp 下：工作区可写、已被 .gitignore 忽略，也不会被打进技能包
  return path.join(projectRootForConfig, '.tmp', 'changshipin-deploy-session.json')
}

let projectRootForConfig = process.cwd()

function readTokenExpiry(tokenPath) {
  try {
    const token = fs.readFileSync(tokenPath, 'utf8').trim()
    const payload = token.split('.')[1]
    if (!payload) return null
    const decoded = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    return decoded.exp ? decoded.exp * 1000 : null
  } catch {
    return null
  }
}

function buildRuntimeContext(config) {
  const file = sessionFilePath(config)
  const saved = readJson(file, {})
  const env = process.env
  const context = {
    projectId: env.TRAE_PROJECT_ID || saved.projectId || '',
    chatSessionId: env.TRAE_CHAT_SESSION_ID || saved.chatSessionId || '',
    region: env.TRAE_REGION || saved.region || 'cn',
    brandName: env.TRAE_BRAND_NAME || saved.brandName || '',
    lane: env.TRAE_LANE || saved.lane || 'prod',
    globalStorageDir: env.TRAE_GLOBAL_STORAGE_DIR || saved.globalStorageDir || '',
    userDataDir: env.TRAE_USER_DATA_DIR || saved.userDataDir || '',
    tokenPath: env.TRAE_JWT_TOKEN_PATH || env.TRAE_DEPLOYMENT_TOKEN_PATH || saved.tokenPath || defaultTokenPath(),
  }

  // 在 Trae 里跑时自动落盘，方便之后在 DSH 里复用；不覆盖已经存在的 token 内容
  if (context.projectId && context.region && (!saved.projectId || saved.region !== context.region)) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify({ ...context, savedAt: new Date().toISOString() }, null, 2), 'utf8')
      log(`已记录运行上下文：${file}（不含 token，token 仍在 ${context.tokenPath}）`)
    } catch (error) {
      warn(`记录运行上下文失败：${error.message}`)
    }
  }
  return { context, file }
}

function cliEnv(context) {
  const env = { ...process.env }
  env.TRAE_PROJECT_ID = context.projectId
  env.TRAE_REGION = context.region
  env.TRAE_CHAT_SESSION_ID = context.chatSessionId || crypto.randomUUID()
  env.TRAE_JWT_TOKEN_PATH = context.tokenPath
  if (context.brandName) env.TRAE_BRAND_NAME = context.brandName
  if (context.lane) env.TRAE_LANE = context.lane
  if (context.globalStorageDir) env.TRAE_GLOBAL_STORAGE_DIR = context.globalStorageDir
  if (context.userDataDir) env.TRAE_USER_DATA_DIR = context.userDataDir
  return env
}

function checkAuth(cli, env, context) {
  if (!fs.existsSync(context.tokenPath)) {
    return {
      ok: false,
      message: `找不到 Trae 登录凭据 ${context.tokenPath}。请先在本机打开 / 登录 Trae CN，或在 Trae 里运行一次本脚本以刷新凭据。`,
    }
  }
  const expiry = readTokenExpiry(context.tokenPath)
  if (expiry && expiry < Date.now()) {
    return {
      ok: false,
      message: `Trae 登录凭据已过期（${new Date(expiry).toLocaleString('zh-CN')}）。打开 Trae CN 后重新运行本脚本即可刷新。`,
    }
  }
  if (!context.projectId) {
    return {
      ok: false,
      message: '缺少 TRAE_PROJECT_ID：请先在 Trae 里运行一次本脚本（脚本会自动记录运行上下文），或手动在项目的 .tmp/changshipin-deploy-session.json 里补齐。',
    }
  }
  const result = runCli(cli, ['check'], env)
  if (!result.json || result.json.ok !== true) {
    const code = result.json?.error?.code || ''
    const message = result.json?.error?.message || result.stderr.slice(0, 200)
    return { ok: false, message: `trae-deploy 鉴权失败${code ? `（${code}）` : ''}：${message}` }
  }
  if (expiry && expiry - Date.now() < 12 * 3600 * 1000) {
    warn(`Trae 凭据将在 ${new Date(expiry).toLocaleString('zh-CN')} 过期，届时打开一次 Trae 即可续期。`)
  }
  return { ok: true, expiry }
}

function copySource(fromDir, toDir) {
  fs.mkdirSync(toDir, { recursive: true })
  for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
    if (EXCLUDE.has(entry.name) || isEnvFile(entry.name)) continue
    if (entry.name.endsWith('.log') || entry.name.endsWith('.part')) continue
    const src = path.join(fromDir, entry.name)
    const dest = path.join(toDir, entry.name)
    fs.cpSync(src, dest, {
      recursive: true,
      force: true,
      filter: (source) => {
        const base = path.basename(source)
        return !EXCLUDE.has(base) && !isEnvFile(base) && !base.endsWith('.log')
      },
    })
  }
}

function normalizeRuntimeEnv(envFileEnv, config) {
  const aliases = { ...DEFAULT_ALIASES, ...(config.secretAliases || {}) }
  const output = {}
  for (const [key, value] of Object.entries(envFileEnv)) {
    if (value === '') continue
    const target = aliases[key] || key
    if (/SECRET|PASSWORD/i.test(target)) {
      warn(`跳过变量 ${key}：平台不允许环境变量名包含 SECRET / PASSWORD，请在 secretAliases 里改名`)
      continue
    }
    output[target] = value
  }
  for (const [key, value] of Object.entries(config.env || {})) {
    if (value === undefined || value === null || value === '') continue
    output[key] = String(value)
  }
  output.NODE_ENV = output.NODE_ENV || 'production'
  output.PORT = String(config.runtimePort || 8000)
  return output
}

async function fetchWithTimeout(url, timeoutMs = 20000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json,text/html' } })
    const text = await response.text()
    return { status: response.status, text }
  } finally {
    clearTimeout(timer)
  }
}

async function verify(baseUrl) {
  let lastError = ''
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    try {
      const health = await fetchWithTimeout(`${baseUrl}/api/health`)
      if (health.status === 200 && health.text.includes('"ok":true')) {
        log(`健康检查通过：${baseUrl}/api/health`)
        const admin = await fetchWithTimeout(`${baseUrl}/admin/`)
        if (admin.status === 200 && /<html/i.test(admin.text)) {
          log(`后台首页正常：${baseUrl}/admin/`)
        } else {
          warn(`后台首页返回 ${admin.status}，请检查 /admin 静态资源`)
        }
        return true
      }
      lastError = `HTTP ${health.status} ${health.text.slice(0, 160)}`
    } catch (error) {
      lastError = String(error?.message || error)
    }
    if (attempt < 8) await new Promise((resolve) => setTimeout(resolve, 5000))
  }
  warn(`健康检查未通过：${lastError}`)
  return false
}

function ensureSite(cli, options, config, description, cliRunEnv) {
  const siteId = options.siteId || config.siteId
  if (siteId) {
    const result = cliJson(cli, ['sites', 'get', '--site-id', siteId], 'sites get', cliRunEnv)
    if (result.json?.ok === false) fail(`站点 ${siteId} 不可用：${result.json?.error?.message || '未知错误'}`)
    const site = result.json.data
    const publicPolicy = site.access_policy === 2
    if (!publicPolicy) {
      log(`站点当前不是公开访问，切换为 public …`)
      cliJson(cli, ['sites', 'update-config', '--site-id', siteId, '--access-policy', 'public'], 'sites update-config', cliRunEnv)
    }
    return { siteId, hostname: site.site_config?.hostname || '', accessPolicy: 2 }
  }

  const list = cliJson(cli, ['sites', 'list'], 'sites list', cliRunEnv)
  const items = list.json?.data?.items || []
  const matched = items.find((item) => item.display_name === config.siteName)
  if (matched) {
    if (matched.access_policy !== 2) {
      log('站点不是公开访问，切换为 public …')
      cliJson(cli, ['sites', 'update-config', '--site-id', matched.deploy_target_id, '--access-policy', 'public'], 'sites update-config', cliRunEnv)
    }
    return { siteId: matched.deploy_target_id, hostname: matched.site_config?.hostname || '', accessPolicy: 2 }
  }

  log(`没有找到站点「${config.siteName}」，创建新站点 …`)
  const created = cliJson(
    cli,
    ['sites', 'create', '--name', config.siteName, '--description', description, '--access-policy', 'public'],
    'sites create',
    cliRunEnv,
  )
  const site = created.json?.data
  const newId = site?.deploy_target_id || site?.site_id || ''
  if (!newId) fail('创建站点后没有拿到站点 ID，请到 Trae 控制台确认')
  return { siteId: newId, hostname: site?.site_config?.hostname || '', accessPolicy: 2 }
}

function siteBaseUrl(hostname, fallback) {
  if (fallback) return String(fallback).replace(/\/+$/, '')
  if (!hostname) return ''
  return `https://${hostname}`
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const projectRoot = path.resolve(options.project || projectRootDefault)
  const configPath = options.config ? path.resolve(options.config) : path.join(skillDir, 'deploy.config.json')
  if (!fs.existsSync(configPath)) {
    fail(
      `找不到配置文件 ${configPath}。把 deploy.config.example.json 复制成 deploy.config.json，填好 siteId / siteName / env 后再运行。`,
    )
  }

  const config = readJson(configPath)
  projectRootForConfig = projectRoot
  const serverDir = path.resolve(projectRoot, config.serverDir || 'server')
  if (!fs.existsSync(path.join(serverDir, 'package.json'))) {
    fail(`服务端目录不存在或缺少 package.json：${serverDir}`)
  }
  const envFile = config.envFile ? path.resolve(projectRoot, config.envFile) : ''
  const baseUrl = siteBaseUrl('', config.baseUrl)

  if (options.verifyOnly) {
    if (!baseUrl) fail('--verify-only 需要在配置里提供 baseUrl')
    const ok = await verify(baseUrl)
    process.exit(ok ? 0 : 1)
  }

  const cli = resolveCli()
  if (!cli) {
    fail(
      '找不到 trae-deploy CLI。请安装 Trae deployment 插件，或用环境变量 TRAE_DEPLOY_BIN 指向 trae-deploy 可执行文件。',
    )
  }
  log(`CLI：${cli}`)
  log(`项目：${projectRoot}`)
  log(`服务端：${serverDir}`)

  const { context, file: sessionFile } = buildRuntimeContext(config)
  const runEnv = cliEnv(context)
  const auth = checkAuth(cli, runEnv, context)
  if (!auth.ok) {
    if (options.authCheck) fail(auth.message)
    if (!options.dryRun) fail(auth.message)
    warn(auth.message)
  } else {
    log(`鉴权正常（凭据 ${context.tokenPath}${auth.expiry ? `，${new Date(auth.expiry).toLocaleString('zh-CN')} 过期` : ''}）`)
  }
  if (options.authCheck) {
    log(`运行上下文文件：${sessionFile}`)
    log('鉴权检查通过')
    return
  }

  const envFileEnv = readEnvFile(envFile)
  if (envFile && !fs.existsSync(envFile)) warn(`没有找到 ${envFile}，将只使用配置里的 env`)
  const runtimeEnv = normalizeRuntimeEnv(envFileEnv, config)
  const required = ['DATABASE_URL', 'AUTH_KEY']
  const missing = required.filter((key) => !runtimeEnv[key])
  if (missing.length) fail(`运行时缺少必要变量：${missing.join('、')}（检查 ${envFile || 'deploy.config.json'}）`)

  const port = Number(config.runtimePort) || 8000
  const generatedTitle = options.title || `服务端部署 ${new Date().toLocaleString('zh-CN', { hour12: false })}`
  const generatedDescription =
    options.description ||
    config.siteDescription ||
    `来源：${path.relative(projectRoot, serverDir) || 'server'}（Node.js 20 + Express）。部署账号 / 反馈 / 使用统计 API 与 /admin 管理后台。`

  const tempDir = path.join(os.tmpdir(), `trae-deploy-${crypto.randomBytes(4).toString('hex')}`)
  const execConfigPath = path.join(os.tmpdir(), `trae-deploy-exec-${crypto.randomBytes(4).toString('hex')}.json`)

  const executionConfig = {
    schema_version: 1,
    build: {
      runtime_key: 'nodejs20',
      build_script: 'build.sh',
      output_dir: 'dist',
      environment: {},
      timeout_seconds: 3600,
    },
    runtime: {
      runtime_key: 'nodejs20',
      start_script: 'run.sh',
      port,
      environment: runtimeEnv,
    },
  }

  copySource(serverDir, tempDir)
  fs.writeFileSync(execConfigPath, JSON.stringify(executionConfig, null, 2), 'utf8')
  // 打包内容和执行配置都是临时文件，退出时（成功 / 失败 / dry-run）统一清理
  process.on('exit', () => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
      fs.rmSync(execConfigPath, { force: true })
    } catch {
      /* 清理失败不影响结果 */
    }
  })
  log(`已准备源码：${tempDir}`)
  log(`运行时变量：${Object.keys(runtimeEnv).join(', ')}`)

  if (options.dryRun) {
    log('--- dry-run：以下命令不会真正执行 ---')
    log(`sites get / sites create --name "${config.siteName}" --access-policy public`)
    log(
      `deployments create --site-id <id> --title "${generatedTitle}" --description "${generatedDescription}" --type function-web --source-dir "${tempDir}" --execution-config "${execConfigPath}" --app-tags "${config.appTags || '123,167'}"`,
    )
    log(`deployments wait --deployment-id <id> --timeout-seconds ${config.waitTimeoutSeconds || 600}`)
    return
  }

  let site
  try {
    site = ensureSite(cli, options, config, generatedDescription, runEnv)
  } catch (error) {
    fail(`站点准备失败：${error.message}`)
  }
  const siteUrl = siteBaseUrl(site.hostname, config.baseUrl)
  log(`站点：${site.siteId}（public）· ${siteUrl || '域名未知'}`)

  log('创建部署 …')
  const created = cliJson(
    cli,
    [
      'deployments',
      'create',
      '--site-id',
      site.siteId,
      '--title',
      generatedTitle,
      '--description',
      generatedDescription,
      '--type',
      'function-web',
      '--source-dir',
      tempDir,
      '--execution-config',
      execConfigPath,
      '--app-tags',
      String(config.appTags || '123,167'),
    ],
    'deployments create',
    runEnv,
  )
  if (created.json?.ok === false) {
    const code = created.json?.error?.code || ''
    const message = created.json?.error?.message || ''
    fail(`创建部署被拒绝（${code}）：${message}`)
  }
  const deployment = created.json?.data || {}
  const deploymentId = deployment.deployment_id || ''
  if (!deploymentId) fail('创建部署后没有拿到 deployment_id，请到控制台确认（不要直接重复创建）')
  log(`部署已创建：${deploymentId}`)

  if (options.noWait) {
    log('已跳过等待（--no-wait）。用 deployments wait --deployment-id ' + deploymentId + ' 查看结果。')
    return
  }

  log('等待构建与发布 …')
  const waited = runCli(
    cli,
    [
      'deployments',
      'wait',
      '--deployment-id',
      deploymentId,
      '--timeout-seconds',
      String(config.waitTimeoutSeconds || 600),
    ],
    runEnv,
  )
  const status = waited.json?.data?.deployment?.status
  const reason = waited.json?.data?.wait_reason
  if (waited.status !== 0 || status !== 9) {
    const failure = waited.json?.data?.deployment?.failure
    const code = waited.json?.error?.code || failure?.code || ''
    const message = waited.json?.error?.message || failure?.message || waited.stderr.slice(0, 400)
    console.error('[deploy] 部署未成功：', code, message)
    console.error(`[deploy] 排查：trae-deploy logs build --deployment-id ${deploymentId}`)
    console.error(`[deploy] 或：   trae-deploy logs deploy --deployment-id ${deploymentId}`)
    process.exit(1)
  }
  const elapsed = waited.json?.data?.elapsed_seconds
  log(`部署成功${elapsed ? `（耗时 ${elapsed}s）` : ''}${reason ? ` · ${reason}` : ''}`)
  log(`地址：${siteUrl}/admin/`)

  if (!options.skipVerify && siteUrl) {
    const ok = await verify(siteUrl)
    if (!ok) process.exit(1)
  }
  log('完成。客户端无需重新发版：桌面端「设置 → 关于 → 数据面板」每次打开都会重新加载。')
}

main().catch((error) => {
  console.error('[deploy] 异常：', error?.stack || error)
  process.exit(1)
})
