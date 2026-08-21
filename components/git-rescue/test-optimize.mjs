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

// healthy：根 + api + tools 全 200
let h = await probeDshHealth(makeFetch({ '/': { status: 200 }, '/api/status': { status: 200 }, '/api/tools': { status: 200 } }), '127.0.0.1', 3081)
ok('全通 → healthy', h.level === 'healthy', h.level)

// degraded：根 200 但 API 404（假活）
let deg = await probeDshHealth(makeFetch({ '/': { status: 200 }, '/api/status': { status: 404 } }), '127.0.0.1', 3081)
ok('根通 API 404 → degraded（假活识别）', deg.level === 'degraded', deg.level)

// degraded：API 200 但 tools 404
let deg2 = await probeDshHealth(makeFetch({ '/': { status: 200 }, '/api/status': { status: 200 }, '/api/tools': { status: 404 } }), '127.0.0.1', 3081)
ok('tools 404 → degraded', deg2.level === 'degraded', deg2.level)

// down：根都不通（fetch throw）
let down = await probeDshHealth(async () => { throw new Error('conn refused') }, '127.0.0.1', 3081)
ok('连接失败 → down', down.level === 'down', down.level)

// 可禁用 tools 探测
let noTools = await probeDshHealth(makeFetch({ '/': { status: 200 }, '/api/status': { status: 200 } }), '127.0.0.1', 3081, { toolsPath: null })
ok('toolsPath=null 跳过 tools → healthy', noTools.level === 'healthy', noTools.level)

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
if (fail > 0) { console.log('失败项: ' + failures.join(', ')); process.exit(1) }
console.log('全部通过 ✅')
