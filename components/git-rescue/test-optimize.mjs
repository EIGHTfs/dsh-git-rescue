/**
 * dsh-git-rescue — flapping 检测器 + 业务就绪探活 单元测试（纯逻辑，不联网）
 *
 *  T12 flapping：窗口内 3 次 → flapping；2 次 → watch；1 次 → ok；窗口滑动
 *  T13 probe：healthy / degraded（API 404）/ down（连接失败）；mock fetch
 *
 * 运行: node test-optimize.mjs
 */

import assert from 'node:assert/strict'
import { createFlappingDetector, DEFAULT_OPTIONS } from './lib/flapping.js'
import { probeDshHealth } from './lib/probe.js'
import { promises as fsp } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { computeScoresFromEvents, refreshScoreSnapshot } from './lib/scores.js'
import { classifyFault } from './lib/fault-classify.js'

let pass = 0
let fail = 0
const failures = []

function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; failures.push(name); console.log(`  ❌ ${name} ${detail}`) }
}

console.log('== T12: flapping 检测 ==')
const d = createFlappingDetector({ windowMs: 10_000, maxRestarts: 3, warnAt: 2 })
const t0 = 1_000_000
let r1 = d.record(t0, 'a')
ok('1 次 → ok', r1.level === 'ok' && r1.count === 1)
let r2 = d.record(t0 + 1000, 'b')
ok('2 次 → watch', r2.level === 'watch' && r2.count === 2)
let r3 = d.record(t0 + 2000, 'c')
ok('3 次 → flapping', r3.level === 'flapping' && r3.count === 3, JSON.stringify(r3))

const d2 = createFlappingDetector({ windowMs: 10_000, maxRestarts: 3 })
d2.record(t0, 'a')
d2.record(t0 + 1000, 'b')
let r4 = d2.record(t0 + 30_000, 'c') // 超出窗口（30s > 10s）→ 旧记录滑出
ok('窗口滑动：超窗后旧记录清除', r4.count === 1 && r4.level === 'ok', JSON.stringify(r4))

const d3 = createFlappingDetector({ windowMs: 10_000, maxRestarts: 3 })
d3.record(t0, 'a')
d3.record(t0 + 1000, 'b')
d3.record(t0 + 2000, 'c')
ok('flapping 前 count() 正确', d3.count(t0 + 5000) === 3)
d3.reset()
ok('reset 后归零', d3.count() === 0)
ok('默认参数合理', DEFAULT_OPTIONS.maxRestarts === 3 && DEFAULT_OPTIONS.windowMs === 600000)

console.log('== T13: 业务就绪探活 ==')
// mock fetch：按路径返回
function makeFetch(routes) {
  return async (url, opts) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '')
    const r = routes[path]
    if (!r) return { status: 404, ok: false }
    return { status: r.status, ok: r.status >= 200 && r.status < 300 }
  }
}

// healthy：根 + api 通（tools 默认关闭）
let h = await probeDshHealth(makeFetch({ '/': { status: 200 }, '/api/git-rescue/status': { status: 200 } }), '127.0.0.1', 3081)
ok('根+插件status通 → healthy（tools 默认关）', h.level === 'healthy', h.level)

// degraded：根 200 但插件 API 404（假活）
let deg = await probeDshHealth(makeFetch({ '/': { status: 200 }, '/api/git-rescue/status': { status: 404 } }), '127.0.0.1', 3081)
ok('根通 插件API 404 → degraded（假活识别）', deg.level === 'degraded', deg.level)

// 显式开启 tools 探测时：tools 404 → degraded
let deg2 = await probeDshHealth(makeFetch({ '/': { status: 200 }, '/api/git-rescue/status': { status: 200 }, '/api/tools': { status: 404 } }), '127.0.0.1', 3081, { toolsPath: '/api/tools' })
ok('显式开启 tools 且 404 → degraded', deg2.level === 'degraded', deg2.level)

// down：根都不通（fetch throw）
let down = await probeDshHealth(async () => { throw new Error('conn refused') }, '127.0.0.1', 3081)
ok('连接失败 → down', down.level === 'down', down.level)

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
if (fail > 0) { console.log('失败项: ' + failures.join(', ')); process.exit(1) }
console.log('全部通过 ✅')

// ============ T17: 救援积分（事件流权威，防刷分） ============
console.log('== T17: 救援积分（事件流权威，防刷分） ==')

const sdir = await fsp.mkdtemp(joinPath(tmpdir(), 'scores-test-'))
await fsp.writeFile(joinPath(sdir, 'events.jsonl'), [
  JSON.stringify({ ts: 1000, type: 'crash-detected', lastHeartbeatAgeMs: 120000 }),
  JSON.stringify({ ts: 2000, type: 'rollback', repo: 'dsh', from: 'aaa', to: 'bbb', scoreType: 'crash' }),
  JSON.stringify({ ts: 3000, type: 'rollback', repo: 'dsh', from: 'ccc', to: 'ddd', scoreType: 'manual' }),
].join('\n'))
await fsp.writeFile(joinPath(sdir, 'guardian-events.jsonl'), JSON.stringify({ time: '2026-08-18T00:00:00Z', level: 'info', msg: '✅ 救援成功：回退到 xyz 后 DSH 恢复正常' }))
const sc = await computeScoresFromEvents(sdir, 'devtest')
ok('积分 total=4', sc.total === 4, `total=${sc.total}`)
ok('积分分类 crash:2/guardian:1/manual:1', sc.byType.crash === 2 && sc.byType.guardian === 1 && sc.byType.manual === 1, JSON.stringify(sc.byType))
// 防刷分：篡改快照文件不影响计算结果
await fsp.writeFile(joinPath(sdir, 'rescue-scores-devtest.json'), JSON.stringify({ total: 999, byType: { crash: 999 } }))
const sc2 = await computeScoresFromEvents(sdir, 'devtest')
ok('篡改快照后积分不变（防刷分）', sc2.total === 4, `total=${sc2.total}`)
const snap = await refreshScoreSnapshot(sdir, 'devtest')
ok('快照刷新覆盖篡改（重新计算）', snap.ok && snap.scores.total === 4, `snap.total=${snap.scores.total}`)
await fsp.rm(sdir, { recursive: true, force: true })

// ============ T18: 故障分类（P0/P1：能回退 vs 不能回退） ============
console.log('== T18: 故障分类（P0/P1） ==')
const fSys = classifyFault({ systemHints: '/vol1 mount ro: zfs (ro) dmesg: Read-only file system' })
ok('系统只读 → 不可回退', fSys.type === 'system' && fSys.recoverable === false, JSON.stringify(fSys))
const fBoot = classifyFault({ bootHints: 'exists and is not a symlink' })
ok('引导软链冲突 → 不可回退', fBoot.type === 'boot' && fBoot.recoverable === false, JSON.stringify(fBoot))
const fPlug = classifyFault({ pluginConfigChanged: true })
ok('插件配置变更 → 可回退', fPlug.type === 'plugin' && fPlug.recoverable === true, JSON.stringify(fPlug))
const fUnk = classifyFault({})
ok('未知 → 保守可回退', fUnk.type === 'unknown' && fUnk.recoverable === true, JSON.stringify(fUnk))
const fSysFirst = classifyFault({ systemHints: 'Read-only file system', bootHints: 'not a symlink', pluginConfigChanged: true })
ok('系统故障优先于插件（不误回退）', fSysFirst.type === 'system' && fSysFirst.recoverable === false, JSON.stringify(fSysFirst))
