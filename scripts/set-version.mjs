#!/usr/bin/env node
/**
 * 统一设置桌面端 / 手机端版本号。
 *
 *   node scripts/set-version.mjs 1.1.0
 *
 * 会同步：
 *  - desktop/electron/package.json
 *  - mobile/package.json
 *  - mobile/plugins/changshipin-native/package.json + podspec
 *  - mobile/www/core/version.js
 *  - mobile/android/app/build.gradle（versionName / versionCode）
 *  - mobile/ios/App/App.xcodeproj/project.pbxproj（MARKETING_VERSION / CURRENT_PROJECT_VERSION）
 *  - mobile/latest.json（手机端更新兜底清单）
 */
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const raw = String(process.argv[2] || '').replace(/^v/i, '').trim()
if (!/^\d+\.\d+\.\d+$/.test(raw)) {
  console.error('用法：node scripts/set-version.mjs <主>.<次>.<修订>，例如 1.1.0')
  process.exit(1)
}
const [major, minor, patch] = raw.split('.').map(Number)
const versionCode = major * 10000 + minor * 100 + patch

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8')
}

function write(file, text) {
  const target = path.join(root, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, text, 'utf8')
  console.log('updated', file)
}

function updateJson(file, mutate) {
  const target = path.join(root, file)
  if (!fs.existsSync(target)) return
  const data = JSON.parse(fs.readFileSync(target, 'utf8'))
  mutate(data)
  fs.writeFileSync(target, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  console.log('updated', file)
}

updateJson('desktop/electron/package.json', (pkg) => {
  pkg.version = raw
})
updateJson('mobile/package.json', (pkg) => {
  pkg.version = raw
})
updateJson('mobile/plugins/changshipin-native/package.json', (pkg) => {
  pkg.version = raw
})

write(
  'mobile/www/core/version.js',
  `/* 手机端版本号：由 scripts/set-version.mjs 自动写入，发版时与桌面端保持一致。 */\nwindow.CSP_VERSION = '${raw}'\nwindow.CSP_BUILD = '${versionCode}'\n`,
)

const podspec = 'mobile/plugins/changshipin-native/ChangshipinNative.podspec'
if (fs.existsSync(path.join(root, podspec))) {
  write(
    podspec,
    read(podspec).replace(/s\.version\s*=\s*'[^']*'/, `s.version = '${raw}'`),
  )
}

const gradle = 'mobile/android/app/build.gradle'
if (fs.existsSync(path.join(root, gradle))) {
  let text = read(gradle)
  text = text.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`)
  text = text.replace(/versionName\s+"[^"]*"/, `versionName "${raw}"`)
  write(gradle, text)
}

const pbx = 'mobile/ios/App/App.xcodeproj/project.pbxproj'
if (fs.existsSync(path.join(root, pbx))) {
  let text = read(pbx)
  text = text.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${raw};`)
  text = text.replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${versionCode};`)
  write(pbx, text)
}

updateJson('mobile/latest.json', (data) => {
  data.version = raw
  data.versionCode = versionCode
  data.publishedAt = new Date().toISOString()
  data.android = { asset: 'changshipin-android.apk' }
  data.ios = { asset: 'changshipin-ios-unsigned.ipa' }
})

console.log(`\n版本已同步为 v${raw}（versionCode ${versionCode}）`)
console.log('记得同步更新 README / 项目开发交接文档的更新记录。')
