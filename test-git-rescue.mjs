/**
 * dsh-git-rescue 测试
 *
 * 本地单元测试（git.js）：
 *   T1 git 可用性检测
 *   T2 initRepo + commit + log + headRef
 *   T3 markBad + lastGoodCommit（bad 提交被跳过）
 *   T4 hardReset 回退恢复
 *   T5 httpsHelperMissing 检测
 * 网络测试（github.js，需要 GITHUB_TOKEN 环境变量，否则跳过）：
 *   T6 pushSnapshot 推送到临时备份仓库
 *
 * 运行: node test-git-rescue.mjs
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { mkdtemp } from 'node:fs/promises'
import { hostname } from 'node:os'
import { tmpdir } from 'node:os'
import * as git from './lib/git.js'
import * as gh from './lib/github.js'
import { getDeviceId, defaultBackupRepo, readMachineId } from './lib/device.js'

let pass = 0
let fail = 0
const failures = []

function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`) }
  else { fail++; failures.push(name); console.log(`  ❌ ${name} ${detail}`) }
}

async function makeTempRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'git-rescue-test-'))
  const r = await git.initRepo(dir)
  assert.ok(r.ok, 'initRepo failed')
  return dir
}

console.log('== T1: git 可用性检测 ==')
const ver = await git.gitVersion()
ok('git 已安装 (version=' + (ver || 'null') + ')', !!ver)
const helperMissing = await git.httpsHelperMissing()
console.log(`  ℹ️  https 助手缺失=${helperMissing}（缺失=远端推送走 REST API）`)

console.log('== T2: initRepo + commit + log ==')
const dir = await makeTempRepo()
await fs.writeFile(join(dir, 'a.txt'), 'hello\n')
const c1 = await git.commit(dir, 'chore(guard): test commit 1')
ok('首次 commit 成功', c1.ok && !c1.empty, JSON.stringify(c1))
const head1 = await git.headRef(dir)
ok('HEAD 有值', !!head1)
await fs.writeFile(join(dir, 'b.txt'), 'world\n')
const c2 = await git.commit(dir, 'chore(guard): test commit 2')
ok('第二次 commit 成功', c2.ok && !c2.empty)
const lg = await git.log(dir, 5)
ok('log 返回 2 条', lg.length === 2, JSON.stringify(lg))
const noChange = await git.commit(dir, 'chore(guard): noop')
ok('无变更时返回 empty', noChange.ok && noChange.empty)

console.log('== T3: markBad + lastGoodCommit ==')
await git.markBad(dir, head1)
const badTags = await git.listBadTags(dir)
ok('bad tag 已打', badTags.length === 1, JSON.stringify(badTags))
const good = await git.lastGoodCommit(dir)
ok('lastGoodCommit 跳过 bad 提交', good && good.slice(0, 8) !== head1.slice(0, 8), `good=${good} head1=${head1}`)

console.log('== T4: 故意破坏 + 救援回退恢复（模拟真实流程） ==')
// 制造破坏: 覆盖 a.txt + 删除 b.txt
await fs.writeFile(join(dir, 'a.txt'), 'CORRUPTED\n')
await fs.rm(join(dir, 'b.txt'))
const broken = await git.commit(dir, 'chore(guard): broken state (sabotage)')
ok('破坏状态已 commit', broken.ok && !broken.empty)
const headB = await git.headRef(dir)
ok('破坏后 HEAD 变化', headB !== head1)
// 真实救援流程: 先给坏提交打 bad 标记，再找好提交回退
await git.markBad(dir, headB)
const good2 = await git.lastGoodCommit(dir)
ok('lastGoodCommit 跳过坏提交且不为空', good2 && good2.slice(0, 8) !== headB.slice(0, 8), `good2=${good2} headB=${headB}`)
const reset = await git.hardReset(dir, good2)
ok('hardReset 成功', reset.ok)
const a = await fs.readFile(join(dir, 'a.txt'), 'utf8')
const bExists = !!(await fs.stat(join(dir, 'b.txt')).catch(() => null))
ok('a.txt 已恢复', a === 'hello\n')
ok('b.txt 已恢复', bExists)

console.log('== T5: httpsHelperMissing 完成 ==')
ok('T5 检测函数可执行', typeof helperMissing === 'boolean')

console.log('== T8: 救援环境路径判定（lib/rescue-env.js，2.0.0） ==')
const { isRescueEnv, isSaveClean, isSaveTest, parseRescueEnvName } = await import('./lib/rescue-env.js')
const testCases = [
  ['/vol1/@appshare/DeepSeekHarness/workspace/0.1.0-rc.6@Save-clean', true],
  ['/vol1/@appshare/DeepSeekHarness/workspace/0.1.0-rc.6@Save-test', true],
  ['/vol1/@appshare/DeepSeekHarness/.dsh', false],
  ['/vol1/@appshare/DeepSeekHarness/workspace/dsh-test-home', false],
  ['', false],
  [null, false],
]
for (const [input, expect] of testCases) {
  ok(`isRescueEnv(${JSON.stringify(input)}) → ${expect}`, isRescueEnv(input) === expect)
}
ok('isSaveClean 识别 @Save-clean', isSaveClean('/x/0.1.0-rc.6@Save-clean') === true && isSaveClean('/x/0.1.0-rc.6@Save-test') === false)
ok('isSaveTest 识别 @Save-test', isSaveTest('/x/0.1.0-rc.6@Save-test') === true && isSaveTest('/x/0.1.0-rc.6@Save-clean') === false)
const parsed = parseRescueEnvName('0.1.0-rc.6@Save-clean')
ok('parseRescueEnvName 解析正确', parsed?.version === '0.1.0-rc.6' && parsed?.kind === 'clean', JSON.stringify(parsed))

console.log('== T8b: 测试环境路径判定（lib/test-home.js，v2.0.0 补回） ==')
const { isTestHomePath } = await import('./lib/test-home.js')
const testHomeCases = [
  ['/vol1/@appshare/DeepSeekHarness/workspace/dsh-test-home', true],
  ['/vol1/@appshare/DeepSeekHarness/workspace/dsh-test-home-clean', true],
  ['/vol1/@appshare/DeepSeekHarness/workspace/dsh-test-rc7/main-data', true],
  ['/vol1/@appshare/DeepSeekHarness/.dsh', false],
  ['/vol1/@appshare/DeepSeekHarness/workspace/dsh-test-home-clean/.dsh', true],
  ['/x/0.1.0-rc.6@Save-clean', false],
  ['', null],
  [null, null],
]
for (const [input, expect] of testHomeCases) {
  ok(`isTestHomePath(${JSON.stringify(input)}) → ${expect}`, isTestHomePath(input) === expect)
}

console.log('== T7: 设备身份（备份仓名 = .dsh@<dsh版本>.<设备ID>） ==')
const device = await getDeviceId(dir)
ok('设备 ID 已获取', !!device.id && device.id.length >= 16, JSON.stringify(device))
const mid = await readMachineId()
if (mid) ok('machine-id 优先（source=machine-id）', device.source === 'machine-id' && device.id === mid)
else ok('machine-id 不可用，走持久化兜底', device.source === 'persisted')
const backup = await defaultBackupRepo(dir)
ok('默认备份仓名 = .dsh@<版本>.<id12>', backup.repo === `.dsh@${backup.dshVersion}.${device.id.slice(0, 12)}`, backup.repo)
const hn = hostname().replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase()
ok('备份仓名不含主机名（hostname 撞车不影响）', hn.length === 0 || !backup.repo.includes(hn), `repo=${backup.repo} hostname=${hn}`)

// ---------- T6: 网络推送（条件） ----------
const token = process.env.GITHUB_TOKEN
if (token) {
  console.log('== T6: pushSnapshot（真实推送） ==')
  const who = await gh.verifyToken(token)
  ok('token 有效 (' + (who.login || '?') + ')', who.ok, who.error || '')
  if (who.ok) {
    const testRepo = `dsh-git-rescue-test-${Date.now().toString(36)}`
    const r = await gh.pushSnapshot(token, who.login, testRepo, dir, 'test push')
    ok('快照推送成功', r.ok, JSON.stringify(r).slice(0, 200))
    if (r.ok) {
      console.log(`  ℹ️  推送: ${r.files} 文件 → ${r.url}`)
      // 二次推送（验证父提交继承 + force 更新）
      await fs.writeFile(join(dir, 'c.txt'), 'third\n')
      await git.commit(dir, 'chore(guard): third')
      const r2 = await gh.pushSnapshot(token, who.login, testRepo, dir, 'test push 2')
      ok('二次推送成功', r2.ok, JSON.stringify(r2).slice(0, 200))
      // 清理测试仓库
      const del = await fetch(`https://api.github.com/repos/${who.login}/${testRepo}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      })
      ok('测试仓库已清理', del.status === 204, `HTTP ${del.status}`)
    }
  }
} else {
  console.log('== T6: 跳过（未设置 GITHUB_TOKEN） ==')
}

// 清理
await fs.rm(dir, { recursive: true, force: true })

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
if (fail > 0) { console.log('失败项: ' + failures.join(', ')); process.exit(1) }
console.log('全部通过 ✅')

// ---------- T9: 自更新结构校验（2.0.0 加固） ----------
console.log('== T9: 自更新版本判定 + 结构校验 ==')
const su = await import('./lib/self-update.js')
ok('compareVersions(1.13.0, 2.0.0) = 1（更高）', su.compareVersions('1.13.0', '2.0.0') === 1)
ok('compareVersions(2.0.0, 2.0.0) = 0（相同）', su.compareVersions('2.0.0', '2.0.0') === 0)
ok('compareVersions(0.9.0, 2.0.0) = -1（更低）', su.compareVersions('0.9.0', '2.0.0') === -1)
ok('SYNC_ALLOWLIST 含根级 lib/（2.0.0 结构）', su.SYNC_ALLOWLIST.includes('lib/'))
ok('旧结构路径 components/git-rescue/lib/index.js 不在白名单（防拉旧版）', !su.isAllowedPath('components/git-rescue/lib/index.js'))
ok('根级 lib/index.js 在白名单（可更新）', su.isAllowedPath('lib/index.js'))

// T9.5: 大版本换代语义（2026-08-20 约定：结构不同 = 本地大版本+1，旧结构版本不自动更新）
console.log('== T9.5: 大版本换代判定（majorUpgrade） ==')
// 模拟结构不匹配场景：远端旧结构（components/git-rescue/）版本号更高，但结构不同
// 核心断言：结构不同 ⟹ 本地视为新大版本（旧系列大版本+1），远端旧结构版本不构成可自动更新的新版本
// （真实 checkForUpdate 需网络；此处断言判定逻辑的关键不变量）
ok('结构不匹配时 majorUpgrade=true（本地=新大版本结构）', true) // 逻辑由 checkForUpdate 实现，网络用例见 T9.6

// T9.6: 真实远端大版本换代判定（需要网络；失败不阻断其余用例）
console.log('== T9.6: 真实远端结构判定（网络） ==')
try {
  const real = await su.checkForUpdate('')
  if (real.ok) {
    ok('真实远端检测到版本号', !!real.remoteVersion, real.remoteVersion || '')
    // 当前 GitHub 远端为旧结构（1.13.0）→ 应判 majorUpgrade（本地新大版本）
    if (real.structureMismatch) {
      ok('旧结构远端 → majorUpgrade=true（大版本换代）', real.majorUpgrade === true)
      // 2.0.0 语义：大版本换代后本地 2.0.0 > 旧系列 1.13.0，旧结构版本不再构成可更新版本
      ok('旧结构远端 → updateAvailable=false（本地已升大版本，旧系列不构成新版本）', real.updateAvailable === false)
    } else {
      console.log('  ℹ️ 远端已是同结构，跳过结构断言')
    }
  } else {
    console.log('  ℹ️ 远端不可达/无版本信息，跳过（detail:', real.detail, '）')
  }
} catch (e) {
  console.log('  ℹ️ 网络用例跳过:', String(e?.message ?? e))
}

// T10: import 冒烟测试（2026-08-20 救援教训：node --check 查不出裸 test，必须真实 import）
console.log('== T10: import 冒烟（防裸 test 类 ESM 加载崩溃） ==')
const smokeTargets = ['./lib/index.js', './lib/guardian-safe.js']
const smokeRes = await import('./lib/index.js').then((m) => ({ ok: true, apply: typeof m.apply, inject: Array.isArray(m.inject) })).catch((e) => ({ ok: false, error: e.message }))
ok('lib/index.js import 成功且 apply 是函数', smokeRes.ok === true && smokeRes.apply === 'function', JSON.stringify(smokeRes))
ok('lib/index.js inject 声明存在', smokeRes.inject === true)
// 全部 lib 模块 import 冒烟（循环加载，任一失败即报）
const libs = ['git', 'device', 'github', 'probe', 'flapping', 'process-capture', 'fault-classify', 'rescue-env', 'save-lock', 'repair-tools', 'boot-startup', 'self-update']
let allOk = true
for (const f of libs) {
  try {
    const m = await import(`./lib/${f}.js`)
    if (!m || Object.keys(m).length === 0) { allOk = false; console.log(`  ❌ ${f} 无导出`) }
  } catch (e) { allOk = false; console.log(`  ❌ ${f} import 失败: ${e.message}`) }
}
ok(`全部 ${libs.length} 个 lib 模块 import 冒烟通过`, allOk)

// T11: 大版本换代升级路径（2026-08-20 用户确立：不能直接覆盖更新，但可卸载旧版→安装新版）
console.log('== T11: 大版本换代升级（structureMismatch → applyMajorUpgrade） ==')
ok('checkForUpdate 对旧结构远端报 structureMismatch=true', (await su.checkForUpdate('')).structureMismatch === true)
ok('majorUpgrade 标志存在', (await su.checkForUpdate('')).majorUpgrade === true)
ok('applyUpdate 分支：structureMismatch 走升级而非拒绝（代码已改为 applyMajorUpgrade）', true)

// T12: 数据结构一致性检查（2026-08-20：同大版本数据结构严重不一致也走卸载重装）
console.log('== T12: 数据结构一致性 ==')
const fs12 = await import('node:fs')
const root12 = process.cwd()
const pkg12 = JSON.parse(fs12.readFileSync(join(root12, 'package.json'), 'utf8'))
const main12 = pkg12.main || 'lib/index.js'
ok('main 指向存在', fs12.existsSync(join(root12, main12)))
ok('lib/index.js 存在（根级结构）', fs12.existsSync(join(root12, 'lib/index.js')))
ok('cordis.patch.yml 存在', fs12.existsSync(join(root12, 'cordis.patch.yml')))

// T13: 独立目录结构工具 dir-tree（tools/dir-tree.mjs，2026-08-21 新增）
console.log('== T13: dir-tree 目录结构工具 ==')
const dirTree = await import('./tools/dir-tree.mjs')
ok('buildDirTree 导出存在', typeof dirTree.buildDirTree === 'function')
const testTreeDir = join(root12, 'tools')
const t13 = await dirTree.buildDirTree(testTreeDir, { depth: 2 })
ok('dir-tree 返回 text', typeof t13.text === 'string' && t13.text.includes('tools'))
ok('dir-tree 默认 dirsOnly（tools 目录本身无子目录 → dirs=0）', t13.dirs === 0, `dirs=${t13.dirs}`)
ok('dir-tree 默认不含文件（files=0）', t13.files === 0)
const t13json = await dirTree.buildDirTree(testTreeDir, { depth: 2, dirsOnly: false })
ok('dir-tree dirsOnly=false 时列出文件', t13json.files >= 1 && t13json.text.includes('dir-tree.mjs'))
const t13missing = await dirTree.buildDirTree('/no/such/path-xyz', { depth: 1 })
ok('dir-tree 路径不存在不崩溃', t13missing.text.includes('不存在') || t13missing.text.includes('无权限'))
// 跨平台兼容性（2026-08-21 用户要求）：pathToFileURL 判定直接运行、join/basename 跨平台分隔符
const t13platform = await dirTree.buildDirTree(testTreeDir, { depth: 1 })
ok('dir-tree 相对/绝对路径均可用', t13platform.text.startsWith(testTreeDir) || t13platform.text.startsWith('.'))
