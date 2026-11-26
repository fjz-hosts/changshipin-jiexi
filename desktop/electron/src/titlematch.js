'use strict'

/**
 * 资源站（苹果CMS 采集接口）剧名匹配工具。
 *
 * 平台页面标题经常是「营销标语_分类_剧名_平台」拼在一起的一大串，采集站里的
 * vod_name 又常常多一个标点、把「剧场版」写成别的样子；以前只取标题第一段做
 * 「完全相等」比较，冷门片 / 剧场版就会经常报「资源站没有《…》」。
 *
 * 这里改成三步：
 *   1. 从标题里拆出多个候选剧名（分段 / 去掉感叹号前的标语 / 拆空格）；
 *   2. 归一化（去空格、标点、平台噪声词）后精确匹配，再退一步做
 *      「去掉剧场版 / 完整版等后缀」和「足够长的包含」匹配；
 *   3. 标题里没有集数时（电影 / 剧场版），允许匹配单集资源。
 *
 * 纯逻辑，不依赖 Electron，smoke 里可以直接断言。
 */

const NOISE =
  /(?:电视剧|全集|完整版|在线观看|免费观看|高清完整版|高清|超清|蓝光|1080P|4K|国语版|粤语版|普通话版|国语|普通话|视频|动漫|综艺|电影网|腾讯视频|爱奇艺|优酷|芒果TV)/gi

const PUNCT = /[《》【】\[\]「」『』()（）·:：,，.。!！?？'"“”‘’、~～_\-–—|/\\]+/g

function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(PUNCT, '')
    .trim()
}

function cleanName(raw) {
  let text = String(raw || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  text = text.replace(/第\s*\d+\s*[集话期].*$/, '')
  text = text.replace(/[《》【】\[\]「」『』()（）]/g, ' ')
  text = text.replace(NOISE, ' ')
  text = text.replace(PUNCT, ' ')
  return text.replace(/\s+/g, ' ').trim()
}

function titleCandidates(rawTitle) {
  const raw = String(rawTitle || '').replace(/\s+/g, ' ').trim()
  if (!raw) return []
  const list = []
  const seen = new Set()
  const push = (value) => {
    const cleaned = cleanName(value)
    const key = normalizeTitle(cleaned)
    if (key.length < 2 || seen.has(key)) return
    seen.add(key)
    list.push(cleaned)
  }
  // | - _ 是平台页面标题里最常见分隔符
  const parts = raw
    .split(/[-_|–—]/)
    .map((part) => part.trim())
    .filter(Boolean)
  for (const part of parts) {
    push(part)
    // 「九年青春，终极一战！_动漫_高清完整版视频在线观看 斗破苍穹剧场版 双帝之战」：
    // 感叹号前面是营销标语，真正的剧名在后面
    const tail = part.replace(/^.*?[！!？?]\s*/, '')
    if (tail !== part) push(tail)
    // 空格分隔的中文标题（「斗破苍穹剧场版 双帝之战」）拆开当候选；
    // 英文标题不拆，否则 "The Last of Us" 会拆出 "Us" 这种会撞名的词
    if (/\s/.test(part) && /[\u4e00-\u9fa5]/.test(part)) {
      for (const piece of part.split(/\s+/)) {
        if (/[\u4e00-\u9fa5]/.test(piece)) push(piece)
      }
    }
  }
  push(raw)
  return list
}

function parseTitleInfo(rawTitle) {
  const names = titleCandidates(rawTitle)
  const episode = Number((String(rawTitle || '').match(/第\s*(\d+)\s*[集话期]/) || [])[1]) || 0
  return { name: names[0] || '', names, episode }
}

// 电影 / 剧场版：平台标题里常带这些词，用来决定「没有集数也能取单集资源」
function isMovieTitle(rawTitle) {
  const text = String(rawTitle || '')
  if (/剧场版|大电影|电影版|院线|正片/.test(text)) return true
  return /(?:^|[-_|])\s*电影\s*(?:[-_|]|$)/.test(text)
}

function coreTitle(value) {
  return normalizeTitle(value).replace(/(?:剧场版|大电影|电影版|完整版|国语版|粤语版|特别篇|合集|正片)$/g, '')
}

function matchCmsList(list, names) {
  const items = (Array.isArray(list) ? list : []).filter((item) => item && String(item.vod_name || '').trim())
  const keys = [...new Set((names || []).map(normalizeTitle).filter((key) => key.length >= 2))]
  if (!items.length || !keys.length) return { items: [], mode: 'none' }

  // 1. 归一化后完全一致（能消掉资源站名字里多出来的「?」「·」之类）
  const exact = items.filter((item) => keys.includes(normalizeTitle(item.vod_name)))
  if (exact.length) return { items: exact, mode: 'exact' }

  // 2. 去掉「剧场版 / 完整版 / 国语版」这类后缀再比一次
  const coreKeys = [...new Set(keys.map(coreTitle).filter((key) => key.length >= 3))]
  const near = coreKeys.length ? items.filter((item) => coreKeys.includes(coreTitle(item.vod_name))) : []
  if (near.length) return { items: near, mode: 'core' }

  // 3. 最后才放宽到包含匹配：候选名要够长（≥6 字），避免「斗破苍穹」撞上「斗破苍穹年番」
  const looseKeys = keys.filter((key) => key.length >= 6)
  if (!looseKeys.length) return { items: [], mode: 'none' }
  const loose = items.filter((item) => {
    const key = normalizeTitle(item.vod_name)
    if (key.length < 4) return false
    return looseKeys.some((want) => key === want || key.includes(want) || want.includes(key))
  })
  return { items: loose, mode: loose.length ? 'loose' : 'none' }
}

function splitPlayGroups(playUrl) {
  return String(playUrl || '')
    .split('$$$')
    .map((group) =>
      group
        .split('#')
        .map((part) => {
          const index = part.indexOf('$')
          if (index <= 0) return null
          const label = part.slice(0, index).trim()
          const url = part.slice(index + 1).trim()
          if (!/^https?:\/\//i.test(url)) return null
          return { label, url }
        })
        .filter(Boolean),
    )
    .filter((items) => items.length)
}

const MOVIE_LABEL = /^(?:正片|正剧|完整版|HD|高清|超清|蓝光|国语|普通话|原声)$/i

function pickCmsStream(playUrl, episode, { movie = false } = {}) {
  const groups = splitPlayGroups(playUrl)
  if (!groups.length) return { url: '', mode: 'none' }
  const target = Number(episode) || 0
  if (target > 0) {
    let best = null
    for (const items of groups) {
      const hit = items.find((item) => {
        const num = Number((String(item.label).match(/(\d+)/) || [])[1])
        return num === target
      })
      if (hit && (!best || items.length > best.count)) best = { url: hit.url, count: items.length }
    }
    return best ? { url: best.url, mode: 'episode' } : { url: '', mode: 'none' }
  }
  // 没有集数：只在「整条资源就一段」或「电影 / 剧场版的正片标签」时取第一段，
  // 免得把用户在看的第 10 集错配成第 1 集。
  let best = null
  for (const items of groups) {
    const single = items.length === 1
    const labelled = movie && items.some((item) => MOVIE_LABEL.test(String(item.label).replace(/\s+/g, '')))
    if (!single && !labelled) continue
    if (!best || items.length > best.count) best = { url: items[0].url, count: items.length }
  }
  return best ? { url: best.url, mode: 'movie' } : { url: '', mode: 'none' }
}

module.exports = {
  normalizeTitle,
  cleanName,
  titleCandidates,
  parseTitleInfo,
  isMovieTitle,
  matchCmsList,
  splitPlayGroups,
  pickCmsStream,
}
