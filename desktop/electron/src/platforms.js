'use strict'

// 四个目标平台的元信息。主进程用它来打开「内置官网窗口」，
// 渲染进程里有一份精简版（src/renderer/app.js）用于识别链接。
const PLATFORMS = [
  {
    key: 'iqiyi',
    name: '爱奇艺',
    home: 'https://www.iqiyi.com/',
    color: '#00d95f',
    partition: 'persist:platform-iqiyi',
    hosts: ['iqiyi.com', 'iq.com'],
    hint: 'www.iqiyi.com/v_xxx.html',
  },
  {
    key: 'qq',
    name: '腾讯视频',
    home: 'https://v.qq.com/',
    color: '#2b8cff',
    partition: 'persist:platform-qq',
    hosts: ['v.qq.com', 'qq.com'],
    hint: 'v.qq.com/x/cover/xxx/xxx.html',
  },
  {
    key: 'youku',
    name: '优酷',
    home: 'https://www.youku.com/',
    color: '#35a6ff',
    partition: 'persist:platform-youku',
    hosts: ['youku.com', 'tudou.com'],
    hint: 'v.youku.com/v_show/id_xxx.html',
  },
  {
    key: 'mgtv',
    name: '芒果TV',
    home: 'https://www.mgtv.com/',
    color: '#ff8a1f',
    partition: 'persist:platform-mgtv',
    hosts: ['mgtv.com'],
    hint: 'www.mgtv.com/b/xxx/xxx.html',
  },
]

function detectPlatformByUrl(rawUrl) {
  let host = ''
  try {
    host = new URL(rawUrl).hostname.toLowerCase()
  } catch {
    return null
  }
  for (const platform of PLATFORMS) {
    if (platform.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return platform
  }
  return null
}

function platformByKey(key) {
  return PLATFORMS.find((p) => p.key === key) || null
}

module.exports = { PLATFORMS, detectPlatformByUrl, platformByKey }
