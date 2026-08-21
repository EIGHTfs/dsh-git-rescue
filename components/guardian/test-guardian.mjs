/**
 * dsh-guardian 隔离测试
 * - 用临时 HOME（假 .dsh）
 * - 造 3 个快照 zip（模拟 dsh-snapshot-archive 格式）
 * - guardian 指向一个不存在的 DSH 端口 → 触发自动回退
 * - 验证：服务启动、API、回退顺序（从新到旧）、最终状态
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { zipStore } from './lib/zip.js'

const SANDBOX = '/tmp/guardian-test'
await fs.rm(SANDBOX, { recursive: true, force: true })
process.env.HOME = SANDBOX

// 造 .dsh 结构
const DSH = join(SANDBOX, '.dsh')
const SNAP = join(DSH, 'snapshot-archive', 'web')
await fs.mkdir(join(DSH, 'profiles', 'web'), { recursive: true })
await fs.mkdir(SNAP, { recursive: true })
await fs.writeFile(join(DSH, 'profiles', 'web', 'cordis.patch.yml'), '# broken\n')

// 造 3 个快照：最新（坏配置）→ 中间（坏）→ 最旧（好配置）
function makeZip(id, reason, patchContent) {
  const files = [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify({ id, time: new Date().toISOString(), reason, files: [{ name: 'profiles/web/cordis.patch.yml', size: patchContent.length }] })) },
    { name: 'profiles/web/cordis.patch.yml', data: Buffer.from(patchContent) },
    { name: 'settings.yaml', data: Buffer.from('a: 1\n') },
    { name: '_restore/restore-dsh.sh', data: Buffer.from('#!/bin/sh\n') },
  ]
  return zipStore(files)
}

// 旧快照 = 好配置（有 dsh-undo 但无坏插件）
const goodPatch = '# good\n- insert:\n    - id: dsh-undo\n'
const badPatch1 = '# bad1\n- insert:\n    - id: bad-plugin-1\n'
const badPatch2 = '# bad2\n- insert:\n    - id: bad-plugin-2\n'

await fs.writeFile(join(SNAP, '20260818-030000-old.zip'), makeZip('20260818-030000-old', '好配置', goodPatch))
await fs.writeFile(join(SNAP, '20260818-031000-mid.zip'), makeZip('20260818-031000-mid', '中间配置', badPatch1))
await fs.writeFile(join(SNAP, '20260818-032000-new.zip'), makeZip('20260818-032000-new', '坏配置', badPatch2))

console.log('沙盒就绪，快照 3 个（new=坏, mid=坏, old=好）')

// 启动 guardian：DSH 端口用 39999（必然失败），阈值 2，间隔 500ms，启动等待 500ms
const { spawn } = await import('node:child_process')
const env = {
  ...process.env,
  HOME: SANDBOX,
  DSH_PORT: '39999',
  GUARDIAN_PORT: '30999',
  GUARDIAN_INTERVAL_MS: '500',
  GUARDIAN_FAIL_THRESHOLD: '2',
  GUARDIAN_START_WAIT_MS: '500',
}
const child = spawn('node', ['server.js'], {
  cwd: '/vol1/@appshare/DeepSeekHarness/workspace/dsh-guardian',
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stdout = ''
child.stdout.on('data', (d) => { stdout += d })
child.stderr.on('data', (d) => { stdout += d })

// 等待服务就绪
await new Promise((r) => setTimeout(r, 1500))

async function apiGet(path) {
  const res = await fetch('http://127.0.0.1:30999' + path)
  return res.json()
}
async function apiPost(path, body) {
  const res = await fetch('http://127.0.0.1:30999' + path, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return res.json()
}

let pass = 0, fail = 0
const check = (name, cond, extra) => { if (cond) { pass++; console.log('  ✅', name) } else { fail++; console.log('  ❌', name, extra ?? '') } }

console.log('=== 1. 服务启动 ===')
const status0 = await apiGet('/api/status')
check('status 可访问', status0.ok)

console.log('=== 2. 快照列表（从新到旧）===')
const snaps = await apiGet('/api/snapshots')
check('3 个快照', snaps.ok && snaps.snapshots.length === 3, snaps.snapshots?.length)
check('顺序: new 最新', snaps.snapshots[0]?.id.includes('new'))

console.log('=== 3. 等待自动回退触发（阈值 2 次失败）===')
// 等 12 秒让回退完整跑完（3 快照 × (恢复+启动500ms+检查+停止)）
await new Promise((r) => setTimeout(r, 12000))
const status1 = await apiGet('/api/status')
check('回退已执行', status1.rollbackTried?.length > 0, JSON.stringify(status1.rollbackTried))
// 因为 DSH 端口 39999 永远失败，回退应尝试所有快照后停在 error
check('最终状态 error（全部失败）', status1.dsh === 'error', status1.dsh)

console.log('=== 4. 回退顺序验证（从新到旧）===')
const tried = status1.rollbackTried || []
check('先试 new', tried[0]?.id.includes('new'), JSON.stringify(tried))
check('再试 mid', tried[1]?.id.includes('mid'))
check('最后 old', tried[2]?.id.includes('old'))

console.log('=== 5. 网页静态服务 ===')
const html = await fetch('http://127.0.0.1:30999/').then((r) => r.text())
check('index.html 可访问', html.includes('DSH Guardian'))

console.log('=== 6. 手动触发回退 API ===')
const rb = await apiPost('/api/rollback', { reason: 'test' })
check('rollback 触发', rb.ok)

console.log('=== 7. 日志 ===')
const logR = await apiGet('/api/log')
check('日志有内容', logR.ok && logR.log.length > 0, logR.log?.length)

// 收尾
child.kill('SIGKILL')
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
if (fail > 0) { console.log('--- guardian 输出 ---'); console.log(stdout.slice(-2000)); process.exit(1) }
console.log('✅ 全部通过')
