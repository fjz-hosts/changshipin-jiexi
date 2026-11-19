/* 四个目标平台的元信息（与桌面端 desktop/electron/src/platforms.js 保持一致）。 */
;(function () {
  'use strict'

  const PLATFORMS = [
    {
      key: 'browser',
      name: '内置浏览器',
      home: 'https://www.bing.com/',
      color: '#37e08b',
      partition: 'persist:browser',
      hosts: [],
    },
    {
      key: 'iqiyi',
      name: '爱奇艺',
      home: 'https://www.iqiyi.com/',
      color: '#00d95f',
      partition: 'persist:platform-iqiyi',
      hosts: ['iqiyi.com', 'iq.com'],
    },
    {
      key: 'qq',
      name: '腾讯视频',
      home: 'https://v.qq.com/',
      color: '#2b8cff',
      partition: 'persist:platform-qq',
      hosts: ['v.qq.com', 'qq.com'],
    },
    {
      key: 'youku',
      name: '优酷',
      home: 'https://www.youku.com/',
      color: '#35a6ff',
      partition: 'persist:platform-youku',
      hosts: ['youku.com', 'tudou.com'],
    },
    {
      key: 'mgtv',
      name: '芒果TV',
      home: 'https://www.mgtv.com/',
      color: '#ff8a1f',
      partition: 'persist:platform-mgtv',
      hosts: ['mgtv.com'],
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

  window.CSPPlatforms = { PLATFORMS, detectPlatformByUrl, platformByKey }
})()
