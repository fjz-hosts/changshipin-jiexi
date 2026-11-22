'use strict'

/**
 * 下载记录删除时用的文件操作。
 *
 * 渲染进程只传下载记录 id，路径由主进程从 config.json 里读，
 * 并且只允许删「下载目录」里面的文件（防止被诱导去删别的路径）。
 */

const fs = require('node:fs')
const path = require('node:path')

function isPathInside(target, root) {
  if (!root) return false
  const rel = path.relative(root, target)
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

// 删完文件后，从文件所在的文件夹往上清掉空目录（短剧的「剧名」文件夹、音乐的平台文件夹）；
// 下载根目录本身不动。
function pruneEmptyDirs(startDir, root) {
  let current = path.resolve(startDir)
  while (isPathInside(current, root)) {
    try {
      fs.rmdirSync(current)
    } catch {
      return
    }
    current = path.dirname(current)
  }
}

function removeFileInRoot(rawPath, rootDir) {
  const file = String(rawPath || '').trim()
  if (!file) return { removed: false, missing: true }
  const root = path.resolve(String(rootDir || ''))
  const target = path.resolve(file)
  if (!root || !isPathInside(target, root)) {
    return { removed: false, error: '文件不在下载目录里，已跳过删除' }
  }
  try {
    if (!fs.existsSync(target)) return { removed: false, missing: true }
    if (fs.lstatSync(target).isDirectory()) return { removed: false, error: '目标不是文件' }
    fs.rmSync(target, { force: true })
    pruneEmptyDirs(path.dirname(target), root)
    return { removed: true }
  } catch (error) {
    return { removed: false, error: String(error?.message || error).slice(0, 160) }
  }
}

module.exports = { isPathInside, pruneEmptyDirs, removeFileInRoot }
