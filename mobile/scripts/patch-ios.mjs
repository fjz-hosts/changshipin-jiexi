#!/usr/bin/env node
/**
 * 给 Capacitor 生成的 iOS 工程打补丁：
 *  - MARKETING_VERSION / CURRENT_PROJECT_VERSION
 *  - App 显示名
 *  - ATS 允许本地 127.0.0.1 HTTP 与页面内任意加载
 *  - 文件 App 可见（下载目录）
 *  - 版本号与 package.json 同步
 *
 * 可重复执行；macOS CI 在 `npx cap sync ios` 之后调用。
 */
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = String(pkg.version || '1.0.0')
const [major = 0, minor = 0, patch = 0] = version.split('.').map((item) => Number(item) || 0)
const build = String(major * 10000 + minor * 100 + patch)
const iosApp = path.join(root, 'ios', 'App')
const plistPath = path.join(iosApp, 'App', 'Info.plist')
const pbxPath = path.join(iosApp, 'App.xcodeproj', 'project.pbxproj')

function patchPlist() {
  if (!fs.existsSync(plistPath)) {
    console.warn('Info.plist 不存在，跳过')
    return
  }
  let text = fs.readFileSync(plistPath, 'utf8')
  const ensureKey = (key, valueXml) => {
    if (new RegExp(`<key>${key}</key>`).test(text)) return
    text = text.replace(/<\/dict>\s*<\/plist>\s*$/, `\t<key>${key}</key>\n${valueXml}\n</dict>\n</plist>\n`)
  }
  ensureKey(
    'NSAppTransportSecurity',
    `\t<dict>
\t\t<key>NSAllowsArbitraryLoads</key>
\t\t<true/>
\t\t<key>NSAllowsArbitraryLoadsInWebContent</key>
\t\t<true/>
\t\t<key>NSAllowsLocalNetworking</key>
\t\t<true/>
\t</dict>`,
  )
  ensureKey('UIFileSharingEnabled', '\t<true/>')
  ensureKey('LSSupportsOpeningDocumentsInPlace', '\t<true/>')
  ensureKey('ITSAppUsesNonExemptEncryption', '\t<false/>')
  ensureKey('UIApplicationSupportsIndirectInputEvents', '\t<true/>')
  text = text.replace(/(<key>CFBundleDisplayName<\/key>\s*)<string>[^<]*<\/string>/, '$1<string>长视频解析</string>')
  text = text.replace(/<string>armv7<\/string>/g, '<string>arm64</string>')
  fs.writeFileSync(plistPath, text, 'utf8')
}

function patchPbx() {
  if (!fs.existsSync(pbxPath)) {
    console.warn('project.pbxproj 不存在，跳过')
    return
  }
  let text = fs.readFileSync(pbxPath, 'utf8')
  text = text.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`)
  text = text.replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${build};`)
  text = text.replace(/PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/g, 'PRODUCT_BUNDLE_IDENTIFIER = com.fjzhosts.changshipin;')
  fs.writeFileSync(pbxPath, text, 'utf8')
}

patchPlist()
patchPbx()
console.log(`iOS patched: version=${version} build=${build}`)
