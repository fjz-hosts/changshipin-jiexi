'use strict'

/**
 * 平台原生解析（按 yt-dlp 的官方接口流程移植，不依赖第三方解析站）。
 *
 * 目前可用：
 *  - 腾讯视频（v.qq.com）：yt-dlp tencent.py 的 getvinfo / cKey(HLS) 流程。
 *    电影、电视剧、动漫、纪录片都走同一套接口，只要链接里能取到 vid；
 *    免费内容一般给 480P/720P HLS，登录会员后接口会按账号权限下发更高清晰度。
 *
 * yt-dlp 当前无法原生解析：
 *  - 爱奇艺：新版播放页是动态渲染，yt-dlp 的 IqiyiIE 找不到 tvid/vid；
 *    真正的播放地址由页面里的 cmd5x 签名接口下发，旧接口已返回 A00011。
 *  - 优酷：yt-dlp 仍走 ups.youku.com/ups/get.json，但该接口对匿名设备/账号
 *    普遍返回 -6004「该账号检测到有可疑违规、侵权等行为」，网页端也只给试看。
 *
 * 因此这里只对腾讯视频启用真实取流；另外两家返回明确原因，交给第三方线路兜底。
 */

const crypto = require('node:crypto')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'

const QQ_APP_VERSION = '3.5.57'
const QQ_PLATFORM = '10901'
const QQ_HOST = 'v.qq.com'
const QQ_REFERER = 'v.qq.com'
const QQ_API = 'https://h5vv6.video.qq.com/getvinfo'

// 与 yt-dlp 的 aes_cbc_encrypt_bytes(padding_mode='whitespace') 一致
const QQ_CKEY_KEY = Buffer.from('Ok\xda\xa3\x9e/\x8c\xb0\x7f^r-\x9e\xde\xf3\x14', 'latin1')
const QQ_CKEY_IV = Buffer.from('\x01PJ\xf3V\xe6\x19\xcf.B\xbb\xa6\x8c?p\xf9', 'latin1')
const QQ_RANDOM = '0123456789abcdefghijklmnopqrstuvwxyz'

function randomText(length) {
  let out = ''
  for (let index = 0; index < length; index += 1) {
    out += QQ_RANDOM[Math.floor(Math.random() * QQ_RANDOM.length)]
  }
  return out
}

function qqVideoIds(videoUrl) {
  const raw = String(videoUrl || '')
  const idMatch = raw.match(/\/([A-Za-z0-9]+)\.html(?:[?#]|$)/)
  const coverMatch = raw.match(/\/x\/cover\/([A-Za-z0-9]+)\//)
  return {
    videoId: idMatch ? idMatch[1] : '',
    seriesId: coverMatch ? coverMatch[1] : '',
  }
}

// yt-dlp: payload = f'{vid}|{ts}|mg3c3b04ba|{appVer}|{guid}|{platform}|{url[:48]}|{ua.lower()[:48]}||Mozilla|...'
// 再拼上 |{sum(ord)}|{payload}，AES-CBC + 空格补齐，输出大写 hex。
function buildTencentCkey(videoId, videoUrl, guid) {
  const payload = `${videoId}|${Math.floor(Date.now() / 1000)}|mg3c3b04ba|${QQ_APP_VERSION}|${guid}|${QQ_PLATFORM}|${String(
    videoUrl,
  ).slice(0, 48)}|${UA.toLowerCase().slice(0, 48)}||Mozilla|Netscape|Windows x86_64|00|`
  const sum = [...payload].reduce((total, char) => total + char.codePointAt(0), 0)
  const data = Buffer.from(`|${sum}|${payload}`, 'utf8')
  const padding = 16 - (data.length % 16)
  const padded = Buffer.concat([data, Buffer.alloc(padding, 0x20)])
  const cipher = crypto.createCipheriv('aes-128-cbc', QQ_CKEY_KEY, QQ_CKEY_IV)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('hex').toUpperCase()
}

function parseQzOutputJson(text) {
  const marker = 'QZOutputJson='
  const index = String(text || '').indexOf(marker)
  if (index < 0) throw new Error('腾讯视频接口返回格式异常')
  return JSON.parse(String(text).slice(index + marker.length).replace(/;\s*$/, ''))
}

async function fetchTencentVin({ videoUrl, videoId, seriesId, defn, cookie = '' }) {
  const guid = randomText(16)
  const query = new URLSearchParams({
    vid: videoId,
    cid: seriesId,
    cKey: buildTencentCkey(videoId, videoUrl, guid),
    encryptVer: '8.1',
    spcaptiontype: '0',
    sphls: '2',
    dtype: '3',
    defn,
    spsrt: '2',
    sphttps: '1',
    otype: 'json',
    spwm: '1',
    hevclv: '28',
    drm: '40',
    spvideo: '4',
    spsfrhdr: '100',
    host: QQ_HOST,
    referer: QQ_REFERER,
    ehost: videoUrl,
    appVer: QQ_APP_VERSION,
    platform: QQ_PLATFORM,
    guid,
    flowid: randomText(32),
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    const response = await fetch(`${QQ_API}?${query}`, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'user-agent': UA,
        referer: 'https://v.qq.com/',
        origin: 'https://v.qq.com',
        accept: '*/*',
        ...(cookie ? { cookie } : {}),
      },
    })
    const text = await response.text()
    return { ok: response.ok, status: response.status, json: parseQzOutputJson(text), text }
  } finally {
    clearTimeout(timer)
  }
}

function tencentQuality(detail) {
  const vi = detail?.vl?.vi?.[0] || {}
  const rows = Array.isArray(detail?.fl?.fi) ? detail.fl.fi : []
  const row = rows.find((item) => String(item?.br) === String(vi.br)) || {}
  return {
    height: Number(vi.vh) || 0,
    width: Number(vi.vw) || 0,
    drm: Number(row.drm) > 0,
    name: row.name || '',
    resolution: row.resolution || '',
    fileFormat: row.ftype || '',
  }
}

function pickTencentStream(vi) {
  const uis = Array.isArray(vi?.ul?.ui) ? vi.ul.ui : []
  // HLS：yt-dlp 用 url + hls.pt；部分剧集直接把 .m3u8 放在 url 里
  const hls = uis.find((item) => item?.hls?.pt) || uis.find((item) => /\.m3u8([?#]|$)/i.test(item?.url || ''))
  if (hls) {
    return {
      streamUrl: hls.hls?.pt ? `${hls.url}${hls.hls.pt}` : hls.url,
      kind: 'hls',
    }
  }
  const mp4 = uis.find((item) => /\.mp4([?#]|$)/i.test(item?.url || ''))
  if (mp4) {
    const suffix = vi.fvkey ? `?vkey=${encodeURIComponent(vi.fvkey)}` : ''
    return { streamUrl: `${mp4.url}${vi.fn || ''}${suffix}`, kind: 'file' }
  }
  // 短视频 / UGC 常见：base url + fn + vkey，是整段 TS/MP4
  if (uis[0]?.url && vi.fn) {
    const suffix = vi.fvkey ? `?vkey=${encodeURIComponent(vi.fvkey)}` : ''
    return { streamUrl: `${uis[0].url}${vi.fn}${suffix}`, kind: 'file' }
  }
  return null
}

function tencentError(detail) {
  const message = String(detail?.msg || detail?.err_msg || '').trim()
  if (/区域|地区|版权|country|region/i.test(message)) {
    return `腾讯视频提示地区/版权限制（需要在中国大陆网络下使用）${message ? `：${message}` : ''}`
  }
  if (/会员|vip|付费|购买|登录|权限|无权/i.test(message)) {
    return `腾讯视频提示：${message}（需要登录会员或购买后才能看完整版）`
  }
  return `腾讯视频接口返回失败${message ? `：${message}` : ''}`
}

async function extractTencent({ url, cookie = '' }) {
  const videoUrl = String(url || '').trim()
  const { videoId, seriesId } = qqVideoIds(videoUrl)
  if (!videoId) return { kind: 'none', error: '无法从链接中识别腾讯视频 vid（支持 /x/cover/xxx/yyy.html 和 /x/page/yyy.html）' }

  let detail = null
  try {
    const base = await fetchTencentVin({ videoUrl, videoId, seriesId, defn: 'hd', cookie })
    if (!base.json || base.json.code !== '0.0') {
      return { kind: 'none', error: tencentError(base.json || {}) }
    }
    detail = base.json
  } catch (error) {
    return { kind: 'none', error: `腾讯视频接口请求失败：${String(error?.message || error).slice(0, 80)}` }
  }

  // 尽量拿更高清晰度：先 shd（720P）再 fhd（1080P）；会员/付费限制时自动退回 hd。
  const qualityNames = (Array.isArray(detail.fl?.fi) ? detail.fl.fi : []).map((item) => String(item?.name || ''))
  const higher = ['fhd', 'shd'].filter((name) => qualityNames.includes(name))
  for (const defn of higher) {
    try {
      const candidate = await fetchTencentVin({ videoUrl, videoId, seriesId, defn, cookie })
      const candidateVi = candidate.json?.vl?.vi?.[0]
      const candidateQuality = tencentQuality(candidate.json)
      // 高清档可能是 DRM / 会员专用：这种不要覆盖已经拿到的免费档，否则会把能播的 480P 也丢掉。
      if (
        candidate.json?.code === '0.0' &&
        candidateVi &&
        !candidateQuality.drm &&
        pickTencentStream(candidateVi)
      ) {
        detail = candidate.json
        break
      }
    } catch {
      /* 高清失败就用已拿到的 hd */
    }
  }

  const vi = detail?.vl?.vi?.[0] || {}
  const quality = tencentQuality(detail)
  if (quality.drm) {
    return {
      kind: 'none',
      error: `腾讯视频返回的是 DRM 加密流（${quality.resolution || quality.name || '会员/付费内容'}），内置播放器不支持，请使用第三方线路或官网观看`,
    }
  }
  const picked = pickTencentStream(vi)
  if (!picked) {
    return { kind: 'none', error: '腾讯视频没有返回可播放地址（可能需要登录会员；付费/云影院内容只给试看）' }
  }

  return {
    kind: 'stream',
    streamUrl: picked.streamUrl,
    referer: 'https://v.qq.com/',
    title: String(vi.ti || '').trim(),
    duration: Number(vi.td) || 0,
    note: `${quality.resolution || (quality.height ? `${quality.height}P` : 'HLS')}${picked.kind === 'hls' ? ' · HLS' : ''}`,
  }
}

const UNSUPPORTED = {
  iqiyi:
    '爱奇艺暂不支持 yt-dlp 原生解析：新版播放页由 cmd5x 签名接口下发地址，yt-dlp 的 IqiyiIE 已找不到 tvid/vid（旧接口返回 A00011）',
  youku:
    '优酷暂不支持 yt-dlp 原生解析：ups.youku.com 对匿名设备返回 -6004（账号/设备被限制播放），网页端匿名只给试看',
}

async function parseNative({ url, platform, cookie = '' }) {
  const key = String(platform || '').trim()
  if (!url || !/^https?:\/\//i.test(String(url))) return { kind: 'none', error: '视频链接格式不正确' }
  if (key === 'qq') return extractTencent({ url, cookie })
  if (UNSUPPORTED[key]) return { kind: 'none', error: UNSUPPORTED[key] }
  return { kind: 'none', error: '这个平台还没有可用的原生解析' }
}

module.exports = {
  parseNative,
  extractTencent,
  buildTencentCkey,
  pickTencentStream,
  UNSUPPORTED,
}
