'use strict'

// 用 Electron 把 tools/guide/make_pdf.py 生成的 print.html 打印成 A4 PDF。
// 用法：electron.exe tools/guide/print_pdf.js <print.html> <out.pdf>

const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const args = process.argv.slice(1)
const htmlArg = args.find((item) => item.toLowerCase().endsWith('.html'))
const outArg = args.find((item) => item.toLowerCase().endsWith('.pdf'))
const htmlPath = path.resolve(htmlArg || path.join(__dirname, '..', '..', '.tmp', 'guide', 'print.html'))
const outPath = path.resolve(outArg || path.join(__dirname, '..', '..', 'docs', '长视频解析-图文使用教程.pdf'))

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('no-sandbox')

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: {
      offscreen: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  try {
    await win.loadFile(htmlPath)
    // 等字体和中文字体排版完成、所有图片解码完成，避免打印出空白图
    await win.webContents.executeJavaScript(`(async () => {
      if (document.fonts && document.fonts.ready) await document.fonts.ready
      await Promise.all(Array.from(document.images).map((img) => {
        if (img.complete && img.naturalWidth > 0) return Promise.resolve(true)
        return new Promise((resolve) => {
          img.addEventListener('load', () => resolve(true), { once: true })
          img.addEventListener('error', () => resolve(false), { once: true })
          setTimeout(() => resolve(false), 8000)
        })
      }))
      return true
    })()`)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      generateDocumentOutline: true,
    })
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, pdf)
    console.log(`PDF written: ${outPath} (${pdf.length} bytes)`)
    app.exit(0)
  } catch (error) {
    console.error('printToPDF failed:', error)
    app.exit(1)
  }
})
