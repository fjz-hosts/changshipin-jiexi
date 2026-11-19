#!/usr/bin/env node
/**
 * 给 Capacitor 生成的 Android 工程打补丁：
 *  - 版本号 / versionCode
 *  - release 签名（仓库里的 sideline keystore，可用环境变量覆盖）
 *  - 允许 127.0.0.1 明文 HTTP（本地取流代理）
 *  - FileProvider 路径（下载缓存 / 安装 APK）
 *  - 键盘 adjustResize、largeHeap
 *
 * 可重复执行；CI 在 `npx cap sync android` 之后调用。
 */
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const version = String(pkg.version || '1.0.0')
const [major = 0, minor = 0, patch = 0] = version.split('.').map((item) => Number(item) || 0)
const versionCode = major * 10000 + minor * 100 + patch
const androidDir = path.join(root, 'android')
const appDir = path.join(androidDir, 'app')

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
}

function patchRootGradle() {
  const file = path.join(androidDir, 'build.gradle')
  let text = fs.readFileSync(file, 'utf8')
  if (!text.includes('org.jetbrains.kotlin:kotlin-gradle-plugin')) {
    text = text.replace(
      /classpath 'com\.android\.tools\.build:gradle:[^']+'/,
      "$&\n        classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25'",
    )
    write(file, text)
  }
}

function patchBuildGradle() {
  const file = path.join(appDir, 'build.gradle')
  let text = fs.readFileSync(file, 'utf8')
  text = text.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`)
  text = text.replace(/versionName\s+"[^"]*"/, `versionName "${version}"`)
  if (!text.includes('CHANGSPIN_SIGNING')) {
    const signing = `\n    // CHANGSPIN_SIGNING：手机端 sideload 用的固定签名，保证覆盖安装可以升级\n    signingConfigs {\n        release {\n            storeFile file(System.getenv("CHANGSPIN_KEYSTORE") ?: "../../keystore/changshipin-release.keystore")\n            storePassword System.getenv("CHANGSPIN_STORE_PASSWORD") ?: "changshipin"\n            keyAlias System.getenv("CHANGSPIN_KEY_ALIAS") ?: "changshipin"\n            keyPassword System.getenv("CHANGSPIN_KEY_PASSWORD") ?: "changshipin"\n            storeType "jks"\n        }\n    }\n`
    const index = text.indexOf('    buildTypes {')
    if (index < 0) throw new Error('build.gradle 里找不到 buildTypes')
    text = text.slice(0, index) + signing + text.slice(index)
  }
  if (!text.includes('signingConfig signingConfigs.release')) {
    text = text.replace(/(buildTypes\s*\{\s*release\s*\{)/, '$1\n            signingConfig signingConfigs.release')
  }
  write(file, text)
}

function patchManifest() {
  const file = path.join(appDir, 'src/main/AndroidManifest.xml')
  let text = fs.readFileSync(file, 'utf8')
  if (!text.includes('REQUEST_INSTALL_PACKAGES')) {
    text = text.replace(
      /<uses-permission android:name="android.permission.INTERNET"\s*\/>/,
      '<uses-permission android:name="android.permission.INTERNET" />\n    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />',
    )
  }
  text = text.replace(/<application\b([^>]*)>/, (match, attrs) => {
    let next = attrs
    if (!/usesCleartextTraffic/.test(next)) next += '\n        android:usesCleartextTraffic="true"'
    if (!/largeHeap/.test(next)) next += '\n        android:largeHeap="true"'
    if (!/hardwareAccelerated/.test(next)) next += '\n        android:hardwareAccelerated="true"'
    if (!/allowBackup/.test(next)) next = next.replace('android:allowBackup="true"', 'android:allowBackup="false"')
    return `<application${next}>`
  })
  text = text.replace(/<activity\b([^>]*)>/, (match, attrs) => {
    if (/windowSoftInputMode/.test(attrs)) return match
    return `<activity${attrs}\n            android:windowSoftInputMode="adjustResize">`
  })
  write(file, text)
}

function patchFilePaths() {
  write(
    path.join(appDir, 'src/main/res/xml/file_paths.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<paths xmlns:android="http://schemas.android.com/apk/res/android">
    <cache-path name="cache" path="." />
    <files-path name="files" path="." />
    <external-path name="external" path="." />
    <external-files-path name="external_files" path="." />
    <external-cache-path name="external_cache" path="." />
</paths>
`,
  )
}

function patchNetworking() {
  write(
    path.join(appDir, 'src/main/res/xml/network_security_config.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
        </trust-anchors>
    </base-config>
</network-security-config>
`,
  )
  const manifest = path.join(appDir, 'src/main/AndroidManifest.xml')
  let text = fs.readFileSync(manifest, 'utf8')
  if (!text.includes('networkSecurityConfig')) {
    text = text.replace(/<application\b([^>]*)>/, '<application$1\n        android:networkSecurityConfig="@xml/network_security_config">')
    fs.writeFileSync(manifest, text, 'utf8')
  }
}

patchRootGradle()
patchBuildGradle()
patchManifest()
patchFilePaths()
patchNetworking()
console.log(`Android patched: version=${version} versionCode=${versionCode}`)
