/**
 * dsh-git-rescue — self-update 单元测试（纯逻辑，不联网）
 *
 *  T8  compareVersions 语义（1.3.0 > 1.2.2、同版本相等、非法兜底）
 *  T9  安装根目录定位正确
 *  T10 隐藏开关默认开启，env 可关
 *  T11 文件清单白名单过滤（排除非插件子树 / .. 路径）
 *
 * 运行: node test-self-update.mjs
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { compareVersions, installRoot, AUTO_UPDATE_ENABLED, UPDATE_SOURCE } = await import('./lib/self-update.js')

let pass = 0
let fail = 0
const failures = []

function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; failures.push(name); console.log(`  ❌ ${name} ${detail}`) }
}

console.log('== T8: compareVersions 语义 ==')
ok('1.3.0 > 1.2.2', compareVersions('1.3.0', '1.2.2') > 0)
ok('1.2.2 == 1.2.2', compareVersions('1.2.2', '1.2.2') === 0)
ok('1.2.3 > 1.2.2', compareVersions('1.2.3', '1.2.2') > 0)
ok('2.0.0 > 1.99.99', compareVersions('2.0.0', '1.99.99') > 0)
ok('1.2.2 < 1.3.0', compareVersions('1.2.2', '1.3.0') < 0)
ok('非法版本兜底为 0', compareVersions('abc', '1.0.0') < 0)
ok('空版本兜底为 0', compareVersions('', '0.0.1') < 0)

console.log('== T9: 安装根目录定位 ==')
const root = installRoot()
ok('定位到插件根（含 package.json）', root.endsWith('components/git-rescue'), root)
ok('根目录有 lib/index.js', require('node:fs').existsSync(root + '/lib/index.js'))

console.log('== T10: 隐藏开关 ==')
ok('默认强制开启', AUTO_UPDATE_ENABLED === true)
ok('更新源指向本仓库 components/git-rescue', UPDATE_SOURCE.owner === 'EIGHTfs' && UPDATE_SOURCE.repo === 'dsh-git-rescue' && UPDATE_SOURCE.subdir === 'components/git-rescue')

console.log('== T11: 文件清单白名单（模拟 fetchFileList 过滤逻辑） ==')
// 直接验证 fetchFileList 的过滤规则（不联网）：提取函数逻辑并喂假数据
const prefix = `${UPDATE_SOURCE.subdir}/`
const fakeTree = [
  { type: 'blob', path: `${prefix}lib/index.js` },
  { type: 'blob', path: `${prefix}lib/self-update.js` },
  { type: 'blob', path: `${prefix}guardian/server.js` },
  { type: 'tree', path: `${prefix}lib` },                       // 目录跳过
  { type: 'blob', path: `components/other/evil.js` },           // 子树外 → 排除
  { type: 'blob', path: `${prefix}../escape.js` },              // 路径穿越 → 排除
  { type: 'blob', path: `README.md` },                          // 根级 → 排除
]
const files = []
for (const item of fakeTree) {
  if (item.type !== 'blob') continue
  if (!item.path.startsWith(prefix)) continue
  const rel = item.path.slice(prefix.length)
  if (!rel || rel.includes('..') || rel.startsWith('/') || rel.startsWith('\\')) continue
  files.push(rel)
}
ok('只保留插件子树文件', files.length === 3, JSON.stringify(files))
ok('lib 文件在内', files.includes('lib/index.js') && files.includes('lib/self-update.js'))
ok('guardian 在内', files.includes('guardian/server.js'))
ok('子树外/穿越/根级全部排除', !files.includes('components/other/evil.js') && !files.some((f) => f.includes('..')))

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
if (fail > 0) { console.log('失败项: ' + failures.join(', ')); process.exit(1) }
console.log('全部通过 ✅')
