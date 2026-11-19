#!/usr/bin/env node
/**
 * 把 GitHub Releases 上的最新版安装包同步到项目根目录的 releases\，
 * 并清掉 releases\ 里更早版本的安装包，只保留最新一版。
 *
 * 用法（在项目根目录执行）：
 *   node scripts\sync-releases.mjs                 # 同步「最新 Release」
 *   node scripts\sync-releases.mjs --version 1.1.7 # 同步指定版本
 *   node scripts\sync-releases.mjs --check         # 只检查状态，不下载不删除
 *   node scripts\sync-releases.mjs --no-cleanup    # 只下载新版，不清理旧版
 *
 * 设计要点：
 * - 只走 Node 自带 fetch（OpenSSL），不依赖 curl；本机 curl 在 DSH 沙箱里会因
 *   schannel SEC_E_NO_CREDENTIALS 失败，gh 下载又不支持断点续传（曾下到 18MB 被重置）。
 * - 支持 Range 断点续传 + 多镜像 + 多轮重试，121MB 的包断线也能接着下。
 * - 下载到 .part，校验 latest.yml 里的 sha512 之后再原子改名，避免留下半个坏包。
 * - 只动 releases\ 目录，绝不碰 release\、也不安装/覆盖正式版。
 */
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO = 'fjz-hosts/changshipin-jiexi';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(REPO_ROOT, 'releases');
const KEEP_EXTRA = ['README.md']; // releases\ 里允许常驻的说明文件

// 镜像前缀按顺序尝试，空字符串 = 直连 GitHub（放最后）
const MIRRORS = ['https://gh.monlor.com/', 'https://gh-proxy.com/', 'https://hk.gh-proxy.com/', ''];
const MAX_ROUNDS = 6; // 每个文件的整体重试轮数

function log(...args) {
  console.log(...args);
}

function fmtSize(n) {
  if (!Number.isFinite(n)) return '?';
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

function parseArgs(argv) {
  const opts = { version: '', check: false, cleanup: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--version' || a === '-v') opts.version = String(argv[(i += 1)] || '').replace(/^v/i, '').trim();
    else if (a === '--check' || a === '--dry-run') opts.check = true;
    else if (a === '--no-cleanup') opts.cleanup = false;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`未知参数：${a}（用 --help 看用法）`);
  }
  return opts;
}

function ghHeaders() {
  const h = { 'User-Agent': 'changshipin-sync-releases' };
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function assetUrl(version, name) {
  return `https://github.com/${REPO}/releases/download/v${version}/${encodeURIComponent(name)}`;
}

function mirrorUrl(prefix, url) {
  return prefix ? prefix + url : url;
}

/** 取最新 Release 的 tag（不依赖 gh CLI，避免沙箱里子进程取 stdout 失败）。 */
async function resolveLatestVersion() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`查最新 Release 失败：HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
  const data = await res.json();
  if (!data?.tag_name) throw new Error('最新 Release 没有 tag_name');
  if (data.draft || data.prerelease) throw new Error(`最新 Release 是 draft/prerelease：${data.tag_name}`);
  return String(data.tag_name).replace(/^v/i, '');
}

async function fetchText(url) {
  for (const prefix of MIRRORS) {
    try {
      const res = await fetch(mirrorUrl(prefix, url), { headers: ghHeaders() });
      if (!res.ok) continue;
      return await res.text();
    } catch {
      /* 换下一个镜像 */
    }
  }
  throw new Error(`下载失败（所有镜像都不可用）：${path.basename(decodeURIComponent(new URL(url).pathname))}`);
}

/** 从 latest.yml 里取出当前版本安装包的 sha512（base64）和 size。 */
function parseLatestYml(text) {
  const sha512 = (text.match(/^sha512:\s*['"]?([^'"\s]+)['"]?/m) || [])[1] || '';
  const size = Number((text.match(/^\s*size:\s*(\d+)/m) || [])[1] || 0);
  const url = (text.match(/^\s*-\s*url:\s*(\S+)/m) || [])[1] || '';
  return { sha512, size, url };
}

function sha512Base64(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    const stream = createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (c) => hash.update(c));
    stream.on('end', () => resolve(hash.digest('base64')));
  });
}

async function statSize(file) {
  try {
    return (await fs.stat(file)).size;
  } catch {
    return -1;
  }
}

/**
 * 断点续传下载：dest 不存在或比 expected 小时用 Range 接着写。
 * 返回 true 表示文件已完整。
 */
async function downloadWithResume(url, dest, expected) {
  const part = `${dest}.part`;
  for (let round = 1; round <= MAX_ROUNDS; round += 1) {
    let have = await statSize(part);
    if (expected > 0 && have === expected) return true;
    if (have > expected && expected > 0) {
      await fs.rm(part, { force: true });
      have = 0;
    }

    for (const prefix of MIRRORS) {
      const target = mirrorUrl(prefix, url);
      const label = prefix ? new URL(prefix).host : 'github.com';
      try {
        const headers = { 'User-Agent': 'changshipin-sync-releases', 'Accept-Encoding': 'identity' };
        if (have > 0) headers.Range = `bytes=${have}-`;
        const res = await fetch(target, { headers });
        if (res.status !== 200 && res.status !== 206) {
          log(`  [${label}] HTTP ${res.status}，换镜像`);
          continue;
        }
        // 我们要续传但镜像忽略了 Range：从头来
        if (have > 0 && res.status === 200) {
          log(`  [${label}] 不支持续传，从头下载`);
          have = 0;
        }
        const total = expected > 0 ? expected : Number(res.headers.get('content-length') || 0) + have;
        log(`  [${label}] ${res.status === 206 ? '续传' : '下载'} 从 ${fmtSize(have)} / ${fmtSize(total)}`);

        let written = have;
        const out = createWriteStream(part, { flags: have > 0 ? 'a' : 'w' });
        let lastTick = 0;
        try {
          for await (const chunk of res.body) {
            if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
            written += chunk.length;
            const now = Date.now();
            if (now - lastTick > 1500) {
              lastTick = now;
              const pct = total ? ((written / total) * 100).toFixed(1) : '?';
              log(`    ${pct}%  ${fmtSize(written)} / ${fmtSize(total)}`);
            }
          }
        } finally {
          await new Promise((resolve) => out.end(resolve));
        }

        const got = await statSize(part);
        if (expected <= 0 || got === expected) return true;
        log(`  大小不符（${fmtSize(got)} / ${fmtSize(expected)}），第 ${round} 轮重试续传`);
      } catch (err) {
        log(`  [${label}] 中断：${err?.message || err}`);
      }
    }
    await new Promise((r) => setTimeout(r, 1500 * round));
  }
  return false;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    log('用法：node scripts\\sync-releases.mjs [--version X.Y.Z] [--check] [--no-cleanup]');
    return;
  }

  await fs.mkdir(OUT_DIR, { recursive: true });
  const version = opts.version || (await resolveLatestVersion());
  const exeName = `changshipin-Setup-${version}.exe`;
  const exeUrl = assetUrl(version, exeName);
  log(`目标版本：v${version}`);
  log(`输出目录：${OUT_DIR}`);

  const ymlText = await fetchText(assetUrl(version, 'latest.yml'));
  const meta = parseLatestYml(ymlText);
  if (meta.url && meta.url !== exeName) {
    throw new Error(`latest.yml 里的文件名（${meta.url}）和版本 ${version} 不匹配，先确认 Release 是否已构建完`);
  }

  const exePath = path.join(OUT_DIR, exeName);
  const partPath = `${exePath}.part`;
  const haveExe = await statSize(exePath);
  let downloaded = false;

  if (opts.check) {
    log(`\n[检查] ${exeName}：${haveExe > 0 ? '已存在 ' + fmtSize(haveExe) : '缺失'}`);
  } else if (haveExe === meta.size && meta.size > 0) {
    log(`\n已是最新：${exeName}（${fmtSize(haveExe)}），无需下载`);
  } else {
    if (haveExe > 0 && haveExe !== meta.size) log(`本地文件大小异常（${fmtSize(haveExe)}），重新下载`);
    log(`\n开始下载 ${exeName}（${fmtSize(meta.size)}）…`);
    const ok = await downloadWithResume(exeUrl, exePath, meta.size);
    if (!ok) throw new Error(`下载失败：${exeName}（已保留 ${partPath} 以便下次续传）`);

    if (meta.sha512) {
      const actual = await sha512Base64(partPath);
      if (actual !== meta.sha512) {
        await fs.rm(partPath, { force: true });
        throw new Error(`sha512 校验不一致，已删除半成品。期望 ${meta.sha512}，实际 ${actual}`);
      }
      log('  sha512 校验通过');
    }
    await fs.rm(exePath, { force: true });
    await fs.rename(partPath, exePath);
    downloaded = true;
  }

  // latest.yml 一起留一份，便于核对版本 / 自带更新源测试
  if (!opts.check) {
    await fs.writeFile(path.join(OUT_DIR, 'latest.yml'), ymlText, 'utf8');
  }

  // 清理：只留当前版本的 exe + latest.yml（+ README.md）
  const keep = new Set([exeName.toLowerCase(), 'latest.yml', ...KEEP_EXTRA.map((n) => n.toLowerCase())]);
  const entries = await fs.readdir(OUT_DIR, { withFileTypes: true });
  const removed = [];
  const kept = [];
  for (const e of entries) {
    if (e.isDirectory()) continue;
    const name = e.name;
    const lower = name.toLowerCase();
    if (keep.has(lower)) {
      kept.push(name);
      continue;
    }
    const isOldArtifact = /^changshipin-setup-.*\.(exe|blockmap)$/i.test(name) || /\.(part|download)$/i.test(name);
    if (!isOldArtifact) {
      kept.push(name);
      continue;
    }
    if (opts.check) {
      removed.push(`${name}（待清理）`);
      continue;
    }
    if (!opts.cleanup) {
      kept.push(name);
      continue;
    }
    await fs.rm(path.join(OUT_DIR, name), { force: true });
    removed.push(name);
  }

  // 汇报
  log(`\nreleases\\ 现状：`);
  const finalEntries = (await fs.readdir(OUT_DIR, { withFileTypes: true })).filter((e) => e.isFile());
  for (const e of finalEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    const size = await statSize(path.join(OUT_DIR, e.name));
    log(`  ${e.name.padEnd(38)} ${fmtSize(size)}`);
  }
  if (removed.length) {
    log(`\n${opts.check ? '发现待清理的旧版本/残留' : '已清理旧版本/残留'} ${removed.length} 个：${removed.join('、')}`);
  } else log('\n没有需要清理的旧版本。');

  const finalSize = await statSize(exePath);
  const staleExe = finalSize !== meta.size || finalSize <= 0;
  if (opts.check) {
    if (staleExe) log(`\n状态：需要同步（本地 ${fmtSize(finalSize)} / 期望 ${fmtSize(meta.size)}）`);
    else if (removed.length) log('\n状态：安装包已是最新，但 releases\\ 里有旧版本待清理（跑一次不带 --check 即可）');
    else log('\n状态：已是最新');
    process.exitCode = staleExe || removed.length > 0 ? 1 : 0;
    return;
  }
  log(`\n完成：releases\\${exeName}（v${version}，${fmtSize(finalSize)}）${downloaded ? ' 已更新' : ''}`);
}

main().catch((err) => {
  console.error(`\n失败：${err?.message || err}`);
  process.exitCode = 1;
});
