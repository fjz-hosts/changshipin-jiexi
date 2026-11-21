'use strict'

/**
 * 投屏（DLNA / UPnP AVTransport）。
 *
 * 主要用在电视、投影、机顶盒上：这些设备基本都带一个 UPnP MediaRenderer，
 * 我们用 SSDP 在局域网里找到它，再把「本地取流代理」的地址推过去，
 * 由电视自己去拉流。因为流是从本机的代理出去的，防盗链需要的 Referer / Cookie
 * 仍由主进程补齐，电视端不需要知道任何解析细节。
 *
 * 不依赖第三方库：SSDP 用 dgram，设备描述 / SOAP 用 node:http。
 */

const dgram = require('node:dgram')
const http = require('node:http')
const os = require('node:os')

const SSDP_ADDRESS = '239.255.255.250'
const SSDP_PORT = 1900
const MEDIA_RENDERER = 'urn:schemas-upnp-org:device:MediaRenderer:1'
const SCAN_TIMEOUT = 2800
const POLL_INTERVAL = 2600

// 虚拟网卡 / VPN 不可能是电视所在的网段，排到后面
const VIRTUAL_IFACE =
  /(vmware|virtualbox|vbox|hyper-?v|vethernet|docker|wsl|loopback|bluetooth|tailscale|zerotier|tap|tun|ovpn|wintun|npcap|radmin|hamachi|clash|mihomo|surge)/i

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function decodeEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, num) => String.fromCodePoint(parseInt(num, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function escapeXml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function xmlTag(xml, name) {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(String(xml || ''))
  return match ? decodeEntities(match[1].trim()) : ''
}

function resolveUrl(target, base) {
  try {
    return new URL(String(target), String(base)).href
  } catch {
    return ''
  }
}

function ipv4ToInt(text) {
  const parts = String(text || '').split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    const num = Number(part)
    if (!Number.isInteger(num) || num < 0 || num > 255) return null
    value = value * 256 + num
  }
  return value
}

function inSameSubnet(address, netmask, other) {
  const a = ipv4ToInt(address)
  const m = ipv4ToInt(netmask)
  const b = ipv4ToInt(other)
  if (a == null || m == null || b == null) return false
  return (a & m) === (b & m)
}

function isPrivateIPv4(address) {
  const parts = String(address || '').split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  if (parts[0] === 10) return true
  if (parts[0] === 192 && parts[1] === 168) return true
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
  return false
}

function privateScore(address) {
  if (String(address).startsWith('192.168.')) return 3
  if (String(address).startsWith('10.')) return 2
  return 1
}

/**
 * 本机可用的局域网 IPv4 地址。电视必须能访问到这个地址，所以只挑私有网段，
 * 并把虚拟网卡（VMware / VirtualBox / Hyper-V / WSL / VPN）排到后面。
 */
function lanAddresses() {
  const list = []
  let interfaces = {}
  try {
    interfaces = os.networkInterfaces()
  } catch {
    return list
  }
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      const family = entry.family
      if (family !== 'IPv4' && family !== 4) continue
      if (entry.internal) continue
      if (!isPrivateIPv4(entry.address)) continue
      list.push({
        name,
        address: entry.address,
        netmask: entry.netmask || '255.255.255.0',
        virtual: VIRTUAL_IFACE.test(String(name)),
        score: privateScore(entry.address),
      })
    }
  }
  list.sort((a, b) => Number(a.virtual) - Number(b.virtual) || b.score - a.score)
  return list
}

/** 优先选和投屏设备同网段的地址；拿不到设备地址时用默认排序的第一个。 */
function bestLocalAddress(remoteIp = '') {
  const list = lanAddresses()
  if (!list.length) return ''
  if (remoteIp) {
    const same = list.find((item) => inSameSubnet(item.address, item.netmask, remoteIp))
    if (same) return same.address
  }
  return list[0].address
}

function formatOffset(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function parseOffset(text) {
  const match = /(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)/.exec(String(text || ''))
  if (!match) return 0
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

// ---------------------------------------------------------------------------
// HTTP / SOAP
// ---------------------------------------------------------------------------

function requestText(target, { method = 'GET', headers = {}, body = null, timeout = 4000, maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let url = null
    try {
      url = new URL(String(target))
    } catch {
      reject(new Error('设备地址无效'))
      return
    }
    if (url.protocol !== 'http:') {
      reject(new Error('只支持 http 设备'))
      return
    }
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve(value)
    }
    const payload = body == null ? null : Buffer.from(String(body), 'utf8')
    const request = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || 80,
        path: `${url.pathname}${url.search}`,
        agent: false,
        headers: {
          'user-agent': 'changshipin-cast/1.0',
          connection: 'close',
          ...headers,
          ...(payload ? { 'content-length': payload.length } : {}),
        },
      },
      (response) => {
        const chunks = []
        let size = 0
        response.on('data', (chunk) => {
          size += chunk.length
          if (size > maxBytes) {
            response.destroy()
            finish(new Error('设备返回内容过大'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          finish(null, {
            status: response.statusCode || 0,
            headers: response.headers || {},
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
        response.on('error', (error) => finish(error))
      },
    )
    request.setTimeout(timeout, () => request.destroy(new Error('设备响应超时')))
    request.on('error', (error) => finish(error))
    if (payload) request.write(payload)
    request.end()
  })
}

/** 组装 SOAP 信封（导出给自检用）。 */
function buildSoapEnvelope(serviceType, action, params = {}) {
  const args = Object.entries(params)
    .map(([key, value]) => `<${key}>${escapeXml(value)}</${key}>`)
    .join('')
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${serviceType}">${args}</u:${action}></s:Body>` +
    '</s:Envelope>'
  )
}

function soapFault(body) {
  const match =
    /<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i.exec(String(body || '')) ||
    /<errorDescription[^>]*>([\s\S]*?)<\/errorDescription>/i.exec(String(body || ''))
  return match ? decodeEntities(match[1].trim()) : ''
}

async function soapInvoke(service, action, params, { timeout = 5000 } = {}) {
  if (!service || !service.controlURL) throw new Error('设备不支持这个控制指令')
  const body = buildSoapEnvelope(service.serviceType, action, params)
  const result = await requestText(service.controlURL, {
    method: 'POST',
    headers: {
      'content-type': 'text/xml; charset="utf-8"',
      SOAPAction: `"${service.serviceType}#${action}"`,
    },
    body,
    timeout,
  })
  if (result.status >= 400) {
    throw new Error(soapFault(result.body) || `${action} 失败（HTTP ${result.status}）`)
  }
  return result.body
}

// ---------------------------------------------------------------------------
// 设备描述
// ---------------------------------------------------------------------------

/**
 * 解析 UPnP 设备描述 XML（导出给自检用）。
 * 只关心 AVTransport / RenderingControl 两个服务；控制地址按 description 的
 * 实际 URL 解析成绝对地址（不同设备写法差异很大）。
 */
function parseDeviceDescription(xml, location = '') {
  const text = String(xml || '')
  if (!text) return null
  const services = {}
  for (const match of text.matchAll(/<service>([\s\S]*?)<\/service>/gi)) {
    const block = match[1]
    const serviceType = xmlTag(block, 'serviceType')
    const control = xmlTag(block, 'controlURL')
    if (!serviceType || !control) continue
    const controlURL = resolveUrl(control, location)
    if (!controlURL) continue
    if (/AVTransport:\d+$/i.test(serviceType) && !services.avTransport) {
      services.avTransport = { serviceType, controlURL }
    } else if (/RenderingControl:\d+$/i.test(serviceType) && !services.renderingControl) {
      services.renderingControl = { serviceType, controlURL }
    }
  }
  return {
    friendlyName: xmlTag(text, 'friendlyName'),
    modelName: xmlTag(text, 'modelName'),
    manufacturer: xmlTag(text, 'manufacturer'),
    udn: xmlTag(text, 'UDN'),
    services,
  }
}

function buildDidl(title, url, mime) {
  return (
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    '<item id="0" parentID="-1" restricted="1">' +
    `<dc:title>${escapeXml(title || '视频')}</dc:title>` +
    '<upnp:class>object.item.videoItem</upnp:class>' +
    `<res protocolInfo="http-get:*:${escapeXml(mime)}:*">${escapeXml(url)}</res>` +
    '</item></DIDL-Lite>'
  )
}

// ---------------------------------------------------------------------------
// SSDP 发现
// ---------------------------------------------------------------------------

function parseSsdpHeaders(text) {
  const headers = {}
  for (const line of String(text || '').split(/\r?\n/)) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim()
  }
  return headers
}

/** 发出 M-SEARCH，收集同一局域网里的 MediaRenderer。 */
function discover({ timeout = SCAN_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    const found = new Map()
    let socket = null
    let done = false
    let timer = null

    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        /* 忽略 */
      }
      resolve([...found.values()])
    }

    try {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    } catch {
      resolve([])
      return
    }

    socket.on('error', () => finish())
    socket.on('message', (message, rinfo) => {
      const text = message.toString('utf8')
      if (!/^HTTP\/1\.1\s+\d{3}/i.test(text.trim())) return
      const headers = parseSsdpHeaders(text)
      const location = headers.location || ''
      if (!/^http:\/\//i.test(location)) return
      const key = headers.usn || location
      if (found.has(key)) return
      found.set(key, {
        location,
        usn: headers.usn || '',
        st: headers.st || '',
        server: headers.server || '',
        host: rinfo?.address || '',
      })
    })

    timer = setTimeout(finish, timeout)
    socket.bind(() => {
      try {
        socket.setMulticastTTL(4)
        socket.setBroadcast(true)
      } catch {
        /* 部分系统不允许，忽略 */
      }
      const request = Buffer.from(
        [
          'M-SEARCH * HTTP/1.1',
          `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
          'MAN: "ssdp:discover"',
          'MX: 3',
          'ST: ' + MEDIA_RENDERER,
          '',
          '',
        ].join('\r\n'),
        'utf8',
      )
      // 丢包很常见，隔 350ms 再发两次
      for (let index = 0; index < 3; index += 1) {
        setTimeout(() => {
          if (done) return
          try {
            socket.send(request, 0, request.length, SSDP_PORT, SSDP_ADDRESS)
          } catch {
            /* 忽略 */
          }
        }, index * 350)
      }
    })
  })
}

function publicDevice(device) {
  if (!device) return null
  return {
    id: device.id,
    name: device.name,
    model: device.model || '',
    manufacturer: device.manufacturer || '',
    host: device.host || '',
  }
}

// ---------------------------------------------------------------------------
// 投屏管理器
// ---------------------------------------------------------------------------

class CastManager {
  constructor({ log = () => {}, proxy = null, onState = () => {}, onDevices = () => {} } = {}) {
    this.log = log
    this.proxy = proxy
    this.onState = onState
    this.onDevices = onDevices
    this.devices = []
    this.device = null
    this.transportState = 'STOPPED'
    this.position = 0
    this.duration = 0
    this.volume = null
    this.mediaTitle = ''
    this.mediaUrl = ''
    this.mediaMime = 'video/mp4'
    this.scanning = false
    this.pollTimer = null
    this.pollBusy = false
    this.failures = 0
    this.lastError = ''
    this.lastScanAt = 0
  }

  // ---- 地址推导 ----

  /** 本地代理地址 → 局域网地址。只接受本机回环地址，避免把任意 URL 推给设备。 */
  localToLan(localUrl, remoteIp = '', mime = 'mp4') {
    let url = null
    try {
      url = new URL(String(localUrl))
    } catch {
      return ''
    }
    if (!/^(127\.0\.0\.1|localhost)$/i.test(url.hostname)) return ''
    const host = bestLocalAddress(remoteIp)
    if (!host) return ''
    url.hostname = host
    // 电视 / 机顶盒经常靠扩展名判断格式，这里带上 .m3u8 / .mp4
    if (mime === 'hls') url.pathname = '/stream.m3u8'
    else url.pathname = '/stream.mp4'
    return url.href
  }

  /** 大屏浏览器播放页地址。 */
  pageUrl(localUrl, { mime = 'mp4', title = '' } = {}) {
    const lan = this.localToLan(localUrl, '', mime)
    if (!lan) return ''
    let url = null
    try {
      url = new URL(lan)
    } catch {
      return ''
    }
    url.pathname = '/mirror'
    url.searchParams.set('ty', mime === 'hls' ? 'hls' : 'mp4')
    if (title) url.searchParams.set('n', title)
    return url.href
  }

  // ---- 发现 ----

  async scan({ timeout = SCAN_TIMEOUT } = {}) {
    if (this.scanning) return { ok: true, devices: this.devices.map(publicDevice), busy: true }
    this.scanning = true
    this.lastError = ''
    try {
      this.log('[投屏] 开始搜索局域网设备')
      const responses = await discover({ timeout })
      const ownHosts = new Set(lanAddresses().map((item) => item.address))
      const usable = responses.filter((item) => {
        const host = (() => {
          try {
            return new URL(item.location).hostname
          } catch {
            return ''
          }
        })()
        return host && !ownHosts.has(host)
      })
      const parsed = await Promise.all(
        usable.slice(0, 24).map(async (item) => {
          try {
            const result = await requestText(item.location, { timeout: 3500, maxBytes: 512 * 1024 })
            if (result.status !== 200) return null
            const info = parseDeviceDescription(result.body, item.location)
            if (!info || !info.services.avTransport) return null
            let host = ''
            try {
              host = new URL(item.location).hostname
            } catch {
              host = ''
            }
            const id = info.udn || item.usn || item.location
            return {
              id,
              name: info.friendlyName || info.modelName || host || '投屏设备',
              model: info.modelName || '',
              manufacturer: info.manufacturer || '',
              host: host || item.host,
              location: item.location,
              services: info.services,
            }
          } catch {
            return null
          }
        }),
      )
      const seen = new Set()
      this.devices = parsed.filter((item) => {
        if (!item || seen.has(item.id)) return false
        seen.add(item.id)
        return true
      })
      this.lastScanAt = Date.now()
      this.log(`[投屏] 搜索到 ${this.devices.length} 个可投屏设备`)
      const list = this.devices.map(publicDevice)
      this.onDevices(list)
      return { ok: true, devices: list, host: bestLocalAddress(''), scannedAt: this.lastScanAt }
    } catch (error) {
      this.lastError = String(error?.message || error)
      this.log(`[投屏] 搜索失败：${this.lastError}`)
      return { ok: false, error: '搜索设备失败，请确认电脑和电视在同一个 Wi-Fi 下', devices: this.devices.map(publicDevice) }
    } finally {
      this.scanning = false
    }
  }

  findDevice(deviceId) {
    if (deviceId) {
      const found = this.devices.find((item) => item.id === deviceId)
      if (found) return found
    }
    if (this.device) return this.device
    return this.devices[0] || null
  }

  // ---- 播放 ----

  async start({ url, title = '', mime = 'mp4', position = 0, deviceId = '' } = {}) {
    const device = this.findDevice(deviceId)
    if (!device) return { ok: false, error: '没有找到可投屏的设备，请先搜索设备' }
    const lan = this.localToLan(url, device.host, mime)
    if (!lan) {
      return { ok: false, error: '找不到局域网地址：请确认电脑连的是同一个 Wi-Fi，而不是只有回环网络' }
    }
    const protocolMime = mime === 'hls' ? 'application/vnd.apple.mpegurl' : 'video/mp4'
    const avt = device.services.avTransport
    this.device = device
    this.mediaTitle = String(title || '')
    this.mediaUrl = lan
    this.mediaMime = protocolMime
    this.position = Math.max(0, Number(position) || 0)
    this.transportState = 'TRANSITIONING'
    this.failures = 0
    this.lastError = ''
    this.emit()

    const didl = buildDidl(this.mediaTitle, lan, protocolMime)
    try {
      this.log(`[投屏] 推送到「${device.name}」：${lan.slice(0, 160)}`)
      try {
        await soapInvoke(avt, 'SetAVTransportURI', {
          InstanceID: 0,
          CurrentURI: lan,
          CurrentURIMetaData: didl,
        })
      } catch (error) {
        // 少数电视不接受 DIDL 元数据，退回空字符串再试一次
        this.log(`[投屏] 带元数据失败（${error?.message || error}），改用空元数据重试`)
        await soapInvoke(avt, 'SetAVTransportURI', { InstanceID: 0, CurrentURI: lan, CurrentURIMetaData: '' })
      }
      await soapInvoke(avt, 'Play', { InstanceID: 0, Speed: '1' })
      if (this.position > 5) {
        await soapInvoke(avt, 'Seek', {
          InstanceID: 0,
          Unit: 'REL_TIME',
          Target: formatOffset(this.position),
        })
      }
    } catch (error) {
      this.device = null
      this.transportState = 'STOPPED'
      this.lastError = String(error?.message || error)
      this.log(`[投屏] 推送失败：${this.lastError}`)
      this.emit()
      return { ok: false, error: `投屏失败：${this.lastError}` }
    }

    this.startPolling()
    setTimeout(() => this.refresh().catch(() => {}), 1500)
    return { ok: true, device: publicDevice(device), url: lan }
  }

  async control({ action = '', seconds = 0, volume = null } = {}) {
    if (!this.device) return { ok: false, error: '还没有投屏设备' }
    const avt = this.device.services.avTransport
    try {
      if (action === 'play') {
        await soapInvoke(avt, 'Play', { InstanceID: 0, Speed: '1' })
        this.transportState = 'PLAYING'
      } else if (action === 'pause') {
        await soapInvoke(avt, 'Pause', { InstanceID: 0 })
        this.transportState = 'PAUSED_PLAYBACK'
      } else if (action === 'toggle') {
        if (this.transportState === 'PLAYING' || this.transportState === 'TRANSITIONING') {
          await soapInvoke(avt, 'Pause', { InstanceID: 0 })
          this.transportState = 'PAUSED_PLAYBACK'
        } else {
          await soapInvoke(avt, 'Play', { InstanceID: 0, Speed: '1' })
          this.transportState = 'PLAYING'
        }
      } else if (action === 'seek') {
        const target = Math.max(0, Number(seconds) || 0)
        await soapInvoke(avt, 'Seek', { InstanceID: 0, Unit: 'REL_TIME', Target: formatOffset(target) })
        this.position = target
      } else if (action === 'volume') {
        const rcs = this.device.services.renderingControl
        if (!rcs) throw new Error('这台设备不支持音量控制')
        const level = Math.max(0, Math.min(100, Math.round(Number(volume) || 0)))
        await soapInvoke(rcs, 'SetVolume', { InstanceID: 0, Channel: 'Master', DesiredVolume: level })
        this.volume = level
      } else if (action === 'refresh') {
        await this.refresh()
        return { ok: true, state: this.snapshot() }
      } else {
        return { ok: false, error: '不支持的投屏操作' }
      }
      this.emit()
      setTimeout(() => this.refresh().catch(() => {}), 900)
      return { ok: true, state: this.snapshot() }
    } catch (error) {
      this.lastError = String(error?.message || error)
      this.log(`[投屏] 控制 ${action} 失败：${this.lastError}`)
      return { ok: false, error: this.lastError }
    }
  }

  async stopCasting() {
    const device = this.device
    if (device) {
      const avt = device.services.avTransport
      try {
        await soapInvoke(avt, 'Stop', { InstanceID: 0 }, { timeout: 3000 })
      } catch {
        /* 设备可能已经停了，忽略 */
      }
      try {
        await soapInvoke(avt, 'SetAVTransportURI', { InstanceID: 0, CurrentURI: '', CurrentURIMetaData: '' }, { timeout: 3000 })
      } catch {
        /* 忽略 */
      }
      this.log(`[投屏] 已停止「${device.name}」`)
    }
    this.device = null
    this.transportState = 'STOPPED'
    this.position = 0
    this.duration = 0
    this.mediaTitle = ''
    this.mediaUrl = ''
    this.lastError = ''
    this.failures = 0
    this.stopPolling()
    this.emit()
    return { ok: true }
  }

  // ---- 状态 ----

  async refresh() {
    if (!this.device || this.pollBusy) return
    this.pollBusy = true
    const avt = this.device.services.avTransport
    try {
      const info = await soapInvoke(avt, 'GetTransportInfo', { InstanceID: 0 }, { timeout: 3500 })
      this.transportState = xmlTag(info, 'CurrentTransportState') || this.transportState
      const position = await soapInvoke(avt, 'GetPositionInfo', { InstanceID: 0 }, { timeout: 3500 })
      const rel = parseOffset(xmlTag(position, 'RelTime'))
      const duration = parseOffset(xmlTag(position, 'TrackDuration'))
      if (Number.isFinite(rel) && rel > 0) this.position = rel
      if (Number.isFinite(duration) && duration > 0) this.duration = duration
      this.failures = 0
      this.lastError = ''
    } catch (error) {
      this.failures += 1
      if (this.failures >= 3) {
        this.lastError = '电视没有响应，可能已关机或退出投屏'
        this.stopPolling()
      }
      this.log(`[投屏] 状态读取失败（${this.failures}）：${error?.message || error}`)
    } finally {
      this.pollBusy = false
      this.emit()
    }
  }

  startPolling() {
    this.stopPolling()
    this.pollTimer = setInterval(() => {
      this.refresh().catch(() => {})
    }, POLL_INTERVAL)
  }

  stopPolling() {
    if (!this.pollTimer) return
    clearInterval(this.pollTimer)
    this.pollTimer = null
  }

  snapshot() {
    return {
      ok: true,
      casting: Boolean(this.device),
      device: publicDevice(this.device),
      transportState: this.transportState,
      position: Math.round(this.position * 10) / 10,
      duration: Math.round(this.duration),
      volume: this.volume,
      title: this.mediaTitle,
      note: this.lastError,
      devices: this.devices.map(publicDevice),
      host: bestLocalAddress(''),
      scanning: this.scanning,
      scannedAt: this.lastScanAt,
    }
  }

  emit() {
    try {
      this.onState(this.snapshot())
    } catch {
      /* 忽略 */
    }
  }

  dispose() {
    this.stopPolling()
    this.device = null
  }
}

module.exports = {
  CastManager,
  MEDIA_RENDERER,
  SOAP_AVTRANSPORT: 'urn:schemas-upnp-org:service:AVTransport:1',
  lanAddresses,
  bestLocalAddress,
  inSameSubnet,
  isPrivateIPv4,
  formatOffset,
  parseOffset,
  parseDeviceDescription,
  buildSoapEnvelope,
  buildDidl,
  escapeXml,
  discover,
}
