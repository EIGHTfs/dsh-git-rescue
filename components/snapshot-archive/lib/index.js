/**
 * dsh-snapshot-archive — 服务器端
 *
 * 独立快照插件：把 .dsh 关键配置按【原始目录结构】打包成 zip（根目录即 .dsh），
 * 同时生成跨平台恢复脚本（.sh / .bat / .ps1），恢复 = 解压 zip 到 .dsh 根即可。
 *
 * 设计（按用户要求简化）：
 * - 快照 = 一个 zip 文件：<snapshotRoot>/<id>.zip
 *   zip 内：manifest.json + 配置文件的原始相对路径（profiles/web/cordis.patch.yml 等）
 *   + _restore/ 目录下三个平台的恢复脚本
 * - 恢复 = 从快照列表选一个 zip，解压到 .dsh 根（覆盖同名文件）
 *   （"撤销"即恢复到上一个快照，是恢复的一种，不单独实现）
 * - API：/api/snapshot-archive/*  (list/status/snapshot/restore/remove)
 */

import { promises as fs, existsSync, watch as fsWatch } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { zipStore, unzipStore } from './zip.js'

export const name = 'dsh-snapshot-archive'
export const inject = ['webServer']

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? homedir()
// DSH_HOME 存在时优先（测试实例隔离、多 profile 场景均依赖它；不认 DSH_HOME 会把快照写到错误目录）
const DSH_ROOT = process.env.DSH_HOME || join(HOME, '.dsh')

/** 从命令行参数识别当前 DSH profile（--profile xxx 或 --profile=xxx）。 */
function detectProfileName() {
  const argv = process.argv ?? []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--profile' && argv[i + 1] && !argv[i + 1].startsWith('-')) return argv[i + 1]
    if (a.startsWith('--profile=')) return a.slice('--profile='.length)
  }
  return 'web'
}

const PROFILE = detectProfileName()

/** 快照根目录：<dshRoot>/snapshot-archive/<profile> */
const SNAPSHOT_ROOT = join(DSH_ROOT, 'snapshot-archive', PROFILE)

/**
 * 要归档的文件清单：键 = 相对 .dsh 的路径，值 = 用途标签。
 * 支持 {profile} 占位符替换为当前 profile 名。
 */
const DEFAULT_WATCH = {
  'profiles/{profile}/cordis.patch.yml': 'plugin-list',
  'profiles/{profile}/package.json': 'plugin-deps',
  'profiles/{profile}/cordis.yml': 'core',
  'profiles/{profile}/pnpm-workspace.yaml': 'core',
  'settings.yaml': 'user-config',
  '.credentials.yaml': 'secrets',
}

let watchSpec = DEFAULT_WATCH
try {
  const raw = await fs.readFile(new URL('./spec.json', import.meta.url), 'utf8')
  const parsed = JSON.parse(raw)
  if (parsed && parsed.watch) watchSpec = parsed.watch
} catch { /* 用默认 */ }

/** 敏感文件：快照内值脱敏为 ***REDACTED***（本机恢复时保留真实值）。 */
const SENSITIVE_BASENAMES = new Set(['.credentials.yaml', '.env'])

/** 判断相对 .dsh 的路径是否敏感（按 basename）。 */
function isSensitiveRel(rel) {
  const base = String(rel).replace(/\\/g, '/').split('/').pop()
  return SENSITIVE_BASENAMES.has(base)
}

// ---------- 基础工具 ----------

async function pathExists(p) {
  try { await fs.access(p); return true } catch { return false }
}

function nowId() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${randomBytes(2).toString('hex')}`
}

/** 敏感值脱敏：支持 .env 的 KEY=value 和 yaml 的 KEY: value 两种格式。 */
function redactText(text, rel) {
  if (!isSensitiveRel(rel)) return text
  const lines = String(text).split('\n')
  return lines.map((line) => {
    const m = line.match(/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.]*)(\s*[:=]\s*)(.*)$/)
    if (!m || !m[3] || m[3].startsWith('#')) return line
    // 值带引号则保留引号结构
    if (m[3].startsWith('"')) return `${m[1]}${m[2]}"***REDACTED***"`
    if (m[3].startsWith("'")) return `${m[1]}${m[2]}'***REDACTED***'`
    return `${m[1]}${m[2]}***REDACTED***`
  }).join('\n')
}

/** 归档路径模板替换：{profile} → 当前 profile 名。 */
function expandRel(template) {
  return String(template).replace('{profile}', PROFILE)
}

/** 计算归档文件在 .dsh 里的真实磁盘路径。 */
function diskPathFor(rel) {
  return join(DSH_ROOT, rel)
}

// ---------- 恢复脚本生成（跨平台） ----------

function restoreScriptSh(zipName) {
  return `#!/bin/sh
# dsh-snapshot-archive 恢复脚本 (Linux/macOS)
# 恢复 = 解压 zip 到 ~/.dsh 根目录（覆盖同名文件）
set -e
DSH_ROOT="\${DSH_ROOT:-$HOME/.dsh}"
ZIP="$(dirname "$0")/${zipName}"
if [ ! -f "$ZIP" ]; then
  echo "错误: 找不到 $ZIP" >&2
  exit 1
fi
echo "解压 $ZIP -> \$DSH_ROOT ..."
if command -v unzip >/dev/null 2>&1; then
  unzip -o "$ZIP" -d "$DSH_ROOT"
else
  echo "未找到 unzip，请手动解压 $ZIP 到 \$DSH_ROOT" >&2
  exit 1
fi
echo "✅ 恢复完成。请重启 DSH 使配置生效。"
`
}

function restoreScriptBat(zipName) {
  return `@echo off
rem dsh-snapshot-archive 恢复脚本 (Windows)
rem 恢复 = 解压 zip 到 %USERPROFILE%\\.dsh 根目录
setlocal
set "DSH_ROOT=%USERPROFILE%\\.dsh"
set "ZIP=%~dp0${zipName}"
if not exist "%ZIP%" (
  echo 错误: 找不到 %ZIP%
  exit /b 1
)
echo 解压 %ZIP% 到 %DSH_ROOT% ...
powershell -NoProfile -Command "Expand-Archive -Path '%ZIP%' -DestinationPath '%DSH_ROOT%' -Force"
if errorlevel 1 (
  echo 解压失败
  exit /b 1
)
echo 恢复完成。请重启 DSH 使配置生效。
`
}

function restoreScriptPs1(zipName) {
  return `# dsh-snapshot-archive 恢复脚本 (Windows PowerShell)
# 恢复 = 解压 zip 到 ~/.dsh 根目录
$ErrorActionPreference = 'Stop'
$DSH_ROOT = Join-Path $HOME '.dsh'
$ZIP = Join-Path $PSScriptRoot '${zipName}'
if (-not (Test-Path $ZIP)) { Write-Error "找不到 $ZIP"; exit 1 }
Write-Host "解压 $ZIP 到 $DSH_ROOT ..."
Expand-Archive -Path $ZIP -DestinationPath $DSH_ROOT -Force
Write-Host '恢复完成。请重启 DSH 使配置生效。'
`
}

/** 生成 zip 内 _restore 脚本内容（供快照打包）。 */
function restoreScriptsFor(zipName) {
  return {
    '_restore/restore-dsh.sh': restoreScriptSh(zipName),
    '_restore/restore-dsh.bat': restoreScriptBat(zipName),
    '_restore/restore-dsh.ps1': restoreScriptPs1(zipName),
    '_restore/README.txt': `DSH Snapshot Archive - 恢复说明
================================

此 zip 是 DSH 配置快照（${nowId()}），内部保留了 .dsh 目录的原始结构。

恢复方法（任选其一）：
1. 运行 _restore/ 目录下的恢复脚本：
   - Linux/macOS: sh restore-dsh.sh
   - Windows:     restore-dsh.bat 或 powershell -File restore-dsh.ps1
2. 或手动把 zip 解压到 ~/.dsh 根目录（覆盖同名文件）。

注意：
- zip 内的路径相对 ~/.dsh（如 profiles/web/cordis.patch.yml）。
- 敏感文件（.credentials.yaml）在快照内为脱敏占位符；本机恢复时
  请保留现有真实密钥（恢复脚本只覆盖配置，不会触碰未备份的真实值）。
- 恢复后请重启 DSH 使配置生效。
`,
  }
}

// ---------- 快照核心 ----------

/** 收集所有要备份的文件（配置 + 可选的用户插件代码，这里先做配置）。 */
async function collectFiles() {
  const entries = []
  for (const rel of Object.keys(watchSpec)) {
    const expanded = expandRel(rel)
    const disk = diskPathFor(expanded)
    if (!(await pathExists(disk))) continue
    try {
      const raw = await fs.readFile(disk)
      const text = raw.toString('utf8')
      const isSensitive = isSensitiveRel(expanded)
      entries.push({ rel: expanded, data: isSensitive ? Buffer.from(redactText(text, expanded), 'utf8') : raw, sensitive: isSensitive })
    } catch (e) { console.error(`[snapshot-archive] 读取失败 ${disk}: ${e.message}`) }
  }
  return entries
}

/** 创建一次快照（zip 归档）。 */
async function createSnapshot(reason = 'manual') {
  await fs.mkdir(SNAPSHOT_ROOT, { recursive: true })
  const id = nowId()
  const files = await collectFiles()
  const manifest = {
    id,
    time: new Date().toISOString(),
    reason,
    profile: PROFILE,
    files: files.map((f) => ({ name: f.rel, size: f.data.length, sensitive: !!f.sensitive })),
    plugin: name,
    version: '1.0.0',
  }
  const zipName = `${id}.zip`
  const zipEntries = [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    ...files.map((f) => ({ name: f.rel, data: f.data })),
    ...Object.entries(restoreScriptsFor(zipName)).map(([n, text]) => ({ name: n, data: Buffer.from(text, 'utf8') })),
  ]
  const zip = zipStore(zipEntries)
  const zipPath = join(SNAPSHOT_ROOT, zipName)
  await fs.writeFile(zipPath, zip)

  return { ok: true, id, path: zipPath, files: manifest.files.length, size: zip.length }
}

/** 列出快照（按时间倒序）。 */
async function listSnapshots() {
  await fs.mkdir(SNAPSHOT_ROOT, { recursive: true })
  const out = []
  const names = await fs.readdir(SNAPSHOT_ROOT)
  for (const n of names.sort().reverse()) {
    if (!n.endsWith('.zip')) continue
    const zipPath = join(SNAPSHOT_ROOT, n)
    try {
      const buf = await fs.readFile(zipPath)
      const files = unzipStore(buf)
      const manifest = files.get('manifest.json')
      if (!manifest) continue
      const m = JSON.parse(manifest.toString('utf8'))
      out.push({ id: m.id, time: m.time, reason: m.reason, profile: m.profile, fileCount: m.files?.length ?? 0, size: buf.length })
    } catch (e) { console.error(`[snapshot-archive] 读取快照失败 ${n}: ${e.message}`) }
  }
  return out
}

/** 恢复一个快照：解压 zip 到 .dsh 根。返回被覆盖的文件列表。 */
async function restoreSnapshot(id) {
  const zipPath = join(SNAPSHOT_ROOT, `${id}.zip`)
  if (!(await pathExists(zipPath))) return { ok: false, error: `快照不存在: ${id}` }
  const buf = await fs.readFile(zipPath)
  const files = unzipStore(buf)
  const restored = []
  const skipped = []
  for (const [rel, data] of files) {
    if (rel === 'manifest.json' || rel.startsWith('_restore/')) continue
    if (rel.includes('..') || rel.startsWith('/') || rel.startsWith('\\')) continue // 路径安全
    const dest = join(DSH_ROOT, rel)
    await fs.mkdir(dirname(dest), { recursive: true })
    // 敏感文件：如果快照里是脱敏占位符，且磁盘已有真实值，跳过（保护密钥）
    if (isSensitiveRel(rel) && data.toString('utf8').includes('***REDACTED***')) {
      if (await pathExists(dest)) { skipped.push({ name: rel, reason: 'sensitive-kept' }); continue }
    }
    await fs.writeFile(dest, data)
    restored.push({ name: rel })
  }
  return { ok: true, restored, skipped }
}

// ---------- API ----------

function send(res, code, obj) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(obj))
}

async function readJson(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  return raw ? JSON.parse(raw) : {}
}

// ---------- 插件入口 ----------

export async function apply(ctx) {
  ctx.inject(['webServer'], async (wctx) => {
    const webServer = wctx.get('webServer')
    if (!webServer) {
      console.warn('[snapshot-archive] webServer 不可用，API 未注册')
      return
    }
    await fs.mkdir(SNAPSHOT_ROOT, { recursive: true }).catch(() => {})

    wctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/api/snapshot-archive',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://dsh.local')
        const path = url.pathname
        const method = req.method ?? 'GET'
        try {
          if (method === 'GET' && path === '/api/snapshot-archive/list') {
            return send(res, 200, { ok: true, snapshots: await listSnapshots() })
          }
          if (method === 'GET' && path === '/api/snapshot-archive/status') {
            const list = await listSnapshots()
            return send(res, 200, { ok: true, count: list.length, root: DSH_ROOT, profile: PROFILE })
          }
          if (method === 'POST' && path === '/api/snapshot-archive/snapshot') {
            const body = await readJson(req)
            const r = await createSnapshot(body?.reason || 'manual')
            return send(res, 200, r)
          }
          if (method === 'POST' && path === '/api/snapshot-archive/restore') {
            const body = await readJson(req)
            if (!body?.id) return send(res, 400, { ok: false, error: '缺少 id' })
            const r = await restoreSnapshot(body.id)
            if (!r.ok) return send(res, 404, r)
            return send(res, 200, r)
          }
          if (method === 'POST' && path === '/api/snapshot-archive/remove') {
            const body = await readJson(req)
            const zipPath = join(SNAPSHOT_ROOT, `${body?.id}.zip`)
            if (await pathExists(zipPath)) await fs.rm(zipPath)
            return send(res, 200, { ok: true })
          }
          return send(res, 404, { ok: false, error: `unknown route ${path}` })
        } catch (error) {
          return send(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }))
  })

  // 注册工具：snapshot_archive_create / snapshot_archive_restore / snapshot_archive_list
  const tools = ctx.get('tools')
  if (tools) {
    tools.register(defineToolSimple('snapshot_archive_create', '创建 DSH 配置快照（zip 归档）', async () => {
      const r = await createSnapshot('tool')
      return r.ok ? `快照已创建: ${r.id} (${r.files} 个文件, ${r.size} 字节)` : `失败: ${r.error}`
    }))
    tools.register(defineToolSimple('snapshot_archive_list', '列出 DSH 配置快照', async () => {
      const list = await listSnapshots()
      if (list.length === 0) return '暂无快照'
      return list.map((s) => `- ${s.id} ${s.time} (${s.reason}, ${s.fileCount} 文件)`).join('\n')
    }))
    tools.register(defineToolSimple('snapshot_archive_restore', '恢复 DSH 配置快照（解压 zip 到 .dsh）', async (args) => {
      const id = args?.id
      if (!id) return '用法: snapshot_archive_restore id=<快照id>'
      const r = await restoreSnapshot(id)
      return r.ok ? `已恢复 ${r.restored.length} 个文件` : `失败: ${r.error}`
    }))
  }

  console.log(`[snapshot-archive] 已启动: root=${DSH_ROOT}, profile=${PROFILE}, snapshotRoot=${SNAPSHOT_ROOT}`)
}

/** 极简工具注册（避免依赖 defineTool 的完整 schema）。 */
function defineToolSimple(name, description, fn) {
  return {
    name,
    description,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
    },
    async execute(args, exec) {
      try { return await fn(args, exec) } catch (e) { return `snapshot-archive 工具错误: ${String(e?.message ?? e)}` }
    },
  }
}
