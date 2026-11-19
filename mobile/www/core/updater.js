/* 手机端更新：与桌面端同一套 GitHub Release + 国内镜像，同一个版本号。 */
;(function () {
  'use strict'

  const N = window.CSPNative
  const REPO = 'https://github.com/fjz-hosts/changshipin-jiexi'
  const MIRRORS = [
    `https://gh.monlor.com/${REPO}`,
    `https://gh-proxy.com/${REPO}`,
    `https://ghfile.geekertao.top/${REPO}`,
    `https://hk.gh-proxy.com/${REPO}`,
    REPO,
  ]
  const META_FEEDS = [
    ...MIRRORS.map((base) => `${base}/releases/latest/download/latest-mobile.json`),
    'https://cdn.jsdelivr.net/gh/fjz-hosts/changshipin-jiexi@main/mobile/latest.json',
  ]
  const APK_NAMES = ['changshipin-android.apk']
  const IPA_NAMES = ['changshipin-ios-unsigned.ipa', 'changshipin-ios.ipa']

  function parseVersion(value) {
    const text = String(value || '').replace(/^v/i, '').trim()
    const match = text.match(/^(\d+)\.(\d+)\.(\d+)/)
    if (!match) return [0, 0, 0]
    return [Number(match[1]), Number(match[2]), Number(match[3])]
  }

  function compareVersion(left, right) {
    const a = parseVersion(left)
    const b = parseVersion(right)
    for (let index = 0; index < 3; index += 1) {
      if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1
    }
    return 0
  }

  class MobileUpdater {
    constructor({ getAutoUpdate, onState } = {}) {
      this.getAutoUpdate = typeof getAutoUpdate === 'function' ? getAutoUpdate : () => true
      this.onState = onState || (() => {})
      this.currentVersion = window.CSP_VERSION || ''
      this.info = null
      this.downloadedPath = ''
      this.downloading = false
      this.snapshotData = {
        status: 'idle',
        currentVersion: this.currentVersion,
        version: '',
        percent: 0,
        message: '等待检查',
        feed: '',
        feeds: META_FEEDS,
        notes: '',
        downloaded: false,
      }
    }

    snapshot() {
      return { ...this.snapshotData }
    }

    emit(patch = {}) {
      Object.assign(this.snapshotData, patch)
      this.onState(this.snapshot())
    }

    async fetchMeta() {
      for (const feed of META_FEEDS) {
        try {
          const response = await N.fetchText(feed, { timeout: 12000 })
          if (!response.ok) continue
          const data = response.json
          if (!data || typeof data !== 'object') continue
          if (!data.version) continue
          this.emit({ feed })
          return { ...data, feed }
        } catch {
          /* 换下一个镜像 */
        }
      }
      return null
    }

    mirrorUrls(name) {
      if (!name) return []
      return MIRRORS.map((base) => `${base}/releases/latest/download/${encodeURIComponent(name)}`)
    }

    async check({ manual = false } = {}) {
      this.emit({
        status: 'checking',
        message: manual ? '正在检查更新…' : '后台检查更新…',
        percent: 0,
        currentVersion: this.currentVersion,
      })
      const meta = await this.fetchMeta()
      if (!meta) {
        this.emit({
          status: 'idle',
          message: '暂时连不上更新源（可稍后重试；不影响解析和播放）',
          downloads: [],
        })
        return this.snapshot()
      }
      this.info = meta
      const latest = String(meta.version || '')
      this.emit({
        version: latest,
        notes: String(meta.notes || ''),
        currentVersion: this.currentVersion,
      })
      if (compareVersion(latest, this.currentVersion) <= 0) {
        this.emit({ status: 'latest', message: `已是最新版本 v${this.currentVersion}`, percent: 0 })
        return this.snapshot()
      }
      const android = meta.android || {}
      const ios = meta.ios || {}
      const urls = {
        android: android.url || this.mirrorUrls(android.asset || APK_NAMES[0])[0],
        ios: ios.url || this.mirrorUrls(ios.asset || IPA_NAMES[0])[0],
      }
      this.emit({
        status: 'available',
        message: `发现新版本 v${latest}${meta.notes ? `：${String(meta.notes).slice(0, 120)}` : ''}`,
        downloads: urls,
        percent: 0,
      })
      if (manual && N.platform === 'android' && urls.android) {
        return this.downloadAndroid(urls.android)
      }
      if (manual && N.platform === 'ios') {
        this.emit({
          status: 'downloaded',
          downloaded: true,
          message: `新版本 v${latest} 已就绪。iOS 免签名版需要重新下载 IPA 并用 Sideloadly / AltStore 安装。点「立即安装」打开下载页。`,
        })
      }
      return this.snapshot()
    }

    async downloadAndroid(url) {
      if (this.downloading) return this.snapshot()
      this.downloading = true
      try {
        const name = `changshipin-android-${this.snapshotData.version || 'latest'}.apk`
        const dir = '更新安装包'
        await N.fs.mkdir(dir, 'CACHE')
        const response = await N.fetchBinary(url, { timeout: 300000 })
        if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
        const total = Number(response.headers.get('content-length')) || 0
        const reader = response.body?.getReader()
        if (!reader) throw new Error('当前网络无法读取安装包')
        let bytes = 0
        let written = false
        const started = Date.now()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.length
          const base64 = N.base64FromBytes(value)
          if (written) await N.fs.append(`${dir}/${name}`, base64, 'CACHE')
          else {
            await N.fs.write(`${dir}/${name}`, base64, 'CACHE')
            written = true
          }
          this.emit({
            status: 'downloading',
            percent: total ? Math.min(99, Math.round((bytes / total) * 100)) : 0,
            message: `正在下载新版本 ${total ? `${Math.round((bytes / total) * 100)}%` : `${(bytes / 1048576).toFixed(1)} MB`}…`,
            speed: bytes / Math.max(0.3, (Date.now() - started) / 1000),
          })
        }
        this.downloadedPath = `${dir}/${name}`
        this.emit({
          status: 'downloaded',
          downloaded: true,
          percent: 100,
          message: `新版本 v${this.snapshotData.version} 已下载，点「立即安装」完成更新（会覆盖安装，配置和历史都保留）。`,
        })
        return this.snapshot()
      } catch (error) {
        this.emit({
          status: 'failed',
          message: `更新下载失败：${String(error?.message || error).slice(0, 120)}`,
        })
        return this.snapshot()
      } finally {
        this.downloading = false
      }
    }

    async install() {
      if (N.platform === 'ios') {
        const url = this.snapshotData.downloads?.ios || this.info?.ios?.url || `${REPO}/releases/latest`
        await N.openExternal(url)
        this.emit({
          message: '已打开 IPA 下载地址。iOS 免签名版需要电脑用 Sideloadly / AltStore 重新签名安装；更新前请先备份配置。',
        })
        return true
      }
      if (!this.downloadedPath) {
        const url = this.snapshotData.downloads?.android
        if (url) await this.downloadAndroid(url)
      }
      if (!this.downloadedPath) return false
      try {
        const uri = await N.fs.uri(this.downloadedPath, 'CACHE')
        const result = await N.installApk(uri)
        if (result && result.ok === false) {
          this.emit({ message: `安装器打开失败：${result.error || '请到系统下载目录手动安装'}` })
          await N.openDownloadsFolder()
          return false
        }
        return true
      } catch (error) {
        this.emit({ message: `安装失败：${String(error?.message || error).slice(0, 120)}` })
        return false
      }
    }
  }

  window.CSPUpdater = { MobileUpdater, compareVersion, META_FEEDS, MIRRORS, REPO }
})()
