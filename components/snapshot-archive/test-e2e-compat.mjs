/**
 * 端到端兼容测试：dsh-snapshot-archive 生成快照 → dsh-guardian 读取并回退
 * 全沙盒模拟，不碰真实 .dsh / DSH 进程。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

const SANDBOX = '/tmp/e2e-compat'
await fs.rm(SANDBOX, { recursive: true, force: true })
process.env.HOME = SANDBOX

// ---------- 第一步：用插件生成真实快照 ----------
const DSH = join(SANDBOX, '.dsh')
await fs.mkdir(join(DSH, 'profiles', 'web'), { recursive: true })
await fs.writeFile(join(DSH, 'profiles', 'web', 'cordis.patch.yml'), '# 原始\n- insert:\n    - id: demo\n')
await fs.writeFile(join(DSH, 'profiles', 'web', 'package.json'), '{"name":"test"}\n')
await fs.writeFile(join(DSH, 'profiles', 'web', 'cordis.yml'), '[]\n')
await fs.writeFile(join(DSH, 'profiles', 'web', 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
await fs.writeFile(join(DSH, 'settings.yaml'), 'agent-default-model:\n  provider: agnes\n')
await fs.writeFile(join(DSH, '.credentials.yaml'), 'DEEPSEEK_API_KEY: sk-secret-999\n')

// 加载插件（mock ctx）生成快照
const mod = await import('/vol1/@appshare/DeepSeekHarness/workspace/dsh-snapshot-archive/lib/index.js?t=' + Date.now())
let handler = null
const ctx = { get: (k) => k === 'webServer' ? { register: h => handler = h } : k === 'tools' ? { register: () => {} } : undefined }
await mod.apply(ctx)
async function pluginReq(method, path, body) {
  const req = { method, url: 'http://x' + path, [Symbol.asyncIterator]: async function*(){ if(body) yield Buffer.from(JSON.stringify(body)) } }
  let code, payload
  const res = { set statusCode(v){ code = v }, get statusCode(){ return code }, setHeader(){}, end(d){ payload = JSON.parse(d) } }
  await handler(req, res)
  return payload
}

let pass = 0, fail = 0
const check = (n, c, x) => { if (c) { pass++; console.log('  ✅', n) } else { fail++; console.log('  ❌', n, x ?? '') } }

console.log('=== 步骤1: 插件创建快照 ===')
const snap = await pluginReq('POST', '/api/snapshot-archive/snapshot', { reason: 'e2e' })
check('插件快照创建成功', snap.ok, JSON.stringify(snap))
check('快照包含 6 个文件', snap.files === 6, snap.files)
const snapId = snap.id

// 验证 zip 落在 guardian 要读的目录
const zipPath = join(DSH, 'snapshot-archive', 'web', snapId + '.zip')
check('zip 在 guardian 读取目录', await fs.access(zipPath).then(() => true).catch(() => false))

// ---------- 第二步：guardian 读取快照 ----------
console.log('=== 步骤2: guardian 读取插件快照 ===')
// 启动 guardian（DSH 端口用 39998 永远失败，触发回退）
const { spawn } = await import('node:child_process')
const env = { ...process.env, HOME: SANDBOX, DSH_PORT: '39998', GUARDIAN_PORT: '30998', GUARDIAN_INTERVAL_MS: '500', GUARDIAN_FAIL_THRESHOLD: '2', GUARDIAN_START_WAIT_MS: '400' }
const child = spawn('node', ['server.js'], { cwd: '/vol1/@appshare/DeepSeekHarness/workspace/dsh-guardian', env, stdio: ['ignore', 'pipe', 'pipe'] })
child.stderr.on('data', (d) => process.stderr.write(d))
await new Promise((r) => setTimeout(r, 1500))

async function gGet(path) { return (await fetch('http://127.0.0.1:30998' + path)).json() }

const snaps = await gGet('/api/snapshots')
check('guardian 能读到插件快照', snaps.ok && snaps.snapshots.length === 1, JSON.stringify(snaps.snapshots))
check('快照 id 一致', snaps.snapshots[0]?.id === snapId)

// 等回退跑完
await new Promise((r) => setTimeout(r, 6000))
const status = await gGet('/api/status')
check('回退尝试了该快照', (status.rollbackTried || []).length >= 1, JSON.stringify(status.rollbackTried))

// ---------- 第三步：guardian 恢复快照内容验证 ----------
console.log('=== 步骤3: guardian 恢复内容验证 ===')
// 改坏 settings.yaml
await fs.writeFile(join(DSH, 'settings.yaml'), 'bad: true\n')
// 手动触发恢复
const restore = await (await fetch('http://127.0.0.1:30998/api/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: snapId }) })).json()
check('手动恢复 ok', restore.ok, JSON.stringify(restore))
const settings = await fs.readFile(join(DSH, 'settings.yaml'), 'utf8')
check('settings.yaml 已恢复', settings.includes('agnes'))
const creds = await fs.readFile(join(DSH, '.credentials.yaml'), 'utf8')
check('密钥保留真实值', creds.includes('sk-secret-999'))

child.kill('SIGKILL')
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
if (fail > 0) process.exit(1)
console.log('✅ 端到端兼容测试全部通过')
