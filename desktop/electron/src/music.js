'use strict'

/**
 * 音乐解析（酷我 / 酷狗 / QQ音乐 / 网易云 / 汽水音乐）。
 *
 * 设计原则和短视频一致：先用平台公开接口拿「搜索结果 + 播放直链 + 歌词」，
 * 直链再交给本地代理播放 / 下载。平台接口要会员时，会尝试用同一首歌在酷我
 * 找一条可播放的替代音源；用户也可以在内置窗口登录平台会员账号后重试。
 *
 * 汽水音乐网页版不开放搜索，只提供分享页；分享页默认只给 30 秒试听。
 * 因此汽水这里做成「粘贴分享链接解析」，并自动尝试用歌名 + 歌手换源。
 */

const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const crypto = require('node:crypto')
const { sanitizeFileName } = require('./download')

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'

const MUSIC_PLATFORMS = [
  {
    key: 'kuwo',
    name: '酷我音乐',
    short: '酷我',
    color: '#ffcc33',
    home: 'https://www.kuwo.cn/',
    loginUrl: 'https://www.kuwo.cn/',
    partition: 'persist:music-kuwo',
    searchable: true,
    hint: '搜索歌曲 / 歌手 / 专辑',
    note: '免费歌曲直接播放；会员歌曲可登录酷我账号后重试。',
  },
  {
    key: 'kugou',
    name: '酷狗音乐',
    short: '酷狗',
    color: '#2ca2f9',
    home: 'https://www.kugou.com/',
    loginUrl: 'https://www.kugou.com/',
    partition: 'persist:music-kugou',
    searchable: true,
    hint: '搜索歌曲 / 歌手 / 专辑',
    note: '高音质 / 会员歌曲可登录酷狗账号；没有权限时会自动尝试其它音源。',
  },
  {
    key: 'qq',
    name: 'QQ音乐',
    short: 'QQ',
    color: '#31c27c',
    home: 'https://y.qq.com/',
    loginUrl: 'https://y.qq.com/',
    partition: 'persist:music-qq',
    searchable: true,
    hint: '搜索歌曲 / 歌手 / 专辑',
    note: 'VIP 歌曲可登录 QQ 音乐账号；未登录时只尝试免费音源。',
  },
  {
    key: 'netease',
    name: '网易云音乐',
    short: '网易云',
    color: '#e60026',
    home: 'https://music.163.com/',
    loginUrl: 'https://music.163.com/',
    partition: 'persist:music-netease',
    searchable: true,
    hint: '搜索歌曲 / 歌手 / 专辑',
    note: 'VIP / 版权歌曲可登录网易云账号；未登录时只尝试免费音源。',
  },
  {
    key: 'qishui',
    name: '汽水音乐',
    short: '汽水',
    color: '#00d6c9',
    home: 'https://music.douyin.com/qishui/',
    loginUrl: '',
    partition: 'persist:music-qishui',
    searchable: false,
    hint: '粘贴汽水分享链接（歌曲分享 → 复制链接）',
    note: '汽水网页版不开放搜索；分享页只给 30 秒试听，完整版会尝试按歌名 + 歌手换源。',
  },
]

const platformByKey = (key) => MUSIC_PLATFORMS.find((item) => item.key === key) || null

function clean(value, max = 300) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max)
}

function stripBom(text) {
  return String(text || '').replace(/^\uFEFF/, '')
}

// LRC 依赖换行；不能用 clean()，它会把 \n 压成空格，导致整首歌词挤成一行。
function cleanLyric(value, max = 200000) {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max)
}

function normalizeMatch(value) {
  return clean(value, 200)
    .toLowerCase()
    .replace(/[\s\-_/\\()（）【】[\]「」《》·.,，。!！?？'"“”‘’+:：;；]/g, '')
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// HTTP：统一带 UA / Referer / Cookie，允许酷狗旧 CDN 的证书异常
// ---------------------------------------------------------------------------

function request(target, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    timeout = 20000,
    redirect = 5,
  } = options
  return new Promise((resolve, reject) => {
    let url
    try {
      url = new URL(String(target))
    } catch {
      reject(new Error('地址格式不正确'))
      return
    }
    if (!/^https?:$/.test(url.protocol)) {
      reject(new Error('不支持的协议'))
      return
    }
    const mod = url.protocol === 'https:' ? https : http
    const req = mod.request(
      url,
      {
        method,
        rejectUnauthorized: false,
        timeout,
        headers: {
          'user-agent': UA,
          accept: 'application/json, text/plain, */*',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
          ...headers,
        },
      },
      (res) => {
        const location = res.headers.location
        if (location && [301, 302, 303, 307, 308].includes(res.statusCode) && redirect > 0) {
          res.resume()
          const next = new URL(location, url).href
          const nextMethod = res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && method === 'POST') ? 'GET' : method
          resolve(request(next, { ...options, method: nextMethod, body: nextMethod === 'GET' ? null : body, redirect: redirect - 1 }))
          return
        }
        const chunks = []
        let size = 0
        res.on('data', (chunk) => {
          size += chunk.length
          // 搜索结果 / 歌词接口不会太大；防止异常站点无限返回
          if (size <= 8 * 1024 * 1024) chunks.push(chunk)
        })
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        })
      },
    )
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

async function requestText(target, options = {}) {
  const result = await request(target, options)
  return { ...result, text: stripBom(result.body.toString('utf8')) }
}

async function requestJson(target, options = {}) {
  const result = await requestText(target, options)
  let json = null
  try {
    json = JSON.parse(result.text)
  } catch {
    /* 非 JSON */
  }
  return { ...result, json }
}

function cookieHeader(cookie) {
  return cookie ? { cookie } : {}
}

function firstMatch(text, regex, index = 1) {
  const match = String(text || '').match(regex)
  return match ? match[index] : ''
}

// ---------------------------------------------------------------------------
// 网易云
// ---------------------------------------------------------------------------

const NETEASE_HEADERS = {
  referer: 'https://music.163.com/',
  origin: 'https://music.163.com',
  cookie: 'os=pc; appver=2.9.7;',
}

async function neteaseSearch(keyword, { cookie = '' } = {}) {
  const url =
    'https://music.163.com/api/search/get/web?csrf_token=&s=' +
    encodeURIComponent(keyword) +
    '&type=1&offset=0&total=true&limit=30'
  const result = await requestJson(url, {
    headers: { ...NETEASE_HEADERS, ...cookieHeader(cookie) },
  })
  if (!result.json) throw new Error(`网易云搜索失败（HTTP ${result.status}）`)
  const list = result.json?.result?.songs || []
  return list.map((song) => {
    const album = song.album || song.al || {}
    const artists = song.artists || song.ar || []
    return {
      platform: 'netease',
      platformName: '网易云音乐',
      id: String(song.id),
      title: clean(song.name, 150),
      artist: clean(artists.map((item) => item.name).filter(Boolean).join(' / '), 150),
      album: clean(album.name, 120),
      cover: clean(album.picUrl || album.pic_url || '', 1000),
      duration: Math.round((Number(song.duration || song.dt) || 0) / 1000),
      vip: Number(song.fee) !== 0 && Number(song.fee) !== 8,
      raw: {
        fee: song.fee,
        privilege: song.privilege || null,
        albumMid: album.picId || '',
      },
    }
  })
}

async function neteaseResolve(song, { quality = '320', format = 'mp3', cookie = '' } = {}) {
  const level = format === 'flac' || quality === 'flac' ? 'lossless' : quality === '128' ? 'standard' : 'exhigh'
  const url =
    `https://music.163.com/api/song/enhance/player/url/v1?ids=[${encodeURIComponent(song.id)}]` +
    `&level=${level}&encodeType=flac`
  const result = await requestJson(url, {
    headers: { ...NETEASE_HEADERS, ...cookieHeader(cookie) },
  })
  if (!result.json) throw new Error(`网易云取流失败（HTTP ${result.status}）`)
  const data = result.json?.data?.[0] || {}
  if (!data.url) {
    const reason = data?.freeTrialPrivilege?.cannotListenReason
    const error = new Error(
      reason === 1 || Number(data.fee) ? '这首网易云歌曲需要会员或购买版权后才能播放' : '网易云没有返回可播放地址',
    )
    error.code = 'vip'
    throw error
  }
  let actualFormat = String(data.type || '').toLowerCase()
  if (actualFormat !== 'flac') actualFormat = 'mp3'
  const lyric = await neteaseLyric(song.id, cookie)
  return {
    playUrl: data.url,
    format: actualFormat,
    bitrate: Number(data.br) || 0,
    size: Number(data.size) || 0,
    referer: 'https://music.163.com/',
    cookie,
    duration: song.duration || 0,
    lyric: lyric.lyric,
    translation: lyric.translation,
    note:
      format === 'flac' && actualFormat !== 'flac'
        ? '当前账号没有无损权限，已改用 320K MP3'
        : '',
  }
}

async function neteaseLyric(id, cookie = '') {
  try {
    const result = await requestJson(
      `https://music.163.com/api/song/lyric?id=${encodeURIComponent(id)}&lv=1&kv=1&tv=-1`,
      { headers: { ...NETEASE_HEADERS, ...cookieHeader(cookie) } },
    )
    return {
      lyric: cleanLyric(result.json?.lrc?.lyric || ''),
      translation: cleanLyric(result.json?.tlyric?.lyric || ''),
    }
  } catch {
    return { lyric: '', translation: '' }
  }
}

// ---------------------------------------------------------------------------
// QQ 音乐
// ---------------------------------------------------------------------------

const QQ_HEADERS = {
  referer: 'https://y.qq.com/',
  origin: 'https://y.qq.com',
}

async function qqSearch(keyword, { cookie = '' } = {}) {
  const url =
    'https://c.y.qq.com/soso/fcgi-bin/client_search_cp?p=1&n=30&w=' +
    encodeURIComponent(keyword) +
    '&format=json&cr=1&new_json=1'
  const result = await requestJson(url, {
    headers: { ...QQ_HEADERS, ...cookieHeader(cookie) },
  })
  if (!result.json) throw new Error(`QQ音乐搜索失败（HTTP ${result.status}）`)
  const list = result.json?.data?.song?.list || []
  return list.map((song) => {
    const album = song.album || {}
    const singers = song.singer || []
    return {
      platform: 'qq',
      platformName: 'QQ音乐',
      id: String(song.mid || song.songmid || ''),
      title: clean(song.name || song.songname, 150),
      artist: clean(singers.map((item) => item.name).filter(Boolean).join(' / '), 150),
      album: clean(album.name || song.albumname, 120),
      cover: album.mid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${album.mid}.jpg` : '',
      duration: Number(song.interval) || 0,
      vip: Number(song?.pay?.pay_play) === 1 || Boolean(song?.action?.msgpay),
      raw: {
        mediaMid: song?.file?.media_mid || song.mid,
        size128: Number(song?.file?.size_128mp3) || 0,
        size320: Number(song?.file?.size_320mp3) || 0,
        sizeFlac: Number(song?.file?.size_flac) || 0,
        pay: song.pay || null,
      },
    }
  }).filter((song) => song.id && song.title)
}

async function qqResolve(song, { quality = '320', format = 'mp3', cookie = '' } = {}) {
  const mediaMid = song.raw?.mediaMid || song.id
  const guid = String(Math.floor(Math.random() * 9000000000) + 1000000000)
  const uin = firstMatch(cookie, /(?:^|;\s*)uin=([^;]+)/) || '0'
  const filenames = []
  if (format === 'flac' || quality === 'flac') filenames.push(`F000${mediaMid}${mediaMid}.flac`)
  else if (quality === '128') filenames.push(`M500${mediaMid}${mediaMid}.mp3`)
  else filenames.push(`M800${mediaMid}${mediaMid}.mp3`)
  const payload = {
    req_0: {
      module: 'vkey.GetVkeyServer',
      method: 'CgiGetVkey',
      param: {
        guid,
        songmid: [song.id],
        songtype: [0],
        uin,
        loginflag: 1,
        platform: '20',
        filename: filenames,
      },
    },
    comm: { uin: Number(uin) || 0, format: 'json', ct: 24, cv: 0 },
  }
  const url =
    'https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&data=' +
    encodeURIComponent(JSON.stringify(payload))
  const result = await requestJson(url, {
    headers: { ...QQ_HEADERS, ...cookieHeader(cookie) },
  })
  if (!result.json) throw new Error(`QQ音乐取流失败（HTTP ${result.status}）`)
  const data = result.json?.req_0?.data || {}
  const info = data?.midurlinfo?.[0] || {}
  if (!info.purl) {
    const error = new Error('这首 QQ 音乐歌曲需要登录会员或购买后才能播放')
    error.code = 'vip'
    throw error
  }
  const sip = data?.sip?.[0] || 'https://ws.stream.qqmusic.qq.com/'
  const lyric = await qqLyric(song.id, cookie)
  const lower = String(info.filename || info.purl).toLowerCase()
  return {
    playUrl: sip + info.purl,
    format: lower.includes('.flac') ? 'flac' : lower.includes('.mp3') ? 'mp3' : 'm4a',
    bitrate: quality === '128' ? 128000 : 320000,
    size: 0,
    referer: 'https://y.qq.com/',
    cookie,
    duration: song.duration || 0,
    lyric: lyric.lyric,
    translation: lyric.translation,
    note: '',
  }
}

async function qqLyric(songmid, cookie = '') {
  try {
    const result = await requestJson(
      `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(songmid)}&format=json&nobase64=1`,
      { headers: { ...QQ_HEADERS, ...cookieHeader(cookie) } },
    )
    return {
      lyric: cleanLyric(result.json?.lyric || ''),
      translation: cleanLyric(result.json?.trans || ''),
    }
  } catch {
    return { lyric: '', translation: '' }
  }
}

// ---------------------------------------------------------------------------
// 酷狗
// ---------------------------------------------------------------------------

async function kugouSearch(keyword, { cookie = '' } = {}) {
  const url =
    'https://songsearch.kugou.com/song_search_v2?keyword=' +
    encodeURIComponent(keyword) +
    '&page=1&pagesize=30&platform=WebFilter&userid=0&clientver=2000'
  const result = await requestJson(url, {
    headers: { referer: 'https://www.kugou.com/', ...cookieHeader(cookie) },
  })
  if (!result.json) throw new Error(`酷狗搜索失败（HTTP ${result.status}）`)
  const list = result.json?.data?.lists || []
  return list.map((song) => ({
    platform: 'kugou',
    platformName: '酷狗音乐',
    id: String(song.FileHash || ''),
    title: clean(song.SongName, 150),
    artist: clean(song.SingerName, 150),
    album: clean(song.AlbumName, 120),
    cover: clean(String(song.Image || song.trans_param?.union_cover || '').replace('{size}', '240'), 1000),
    duration: Number(song.Duration) || 0,
    vip: Number(song.Privilege) !== 0 || Number(song.PayType) === 3,
    raw: {
      hash128: song.FileHash,
      hash320: song.HQFileHash,
      hashFlac: song.SQFileHash,
      mixSongId: song.MixSongID,
      albumId: song.AlbumID,
      payType: song.PayType,
      privilege: song.Privilege,
    },
  })).filter((song) => song.id && song.title)
}

async function kugouResolve(song, { quality = '320', format = 'mp3', cookie = '' } = {}) {
  const hash =
    format === 'flac' || quality === 'flac'
      ? song.raw?.hashFlac || song.raw?.hash320 || song.id
      : quality === '128'
        ? song.id
        : song.raw?.hash320 || song.id
  const mid = firstMatch(cookie, /(?:^|;\s*)kg_mid=([^;]+)/) || crypto.createHash('md5').update(`music-${Date.now()}`).digest('hex')
  const dfid = firstMatch(cookie, /(?:^|;\s*)kg_dfid=([^;]+)/) || mid.slice(0, 20)
  const url =
    `https://wwwapi.kugou.com/yy/index.php?r=play/getdata&hash=${encodeURIComponent(hash)}` +
    `&album_id=${encodeURIComponent(song.raw?.albumId || '')}&dfid=${encodeURIComponent(dfid)}` +
    `&mid=${encodeURIComponent(mid)}&platid=4`
  const web = await requestJson(url, {
    headers: {
      referer: 'https://www.kugou.com/',
      cookie: cookie || `kg_mid=${mid}; kg_dfid=${dfid};`,
    },
  }).catch(() => null)
  let playUrl = clean(web?.json?.data?.play_url, 2000)
  let lyricText = cleanLyric(web?.json?.data?.lyrics)
  if (!playUrl) {
    const mobile = await requestJson(
      `https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${encodeURIComponent(hash)}`,
      { headers: { referer: 'https://m.kugou.com/', ...cookieHeader(cookie) } },
    ).catch(() => null)
    playUrl = clean(mobile?.json?.url, 2000)
    lyricText = lyricText || cleanLyric(mobile?.json?.lyrics)
  }
  if (!playUrl) {
    const error = new Error('这首酷狗歌曲需要登录会员或购买后才能播放')
    error.code = 'vip'
    throw error
  }
  const lower = playUrl.toLowerCase()
  const lyric = lyricText ? { lyric: lyricText, translation: '' } : await kugouLyric(hash, cookie)
  return {
    playUrl,
    format: lower.includes('.flac') ? 'flac' : lower.includes('.m4a') ? 'm4a' : 'mp3',
    bitrate: format === 'flac' ? 999000 : quality === '128' ? 128000 : 320000,
    size: 0,
    referer: 'https://www.kugou.com/',
    cookie,
    duration: song.duration || 0,
    lyric: lyric.lyric,
    translation: lyric.translation,
    note: format === 'flac' && !lower.includes('.flac') ? '没有无损音源，已改用 320K MP3' : '',
  }
}

async function kugouLyric(hash, cookie = '') {
  try {
    const search = await requestJson(
      `https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=&duration=&hash=${encodeURIComponent(hash)}&album_audio_id=`,
      { headers: { referer: 'https://www.kugou.com/', ...cookieHeader(cookie) } },
    )
    const candidate = search.json?.candidates?.[0]
    if (!candidate) return { lyric: '', translation: '' }
    const download = await requestJson(
      `https://lyrics.kugou.com/download?ver=1&client=pc&id=${encodeURIComponent(candidate.id)}` +
        `&accesskey=${encodeURIComponent(candidate.accesskey)}&fmt=lrc&charset=utf8`,
      { headers: { referer: 'https://www.kugou.com/', ...cookieHeader(cookie) } },
    )
    const content = download.json?.content
    if (!content) return { lyric: '', translation: '' }
    return { lyric: stripBom(Buffer.from(content, 'base64').toString('utf8')), translation: '' }
  } catch {
    return { lyric: '', translation: '' }
  }
}

// ---------------------------------------------------------------------------
// 酷我
// ---------------------------------------------------------------------------

async function kuwoSearch(keyword, { cookie = '' } = {}) {
  const url =
    'http://search.kuwo.cn/r.s?client=kt&all=' +
    encodeURIComponent(keyword) +
    '&pn=0&rn=30&uid=0&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1' +
    '&newver=1&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&mobi=1'
  const result = await requestText(url, {
    headers: { referer: 'http://www.kuwo.cn/', ...cookieHeader(cookie) },
  })
  let json = null
  try {
    json = JSON.parse(stripBom(result.text))
  } catch {
    throw new Error(`酷我搜索失败（HTTP ${result.status}）`)
  }
  const list = json?.abslist || []
  return list.map((song) => {
    const rid = String(song.MUSICRID || song.DC_TARGETID || '').replace(/^MUSIC_/, '')
    const picShort = clean(song.web_albumpic_short, 500)
    const payInfo = song.payInfo || {}
    return {
      platform: 'kuwo',
      platformName: '酷我音乐',
      id: rid,
      title: clean(song.NAME || song.SONGNAME, 150),
      artist: clean(song.ARTIST || song.FARTIST, 150),
      album: clean(song.ALBUM, 120),
      cover: picShort ? `https://img1.kuwo.cn/star/albumcover/${picShort}` : '',
      duration: Number(song.DURATION) || 0,
      vip:
        String(payInfo?.paytype || '') === '3' ||
        String(payInfo?.feeType?.vip || '') === '1' ||
        String(payInfo?.feeType?.song || '') === '1',
      raw: {
        minfo: song.MINFO || '',
        payInfo,
      },
    }
  }).filter((song) => song.id && song.title)
}

async function kuwoResolve(song, { quality = '320', format = 'mp3', cookie = '' } = {}) {
  const reqId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
  const url =
    `https://www.kuwo.cn/openapi/v1/www/music/playUrl?mid=${encodeURIComponent(song.id)}` +
    `&type=music&httpsStatus=1&reqId=${encodeURIComponent(reqId)}&plat=web_www&from=`
  const result = await requestJson(url, {
    headers: {
      referer: `https://www.kuwo.cn/play_detail/${song.id}`,
      ...cookieHeader(cookie),
    },
  })
  const data = result.json?.data || {}
  if (!data.url) {
    const error = new Error(clean(result.json?.msg, 120) || '这首酷我歌曲需要会员或购买后才能播放')
    error.code = 'vip'
    throw error
  }
  const lyric = await kuwoLyric(song.id, cookie)
  const lower = String(data.url).toLowerCase()
  const bitrate = lower.includes('.flac')
    ? 999000
    : /m800|320/.test(lower)
      ? 320000
      : /m500|128/.test(lower)
        ? 128000
        : quality === '128'
          ? 128000
          : 320000
  return {
    playUrl: data.url,
    format: lower.includes('.flac') ? 'flac' : 'mp3',
    bitrate,
    size: 0,
    referer: 'https://www.kuwo.cn/',
    cookie,
    duration: song.duration || 0,
    lyric: lyric.lyric,
    translation: '',
    note: format === 'flac' ? '酷我网页版没有无损直链，已改用 MP3' : '',
  }
}

async function kuwoLyric(id, cookie = '') {
  try {
    const result = await requestJson(
      `https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${encodeURIComponent(id)}`,
      { headers: { referer: 'https://m.kuwo.cn/', ...cookieHeader(cookie) } },
    )
    const list = result.json?.data?.lrclist || []
    const lyric = list
      .map((line) => {
        const time = Number(line.time) || 0
        const minutes = Math.floor(time / 60)
        const seconds = (time % 60).toFixed(2).padStart(5, '0')
        return `[${String(minutes).padStart(2, '0')}:${seconds}]${clean(line.lineLyric, 300)}`
      })
      .join('\n')
    return { lyric, translation: '' }
  } catch {
    return { lyric: '', translation: '' }
  }
}

// ---------------------------------------------------------------------------
// 汽水音乐：分享页解析（网页版只给 30 秒试听）
// ---------------------------------------------------------------------------

function qishuiTrackId(rawUrl) {
  try {
    const url = new URL(String(rawUrl))
    if (!/(^|\.)douyin\.com$/i.test(url.hostname) || !/\/qishui\//i.test(url.pathname)) return ''
    return clean(url.searchParams.get('track_id'), 40)
  } catch {
    return ''
  }
}

function isQishuiLink(rawUrl) {
  return Boolean(qishuiTrackId(rawUrl))
}

async function qishuiResolveLink(rawUrl) {
  const trackId = qishuiTrackId(rawUrl)
  if (!trackId) throw new Error('不是有效的汽水音乐分享链接')
  let BrowserWindow
  let session
  try {
    ;({ BrowserWindow, session } = require('electron'))
  } catch {
    throw new Error('汽水音乐解析需要在程序内运行')
  }
  const partition = 'persist:music-qishui'
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 820,
    webPreferences: { partition, backgroundThrottling: false },
  })
  try {
    const ses = session.fromPartition(partition)
    ses.setUserAgent(UA)
    let mediaUrl = ''
    const listener = (details, callback) => {
      if (details.resourceType === 'media' && /^https?:/i.test(details.url)) mediaUrl = details.url
      callback({})
    }
    ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, listener)
    const shareUrl = `https://music.douyin.com/qishui/share/track?track_id=${encodeURIComponent(trackId)}`
    await Promise.race([
      win.loadURL(shareUrl),
      new Promise((_, reject) => setTimeout(() => reject(new Error('汽水分享页加载超时')), 20000)),
    ])
    const started = Date.now()
    let info = null
    while (Date.now() - started < 15000) {
      try {
        info = await win.webContents.executeJavaScript(`(() => {
          const audio = document.querySelector('audio');
          const rawTitle = (document.title || '').trim();
          const title = rawTitle.replace(/^《/, '').replace(/》?@汽水音乐$/, '').trim();
          const meta = document.querySelector('meta[property="og:image"],meta[name="og:image"]');
          const text = (document.body.innerText || '').split(/\\n+/).map((line) => line.trim()).filter(Boolean);
          const images = Array.from(document.images || []).map((img) => img.currentSrc || img.src).filter(Boolean);
          return { src: audio ? (audio.currentSrc || audio.src) : '', rawTitle, title, cover: meta ? meta.content : '', text, images };
        })()`)
      } catch {
        info = null
      }
      if ((info?.src || mediaUrl) && info?.title) break
      await new Promise((resolve) => setTimeout(resolve, 700))
    }
    ses.webRequest.onBeforeRequest(null)
    const src = mediaUrl || info?.src || ''
    if (!src) throw new Error('汽水分享页没有返回音频，可能链接已失效')
    // 汽水分享页的 document.title 有时是「小半-陈粒-汽水音乐」，
    // 有时是「《小半》@汽水音乐」；两种都要能拆出歌名和歌手。
    const rawTitle = clean(info?.rawTitle, 200) || clean(info?.title, 200) || ''
    const parts = rawTitle
      .replace(/^《/, '')
      .replace(/》?@汽水音乐$/, '')
      .split(/[-–—]/)
      .map((item) => item.trim())
      .filter((item) => item && item !== '汽水音乐')
    let title = parts[0] || '汽水音乐'
    let artist = parts[1] || ''
    const text = Array.isArray(info?.text) ? info.text : []
    if (!artist) {
      const titleIndex = text.findIndex((line) => line === title)
      artist = clean(titleIndex >= 0 ? text[titleIndex + 1] : '', 80)
    }
    if (!artist) {
      // 兜底：在页面文字里找「歌名」后面紧跟的那一行
      const index = text.findIndex((line) => normalizeMatch(line) === normalizeMatch(title))
      if (index >= 0) artist = clean(text[index + 1], 80)
    }
    const lyricLines = text.filter((line) => {
      if (!line || line === title || line === artist) return false
      if (/^(关注|进入汽水音乐|还没有汽水音乐？|去下载|邀请你来|用户协议|隐私政策)/.test(line)) return false
      if (/^\d+(\.\d+)?[wW万]?$/.test(line)) return false
      return line.length >= 2 && line.length <= 60
    })
    const images = Array.isArray(info?.images) ? info.images : []
    const cover =
      clean(info?.cover, 1000) ||
      images.find((src) => /douyinpic|p\d+-luna/i.test(src) && !/logo|icon|avatar/i.test(src)) ||
      ''
    const preview = true
    return {
      platform: 'qishui',
      platformName: '汽水音乐',
      id: trackId,
      title,
      artist,
      album: '',
      cover,
      duration: 30,
      vip: false,
      preview,
      playUrl: src,
      format: 'm4a',
      bitrate: 128000,
      referer: 'https://music.douyin.com/qishui/',
      cookie: '',
      lyric: '',
      translation: '',
      lyricLines,
      note: '汽水音乐网页版只提供 30 秒试听；完整版需要在汽水 App 内播放，正在尝试按歌名 + 歌手换源…',
    }
  } finally {
    try {
      win.destroy()
    } catch {
      /* 忽略 */
    }
  }
}

// ---------------------------------------------------------------------------
// 无损音乐下载（flac.music.hi.cn）：公开的跨平台取流接口
//
// 它的搜索接口只支持酷我 / 网易云，但取流接口能拿到一部分会员歌曲的
// 320K / FLAC 直链（依赖站点自己的版权池）。这里只把它当成「平台取流失败
// 或用户明确要 FLAC」时的备用源，不参与搜索列表，也不存储任何文件。
// ---------------------------------------------------------------------------

const HI_BASE = 'https://flac.music.hi.cn/ajax.php'
const lyricFallbackCache = new Map()

async function hiPost(act, params) {
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) body.append(key, String(value))
  }
  const result = await requestJson(`${HI_BASE}?act=${encodeURIComponent(act)}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      referer: 'https://flac.music.hi.cn/',
      origin: 'https://flac.music.hi.cn',
    },
    body: body.toString(),
  })
  if (!result.json) throw new Error(`无损音乐源返回异常（HTTP ${result.status}）`)
  return result.json
}

async function hiSearch(platform, keyword) {
  const json = await hiPost('search', { platform, keyword, page: 1, size: 20 })
  if (Number(json?.code) !== 0) throw new Error(clean(json?.msg, 120) || '无损音乐源搜索失败')
  return Array.isArray(json?.data?.list) ? json.data.list : []
}

function pickHiCandidate(song, list) {
  const title = normalizeMatch(song.title)
  const artist = normalizeMatch(song.artist)
  if (!title || !Array.isArray(list) || !list.length) return null
  let best = null
  let bestScore = -1
  for (const item of list) {
    const itemTitle = normalizeMatch(item.name)
    const itemArtist = normalizeMatch(item.artist)
    let score = 0
    if (itemTitle === title) score += 8
    else if (itemTitle.includes(title) || title.includes(itemTitle)) score += 4
    else continue
    if (artist && itemArtist === artist) score += 8
    else if (artist && (itemArtist.includes(artist) || artist.includes(itemArtist))) score += 4
    else if (artist && itemArtist) score -= 6
    // 优先非 Live / 翻唱 / DJ 版本
    if (/(live|现场|演唱会|翻唱|cover|伴奏|dj|remix|片段|试听)/i.test(`${item.name} ${item.album_name || ''}`)) score -= 8
    if (Number(song.duration) && Number(item.duration)) {
      const diff = Math.abs(Number(song.duration) - Number(item.duration))
      if (diff <= 3) score += 3
      else if (diff <= 12) score += 1
      else if (diff > 40) score -= 4
    }
    if (score > bestScore) {
      bestScore = score
      best = item
    }
  }
  return bestScore >= 6 ? best : null
}

// 歌词兜底：有些 VIP 歌曲的酷我歌词接口直接返回 null，但 QQ 音乐 / 网易云
// 或无损音乐源还能拿到。按 QQ → 网易云 → 酷我 → 无损音乐源 的顺序找。
async function findLyrics(song) {
  const key = `${song.platform || ''}|${song.id || ''}|${song.title || ''}|${song.artist || ''}`
  const cached = lyricFallbackCache.get(key)
  if (cached && Date.now() - cached.at < 60 * 60 * 1000) return cached.value
  const title = normalizeMatch(song.title)
  const artist = normalizeMatch(song.artist)
  const matches = (item) => {
    const itemTitle = normalizeMatch(item.title || item.name)
    const itemArtist = normalizeMatch(item.artist || '')
    if (!itemTitle) return false
    const titleOk = itemTitle === title || itemTitle.includes(title) || title.includes(itemTitle)
    if (!titleOk) return false
    if (!artist || !itemArtist) return true
    return itemArtist === artist || itemArtist.includes(artist) || artist.includes(itemArtist)
  }
  const remember = (value) => {
    lyricFallbackCache.set(key, { at: Date.now(), value })
    while (lyricFallbackCache.size > 300) lyricFallbackCache.delete(lyricFallbackCache.keys().next().value)
    return value
  }

  // 1) QQ 音乐：版权库最全，歌词接口也最稳
  try {
    const list = await qqSearch(`${song.title} ${song.artist || ''}`.trim())
    const hit = list.find(matches) || list.find((item) => normalizeMatch(item.title) === title)
    if (hit) {
      const lyric = await qqLyric(hit.id)
      if (lyric.lyric && lyric.lyric.length > 10) return remember(lyric)
    }
  } catch {
    /* 继续下一个源 */
  }

  // 2) 网易云
  try {
    const list = await neteaseSearch(`${song.title} ${song.artist || ''}`.trim())
    const hit = list.find(matches)
    if (hit) {
      const lyric = await neteaseLyric(hit.id)
      if (lyric.lyric && lyric.lyric.length > 10) return remember(lyric)
    }
  } catch {
    /* 继续下一个源 */
  }

  // 3) 酷我同名版权源（同一个歌名经常有多条，其中一条有歌词）
  try {
    const list = await kuwoSearch(`${song.title} ${song.artist || ''}`.trim())
    for (const hit of kuwoCandidates(song, list).slice(0, 8)) {
      const lyric = await kuwoLyric(hit.id)
      if (lyric.lyric && lyric.lyric.length > 10) return remember(lyric)
    }
  } catch {
    /* 继续下一个源 */
  }

  // 4) 无损音乐源的歌词接口
  for (const platform of ['kuwo', 'wyy']) {
    try {
      const list = await hiSearch(platform, song.title)
      const hit = pickHiCandidate(song, list)
      if (!hit) continue
      const json = await hiPost('getLyric', {
        platform,
        songid: hit.id,
        time: hit.time,
        sign: hit.sign,
      })
      const lyric = cleanLyric(json?.data)
      if (lyric && lyric.length > 10) return remember({ lyric, translation: '' })
    } catch {
      /* 继续 */
    }
  }
  return remember(null)
}

async function hiFallback(song, { format = 'mp3', quality = '320' } = {}) {
  const wantedFlac = format === 'flac' || quality === 'flac'
  // 网易云歌曲优先走网易云源，其它平台优先走酷我源（酷我的无损命中率更高）
  const platforms = song.platform === 'netease' ? ['wyy', 'kuwo'] : ['kuwo', 'wyy']
  // 「江南-《你很》电影片头曲」这类带副标题的歌名，先用主标题搜一次
  const baseTitle = String(song.title || '')
    .replace(/\s*[-–—(（【[].*$/, '')
    .trim()
  const keywords = [...new Set([song.title, baseTitle, `${song.title} ${song.artist}`.trim()].filter(Boolean))]
  let fallbackMp3 = null
  for (const platform of platforms) {
    for (const keyword of keywords) {
      let list = []
      try {
        list = await hiSearch(platform, keyword)
      } catch {
        continue
      }
      const match = pickHiCandidate(song, list)
      if (!match) continue
      const minfo = Array.isArray(match.minfo) ? match.minfo : []
      const hasFlac = minfo.some((item) => String(item.format).toLowerCase() === 'flac')
      const targetFormat = wantedFlac && hasFlac ? 'flac' : 'mp3'
      const bitrate = targetFormat === 'flac' ? '2000' : '320'
      let json = null
      try {
        json = await hiPost('getUrl', {
          platform,
          songid: match.id,
          format: targetFormat,
          bitrate,
          time: match.time,
          sign: match.sign,
        })
      } catch {
        continue
      }
      if (Number(json?.code) !== 0 || !json?.data?.url) continue
      const playUrl = String(json.data.url)
      const actualFormat = /\.flac(?:[?#]|$)/i.test(playUrl) ? 'flac' : /\.m4a(?:[?#]|$)/i.test(playUrl) ? 'm4a' : 'mp3'
      let hiLyric = ''
      try {
        const lyricJson = await hiPost('getLyric', {
          platform,
          songid: match.id,
          time: match.time,
          sign: match.sign,
        })
        hiLyric = cleanLyric(lyricJson?.data)
        if (!hiLyric && lyricJson?.data) {
          hiLyric = cleanLyric(String(lyricJson.data).split(/\r?\n/)
            .filter((line) => !/^\s*\[(ti|ar|al|by|offset):/i.test(line))
            .join('\n'))
        }
      } catch {
        /* 用平台歌词接口兜底 */
      }
      const lyric = hiLyric
        ? { lyric: hiLyric, translation: '' }
        : platform === 'wyy'
          ? await neteaseLyric(match.id)
          : await kuwoLyric(match.id)
      const candidate = {
        playUrl,
        format: actualFormat,
        bitrate: targetFormat === 'flac' ? 2000000 : 320000,
        duration: Number(match.duration) || Number(json.data.duration) || 0,
        referer: 'https://flac.music.hi.cn/',
        cookie: '',
        lyric: lyric.lyric,
        translation: lyric.translation || '',
        via: 'hi',
        viaName: '无损音乐下载',
        note:
          (wantedFlac && actualFormat !== 'flac'
            ? '这个源没有返回真正的 FLAC，已改用 320K MP3；'
            : '') +
          `原平台没有给出完整音源，已通过无损音乐下载源取到同名单曲（${actualFormat.toUpperCase()}）`,
      }
      // 用户要 FLAC 时，先继续找真正返回 FLAC 的源；找不到再退回 320K MP3
      if (!wantedFlac || actualFormat === 'flac') return candidate
      if (!fallbackMp3) fallbackMp3 = candidate
    }
  }
  return fallbackMp3
}

// ---------------------------------------------------------------------------
// 换源：原平台没有权限时，用歌名 + 歌手在酷我找一条可播放音源
// ---------------------------------------------------------------------------

// 酷我同一个歌名经常有多条版权来源：有的要会员，有的还能免费播。
// 只接受「歌名完全一致」的版本，优先同歌手、时长接近的，挨个试到能播为止。
function kuwoCandidates(song, candidates) {
  const title = normalizeMatch(song.title)
  const artist = normalizeMatch(song.artist)
  if (!title) return []
  const exact = candidates.filter((item) => normalizeMatch(item.title) === title)
  const sameArtist = exact.filter((item) => {
    if (!artist) return true
    const itemArtist = normalizeMatch(item.artist)
    return !itemArtist || itemArtist === artist || itemArtist.includes(artist) || artist.includes(itemArtist)
  })
  const pool = sameArtist.length ? sameArtist : exact
  return pool
    .map((item) => {
      let score = 0
      if (normalizeMatch(item.artist) === artist) score += 8
      else if (artist && normalizeMatch(item.artist).includes(artist)) score += 4
      if (Number(song.duration) && Number(item.duration)) {
        const diff = Math.abs(Number(song.duration) - Number(item.duration))
        if (diff <= 3) score += 3
        else if (diff <= 12) score += 1
        else if (diff > 40) score -= 4
      }
      // 同专辑优先，避免把录音室版换成 Live / 翻唱 / DJ 版
      const album = normalizeMatch(song.album)
      if (album && normalizeMatch(item.album) === album) score += 6
      if (/(live|现场|演唱会|翻唱|cover|伴奏|dj|remix|混音|片段|试听)/i.test(`${item.title} ${item.album}`)) score -= 6
      if (!item.vip) score += 1
      return { item, score }
    })
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.item)
    .slice(0, 12)
}

async function kuwoFallback(song, { format = 'mp3', quality = '320', excludeId = '' } = {}) {
  const keywords = [`${song.title} ${song.artist}`.trim(), song.title].filter(Boolean)
  const seen = new Set(excludeId ? [String(excludeId)] : [])
  for (const keyword of keywords) {
    let candidates = []
    try {
      candidates = await kuwoSearch(keyword)
    } catch {
      continue
    }
    for (const candidate of kuwoCandidates(song, candidates)) {
      if (seen.has(candidate.id)) continue
      seen.add(candidate.id)
      try {
        const resolved = await kuwoResolve(candidate, { format, quality })
        return {
          ...resolved,
          via: 'kuwo',
          viaName: '酷我音乐',
          note: `原平台暂时拿不到完整音源，已自动换到酷我上的同名单曲（${candidate.title} - ${candidate.artist}）`,
        }
      } catch {
        /* 这条版权源要会员，继续试下一条 */
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

async function searchMusic({ platform, keyword, cookie = '' }) {
  const meta = platformByKey(platform)
  if (!meta) return { ok: false, error: '未知的音乐平台' }
  const query = clean(keyword, 100)
  if (!query) return { ok: false, error: '请输入歌名、歌手或专辑' }
  if (!meta.searchable) {
    return {
      ok: false,
      error: '汽水音乐网页版不开放搜索；请在汽水 App 里点歌曲分享 → 复制链接，再粘贴到这里解析。',
    }
  }
  const search = { netease: neteaseSearch, qq: qqSearch, kugou: kugouSearch, kuwo: kuwoSearch }[platform]
  try {
    const songs = await search(query, { cookie })
    return { ok: true, platform, platformName: meta.name, songs: songs.slice(0, 30) }
  } catch (error) {
    return { ok: false, error: clean(error?.message || error, 200) }
  }
}

async function resolveMusic({ platform, song, quality = '320', format = 'mp3', cookie = '' }) {
  const meta = platformByKey(platform)
  if (!meta) return { ok: false, error: '未知的音乐平台' }
  if (!song || !song.id) return { ok: false, error: '歌曲信息不完整' }
  const wantFlac = format === 'flac' || quality === 'flac'
  let resolved = null
  let primaryError = ''
  try {
    if (platform === 'netease') resolved = await neteaseResolve(song, { quality, format, cookie })
    else if (platform === 'qq') resolved = await qqResolve(song, { quality, format, cookie })
    else if (platform === 'kugou') resolved = await kugouResolve(song, { quality, format, cookie })
    else if (platform === 'kuwo') resolved = await kuwoResolve(song, { quality, format, cookie })
    else if (platform === 'qishui') {
      const direct = await qishuiResolveLink(song.url || song.shareUrl || '')
      resolved = direct
      if (direct.preview) {
        const fallbackSong = {
          ...song,
          title: direct.title || song.title,
          artist: direct.artist || song.artist,
          duration: direct.duration || song.duration,
        }
        // 先用无损音乐源的完整音源，再用酷我的免费同名源
        const hi = await hiFallback(fallbackSong, { format, quality })
        const fallback = hi || (await kuwoFallback(fallbackSong, { format, quality }))
        if (fallback) {
          resolved = {
            ...fallback,
            title: direct.title || song.title,
            artist: direct.artist || song.artist,
            cover: direct.cover || song.cover,
            note: `${direct.note}\n${fallback.note}`,
          }
          resolved.preview = false
        }
      }
    }
  } catch (error) {
    primaryError = clean(error?.message || error, 200)
  }

  // 平台没有权限 / 用户明确要 FLAC 时，先试无损音乐源（它有时能直接给 FLAC），
  // 再退到酷我同名版权源（通常最高 320K）。
  if (!resolved || (wantFlac && resolved.format !== 'flac')) {
    const hi = await hiFallback(song, { format, quality })
    if (hi && (!resolved || hi.format === 'flac')) resolved = hi
  }

  if (!resolved && platform !== 'qishui') {
    // 酷我同一个歌名也可能第一条要会员、后面的版权源还能免费播，
    // 所以酷我也允许「换一条同名版权源」，但排除刚才失败的那一条。
    const fallback = await kuwoFallback(song, {
      format,
      quality,
      excludeId: platform === 'kuwo' ? song.id : '',
    })
    if (fallback) resolved = fallback
  }
  if (resolved && (!resolved.lyric || resolved.lyric.length < 10)) {
    // 歌词兜底最多等 7 秒，不能为了歌词把「开播」拖到十几秒；
    // 超时后后台请求仍会继续跑，下一次播放可命中缓存。
    const extra = await Promise.race([
      findLyrics(song),
      new Promise((resolve) => setTimeout(() => resolve(null), 7000)),
    ])
    if (extra?.lyric) {
      resolved.lyric = extra.lyric
      resolved.translation = extra.translation || resolved.translation || ''
    }
  }
  if (resolved && wantFlac && resolved.format !== 'flac') {
    resolved.note = `${resolved.note ? `${resolved.note}\n` : ''}没有找到真正的无损音源，已改用 320K MP3`
  }
  if (!resolved) {
    return {
      ok: false,
      error:
        primaryError ||
        (platform === 'qishui'
          ? '汽水分享页只返回了试听，且没有找到可用的完整音源'
          : '没有拿到可播放地址，可能是会员 / 版权限制'),
      hint:
        platform === 'qishui'
          ? '汽水音乐完整版需要在汽水 App 内播放；也可以登录其它平台会员账号后换平台搜索。'
          : '可以点平台卡片登录会员账号后再试；没有会员时，程序会自动尝试其它平台的同名音源。',
      platform,
    }
  }
  return {
    ok: true,
    platform,
    platformName: meta.name,
    ...resolved,
    title: resolved.title || song.title,
    artist: resolved.artist || song.artist,
    album: resolved.album || song.album,
    cover: resolved.cover || song.cover,
    duration: resolved.duration || song.duration || 0,
    vip: Boolean(song.vip),
    qualities: buildQualities(platform, song),
  }
}

function buildQualities(platform, song) {
  const list = [
    { key: '128', label: '标准 128K', format: 'mp3', available: true },
    { key: '320', label: '高品 320K', format: 'mp3', available: true },
  ]
  // 五个平台都可能通过无损音乐源换到同名单曲的 FLAC，先让按钮可用；
  // 实际拿不到时 resolveMusic 会降级并在 note 里说明。
  const flac = true
  list.push({ key: 'flac', label: '无损 FLAC', format: 'flac', available: flac })
  return list
}

// ---------------------------------------------------------------------------
// 平台登录：打开官方网页，用户登录后关闭窗口，主进程读 Cookie
// ---------------------------------------------------------------------------

async function loginMusicPlatform(key) {
  const meta = platformByKey(key)
  if (!meta) return { ok: false, error: '未知的音乐平台' }
  if (!meta.loginUrl) return { ok: false, error: `${meta.name} 网页版不支持登录，请使用分享链接` }
  let BrowserWindow
  let session
  try {
    ;({ BrowserWindow, session } = require('electron'))
  } catch {
    return { ok: false, error: '登录窗口只能在程序内打开' }
  }
  return new Promise((resolve) => {
    let win = null
    try {
      win = new BrowserWindow({
        width: 1060,
        height: 800,
        autoHideMenuBar: true,
        title: `登录 ${meta.name}（登录完成后关闭本窗口）`,
        webPreferences: { partition: meta.partition, contextIsolation: true, nodeIntegration: false },
      })
      win.loadURL(meta.loginUrl).catch(() => {})
      win.on('closed', async () => {
        try {
          const cookies = await session.fromPartition(meta.partition).cookies.get({})
          const header = cookies.map((item) => `${item.name}=${item.value}`).join('; ').slice(0, 20000)
          resolve({ ok: true, cookie: header, count: cookies.length })
        } catch (error) {
          resolve({ ok: false, error: clean(error?.message || error, 200) })
        }
      })
    } catch (error) {
      try {
        win?.destroy()
      } catch {
        /* 忽略 */
      }
      resolve({ ok: false, error: clean(error?.message || error, 200) })
    }
  })
}

// ---------------------------------------------------------------------------
// 下载：音频 + LRC，放在独立的「音乐」目录，按平台分文件夹
// ---------------------------------------------------------------------------

function audioExtFromUrl(rawUrl, fallback = '.mp3') {
  try {
    const pathname = new URL(rawUrl).pathname.toLowerCase()
    if (pathname.endsWith('.flac')) return '.flac'
    if (pathname.endsWith('.m4a')) return '.m4a'
    if (pathname.endsWith('.mp3')) return '.mp3'
    if (pathname.endsWith('.aac')) return '.m4a'
  } catch {
    /* 忽略 */
  }
  return fallback
}

class MusicDownloadManager {
  saveLyric({ platformName = '音乐', title = '', artist = '', lyric = '' } = {}) {
    if (!lyric) return { ok: false, error: '这首歌还没有拿到歌词' }
    const folder = path.join(this.dir, sanitizeFileName(platformName || '音乐', '音乐'))
    const baseName = sanitizeFileName(`${title || '未命名歌曲'}${artist ? ` - ${artist}` : ''}`, '未命名歌曲')
    const target = path.join(folder, `${baseName}.lrc`)
    try {
      fs.mkdirSync(folder, { recursive: true })
      if (fs.existsSync(target)) return { ok: true, exists: true, path: target }
      fs.writeFileSync(target, `\ufeff${lyric}`, 'utf8')
      return { ok: true, path: target }
    } catch (error) {
      return { ok: false, error: clean(error?.message || error, 200) }
    }
  }

  constructor({ log, dir, onState, proxify }) {
    this.log = log || (() => {})
    this.dir = dir
    this.onState = onState || (() => {})
    this.proxify = typeof proxify === 'function' ? proxify : null
    this.jobs = new Map()
    this.counter = 0
    this.lastSavedPath = ''
  }

  get folder() {
    return this.dir
  }

  snapshot(id) {
    const job = this.jobs.get(id)
    return job ? { ...job.state } : null
  }

  emit(job, patch = {}) {
    Object.assign(job.state, patch)
    job.state.updatedAt = Date.now()
    if (job.state.status === 'running') {
      const now = Date.now()
      if (now - (job.lastEmit || 0) < 300) return
      job.lastEmit = now
    }
    this.onState({ ...job.state })
    this.log(`[音乐下载] ${job.state.status} ${job.state.percent}% ${job.state.title} ${job.state.error || ''}`)
  }

  start({ url, referer = '', cookie = '', platform = '', platformName = '', title = '', artist = '', format = 'mp3', lyric = '', id: forcedId = '' }) {
    if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: '没有可下载的音频地址' }
    const id = String(forcedId || '') || `mdl-${Date.now()}-${++this.counter}`
    const safePlatform = sanitizeFileName(platformName || platform || '音乐', '音乐')
    const folder = path.join(this.dir, safePlatform)
    const baseName = sanitizeFileName(`${title || '未命名歌曲'}${artist ? ` - ${artist}` : ''}`, '未命名歌曲')
    const ext = format === 'flac' ? '.flac' : format === 'm4a' ? '.m4a' : audioExtFromUrl(url, '.mp3')
    const audioPath = path.join(folder, `${baseName}${ext}`)
    const lyricPath = path.join(folder, `${baseName}.lrc`)
    const exists = fs.existsSync(audioPath)
    if (exists) {
      if (lyric && !fs.existsSync(lyricPath)) {
        try {
          fs.mkdirSync(folder, { recursive: true })
          fs.writeFileSync(lyricPath, `\ufeff${lyric}`, 'utf8')
        } catch {
          /* 忽略 */
        }
      }
      return { ok: false, exists: true, savedPath: audioPath, lyricPath: lyric ? lyricPath : '', title: baseName }
    }
    const job = {
      id,
      controller: new AbortController(),
      cancelled: false,
      lastEmit: 0,
      target: url,
      referer,
      cookie,
      folder,
      baseName,
      audioPath,
      lyricPath,
      lyric,
      ext,
      state: {
        id,
        status: 'running',
        kind: 'music',
        title: baseName,
        platform: platformName || platform,
        percent: 0,
        bytes: 0,
        totalBytes: 0,
        savedPath: '',
        lyricPath: '',
        error: '',
        dir: folder,
      },
    }
    this.jobs.set(id, job)
    this.emit(job)
    this._run(job).catch((error) => this.log(`[音乐下载] 未捕获失败：${error?.stack || error}`))
    return { ok: true, id }
  }

  cancel(id) {
    const job = this.jobs.get(id)
    if (!job || job.state.status !== 'running') return false
    job.cancelled = true
    try {
      job.controller?.abort()
    } catch {
      /* 忽略 */
    }
    job.state.status = 'cancelled'
    this.emit(job)
    return true
  }

  cancelAll() {
    for (const key of this.jobs.keys()) this.cancel(key)
  }

  async _run(job) {
    let partPath = ''
    try {
      fs.mkdirSync(job.folder, { recursive: true })
      const target =
        this.proxify && job.target.startsWith('http') && !job.target.startsWith('http://127.0.0.1')
          ? this.proxify(job.target, job)
          : job.target
      const response = await fetch(target, {
        headers: {
          'user-agent': UA,
          referer: job.referer || job.target,
          accept: '*/*',
          ...(job.cookie ? { cookie: job.cookie } : {}),
        },
        redirect: 'follow',
        signal: job.controller.signal,
      })
      if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`)
      const total = Number(response.headers.get('content-length')) || 0
      const contentType = String(response.headers.get('content-type') || '').toLowerCase()
      if (contentType.includes('text/html') || contentType.includes('application/json')) {
        throw new Error('音源返回的不是音频文件，可能链接已失效')
      }
      partPath = `${job.audioPath}.part`
      const stream = fs.createWriteStream(partPath)
      let bytes = 0
      const started = Date.now()
      try {
        for await (const chunk of response.body) {
          if (job.cancelled) break
          bytes += chunk.length
          await new Promise((resolve, reject) => {
            stream.write(chunk, (error) => (error ? reject(error) : resolve()))
          })
          this.emit(job, {
            percent: total ? Math.min(99, Math.round((bytes / total) * 100)) : 0,
            bytes,
            totalBytes: total,
            speed: bytes / Math.max(0.3, (Date.now() - started) / 1000),
          })
        }
      } finally {
        await new Promise((resolve) => stream.end(resolve))
      }
      if (job.cancelled) {
        fs.rmSync(partPath, { force: true })
        return
      }
      if (!bytes) throw new Error('下载到的音频是空文件')
      fs.renameSync(partPath, job.audioPath)
      job.state.savedPath = job.audioPath
      job.state.percent = 100
      this.lastSavedPath = job.audioPath
      if (job.lyric) {
        try {
          fs.writeFileSync(job.lyricPath, `\ufeff${job.lyric}`, 'utf8')
          job.state.lyricPath = job.lyricPath
        } catch {
          /* 歌词写不进去不影响音频 */
        }
      }
      job.state.status = 'done'
      this.emit(job)
    } catch (error) {
      if (partPath) {
        try {
          fs.rmSync(partPath, { force: true })
        } catch {
          /* 忽略 */
        }
      }
      job.state.status = job.cancelled ? 'cancelled' : 'failed'
      job.state.error = job.cancelled ? '' : clean(error?.message || error, 200)
      this.emit(job)
      if (!job.cancelled) this.log(`[音乐下载] 失败：${error?.stack || error}`)
    } finally {
      job.controller = null
      const finished = [...this.jobs.values()].filter((item) => item.state.status !== 'running')
      if (finished.length > 30) {
        for (const item of finished.slice(0, finished.length - 30)) this.jobs.delete(item.id)
      }
    }
  }
}

module.exports = {
  MUSIC_PLATFORMS,
  platformByKey,
  searchMusic,
  resolveMusic,
  loginMusicPlatform,
  isQishuiLink,
  qishuiTrackId,
  MusicDownloadManager,
  formatDuration,
}
