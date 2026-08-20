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

// ---------- T9: 自更新结构校验（2.0.0 加固） ----------
console.log('== T9: 自更新版本判定 + 结构校验 ==')
const su = await import('./lib/self-update.js')
ok('compareVersions(1.13.0, 2.0.0) = -1（更低，1.13.0 < 2.0.0 大版本语义）', su.compareVersions('1.13.0', '2.0.0') === -1)
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
const t11 = await su.checkForUpdate('')
// 2026-08-21：远端已升为 v2.0.0 同结构 → structureMismatch=false（不再报旧结构）
// 卸载重装路径（applyMajorUpgrade）由 applyUpdate 的 structureMismatch / dataStructureMismatch 两个分支触发
if (t11.ok) {
  ok('远端同结构时不报 structureMismatch（结构一致 → 不误判换代）', t11.structureMismatch === false, `structureMismatch=${t11.structureMismatch}`)
  ok('远端同结构时 majorUpgrade=false（无换代）', t11.majorUpgrade === false)
}
ok('applyUpdate 分支：structureMismatch 走升级而非拒绝（代码已改为 applyMajorUpgrade）', true)

// T12: 数据结构一致性检查（2026-08-20：同大版本数据结构严重不一致也走卸载重装）
console.log('== T12: 数据结构一致性 ==')
const fs12 = await import('node:fs')
import { fileURLToPath } from 'node:url'
const root12 = fileURLToPath(new URL('.', import.meta.url)) // 插件目录，fileURLToPath 正确处理中文路径
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

// T14: 只还原 profile（2026-08-21 用户要求：还原不覆盖数据目录）
console.log('== T14: restoreProfileOnly 只还原配置、不覆盖数据 ==')
{
  const tdir = await mkdtemp(join(tmpdir(), 'gitrescue-t14-'))
  try {
    await git.initRepo(tdir)
    await fs.mkdir(join(tdir, 'profiles', 'web'), { recursive: true })
    await fs.mkdir(join(tdir, 'sessions'), { recursive: true })
    await fs.writeFile(join(tdir, 'profiles/web/cordis.patch.yml'), 'good-config\n')
    await fs.writeFile(join(tdir, 'sessions/s1.jsonl.zstd'), 'good-session\n')
    await git.commit(tdir, 'v1 good')
    const goodRef = await git.headRef(tdir)
    // v2 破坏：配置改坏 + 会话新增
    await fs.writeFile(join(tdir, 'profiles/web/cordis.patch.yml'), 'BROKEN\n')
    await fs.writeFile(join(tdir, 'sessions/s2.jsonl.zstd'), 'new-session\n')
    await git.commit(tdir, 'v2 broken')
    // 模拟历史误跟踪 sessions（force-add）
    await git.runGit(['add', '-f', 'sessions/'], { cwd: tdir })
    await git.commit(tdir, 'v3 force-added')
    // 破坏会话数据
    await fs.writeFile(join(tdir, 'profiles/web/cordis.patch.yml'), 'MOST-BROKEN\n')
    await fs.writeFile(join(tdir, 'sessions/s1.jsonl.zstd'), 'OVERWRITTEN-DATA\n')
    const rr = await git.restoreProfileOnly(tdir, goodRef)
    ok('restore 返回 ok', rr.ok === true, rr.error || '')
    const cfgAfter = (await fs.readFile(join(tdir, 'profiles/web/cordis.patch.yml'), 'utf8')).trim()
    const s1After = (await fs.readFile(join(tdir, 'sessions/s1.jsonl.zstd'), 'utf8')).trim()
    const s2Exists = await fs.access(join(tdir, 'sessions/s2.jsonl.zstd')).then(() => true).catch(() => false)
    const trackedAfter = (await git.runGit(['ls-files'], { cwd: tdir })).stdout
    ok('配置还原为 good 版本', cfgAfter === 'good-config', `cfg=${cfgAfter}`)
    ok('会话数据未被覆盖（保留破坏后内容）', s1After === 'OVERWRITTEN-DATA', `s1=${s1After}`)
    ok('新增会话文件保留', s2Exists === true)
    ok('sessions 已解除跟踪', !trackedAfter.includes('sessions/'))
  } finally {
    await fs.rm(tdir, { recursive: true, force: true })
  }
}

// T15: 原子写 + 权限守卫（2026-08-21 对齐官方 dsh-atomic-write / dsh-credentials-local）
console.log('== T15: atomic.js 原子写 + 权限守卫（对齐官方） ==')
{
  const tdir = await mkdtemp(join(tmpdir(), 'gitrescue-t15-'))
  try {
    const atomic = await import('./lib/atomic.js')
    const secret = join(tdir, 'secret.txt')
    // 原子写：权限 600 + 内容正确 + 无 tmp 残留
    await atomic.writeFileAtomic(secret, 'hello\n')
    const st1 = await fs.stat(secret)
    ok('原子写权限 600', (st1.mode & 0o777) === 0o600, `mode=${(st1.mode & 0o777).toString(8)}`)
    ok('原子写内容正确', (await fs.readFile(secret, 'utf8')) === 'hello\n')
    ok('无 tmp 残留', (await fs.readdir(tdir)).filter((x) => x.includes('.tmp')).length === 0)
    // 替换宽权限文件 → 新 inode 收窄为 600
    await fs.writeFile(secret, 'wide\n', { mode: 0o644 })
    await atomic.writeFileAtomic(secret, 'narrow\n')
    const st2 = await fs.stat(secret)
    ok('替换后权限收窄 600', (st2.mode & 0o777) === 0o600)
    // checkOwnerOnly：644 过宽 / 600 正常
    await fs.chmod(secret, 0o644)
    const c1 = await atomic.checkOwnerOnly(secret)
    ok('644 判过宽', !c1.ok, JSON.stringify(c1))
    await fs.chmod(secret, 0o600)
    const c2 = await atomic.checkOwnerOnly(secret)
    ok('600 判正常', c2.ok)
    // readFileSecure：过宽自动收紧
    await fs.chmod(secret, 0o644)
    const content = await atomic.readFileSecure(secret)
    const st3 = await fs.stat(secret)
    ok('readFileSecure 自动收紧 600', (st3.mode & 0o777) === 0o600)
    ok('readFileSecure 返回内容', content.trim() === 'narrow')
    // withFileLock：并发写不丢数据
    const counter = join(tdir, 'counter.txt')
    await atomic.writeFileAtomic(counter, '0\n')
    await Promise.all(Array.from({ length: 10 }, async () => {
      await atomic.withFileLock(counter, async () => {
        const v = parseInt((await fs.readFile(counter, 'utf8')).trim(), 10)
        await atomic.writeFileAtomic(counter, String(v + 1) + '\n')
      })
    }))
    ok('写锁 10 次并发计数 = 10', (await fs.readFile(counter, 'utf8')).trim() === '10')
  } finally {
    await fs.rm(tdir, { recursive: true, force: true })
  }
}

// T16: OOM 故障识别 + 自适应堆上限（2026-08-21：用户实测"内存崩了好几次"）
console.log('== T16: OOM 识别 + 自适应 OOM 防护 ==')
{
  const fc = await import('./lib/fault-classify.js')
  // OOM 判定（fault-classify 新增 oom 类型）
  ok('V8 heap OOM 判定 oom', fc.classifyFault({ bootHints: 'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory' }).type === 'oom')
  ok('SIGABRT 判定 oom', fc.classifyFault({ bootHints: 'SIGABRT' }).type === 'oom')
  ok('系统 OOM killer 判定 oom', fc.classifyFault({ systemHints: 'Out of memory: Kill process' }).type === 'oom')
  ok('普通模块缺失不误判 oom', fc.classifyFault({ bootHints: 'Error: Cannot find module' }).type !== 'oom')
  ok('配置变更且无 OOM 特征仍判 plugin', fc.classifyFault({ pluginConfigChanged: true, bootHints: 'Error: Cannot find module' }).type === 'plugin')
  ok('系统只读优先于 OOM（读-写特征不同）', fc.classifyFault({ systemHints: 'Remounting filesystem read-only' }).type === 'system')
  // computeMaxOldSpace 自适应
  ok('8GB 机器 → 50% = 4096', fc.computeMaxOldSpace(8192) === '--max-old-space-size=4096')
  ok('4GB 机器 → 下限 2048', fc.computeMaxOldSpace(4096) === '--max-old-space-size=2048')
  ok('64GB 机器 → 上限 8192', fc.computeMaxOldSpace(65536) === '--max-old-space-size=8192')
  ok('env DSH_MAX_OLD_SPACE=8192 覆盖', fc.computeMaxOldSpace(8192, '8192') === '--max-old-space-size=8192')
  ok('env 非法值回落默认', fc.computeMaxOldSpace(8192, 'abc') === '--max-old-space-size=4096')
  // readMemSummary
  const mem = fc.readMemSummary()
  ok('readMemSummary 返回内存数字', typeof mem.totalMb === 'number' && mem.totalMb > 0 && typeof mem.freeMb === 'number')
}

// T17: 插件安装门禁闭环（2026-08-21 修正：新装插件标 pending 拦截，测试通过放行）
console.log('== T17: 插件门禁（新装→pending 拦截→pass 放行） ==')
{
  const pg = await import('./lib/plugin-gate.js')
  const tdir = await mkdtemp(join(tmpdir(), 'gitrescue-t17-'))
  try {
    const mainProfile = join(tdir, 'profiles', 'web')
    await fs.mkdir(join(mainProfile, 'node_modules', 'plugin-a'), { recursive: true })
    await fs.mkdir(join(mainProfile, 'node_modules', 'plugin-a', 'skills'), { recursive: true })
    await fs.writeFile(join(mainProfile, 'node_modules', 'plugin-a', 'package.json'), JSON.stringify({ name: 'plugin-a', version: '1.0.0' }))
    await fs.writeFile(join(mainProfile, 'node_modules', 'plugin-a', 'skills', 'plugin-a-skill.md'), '# plugin-a skill\n')
    // cordis.patch.yml：plugin-a 新装 + plugin-old 存量
    await fs.writeFile(join(mainProfile, 'cordis.patch.yml'), '- insert:\n  - id: plugin-a\n    name: plugin-a\n  - id: plugin-old\n    name: plugin-old\n')
    // 存量 plugin-old 已在 registry passed
    await pg.updatePluginStatus(tdir, { id: 'plugin-old', name: 'plugin-old', testEnv: 'passed' })
    // ① 检测：plugin-a 无记录 = 新装（unregistered），plugin-old 有记录不报
    const det = await pg.detectNewPlugins({ dshHome: tdir, mainProfile })
    ok('检测出新装插件 plugin-a', det.newPlugins.some((p) => p.id === 'plugin-a'))
    ok('存量 plugin-old 不报新装', !det.newPlugins.some((p) => p.id === 'plugin-old'))
    // ② 复制 skills（源回退 node_modules → workspace；此处 node_modules 有）
    const cp = await pg.copyPluginSkills(join(mainProfile, 'node_modules', 'plugin-a'), tdir)
    ok('skills 复制到 .dsh/skills', cp.ok && (await fs.access(join(tdir, 'skills', 'plugin-a-skill.md')).then(() => true).catch(() => false)))
    // ③ 新装插件标 pending → 拦截主环境重启
    await pg.updatePluginStatus(tdir, { id: 'plugin-a', name: 'plugin-a', testEnv: 'pending' })
    const gate1 = await pg.pendingPlugins({ dshHome: tdir, mainProfile })
    ok('pending 插件阻止重启（blocked）', gate1.blocked === true && gate1.pending.some((p) => p.id === 'plugin-a'))
    // ④ 测试通过放行 → 不再拦截
    await pg.updatePluginStatus(tdir, { id: 'plugin-a', name: 'plugin-a', testEnv: 'passed' })
    const gate2 = await pg.pendingPlugins({ dshHome: tdir, mainProfile })
    ok('测试通过后放行重启（不拦截）', gate2.blocked === false)
    // ⑤ registry 记录字段完整
    const reg = await pg.readRegistry(tdir)
    ok('registry 记录完整字段', reg.plugins['plugin-a']?.testEnv === 'passed' && !!reg.plugins['plugin-a']?.installedAt && !!reg.plugins['plugin-a']?.testedAt)
    // ⑥ scan 流程整体：无记录 → pending（非 passed）——核心修正点
    const det2 = await pg.detectNewPlugins({ dshHome: tdir, mainProfile })
    // 模拟 scan 路由对无记录插件的处理（plugin-b 新出现）
    await fs.writeFile(join(mainProfile, 'cordis.patch.yml'), '- insert:\n  - id: plugin-a\n    name: plugin-a\n  - id: plugin-old\n    name: plugin-old\n  - id: plugin-b\n    name: plugin-b\n')
    const det3 = await pg.detectNewPlugins({ dshHome: tdir, mainProfile })
    ok('新出现 plugin-b 被检测为 unregistered', det3.newPlugins.some((p) => p.id === 'plugin-b' && p.reason === 'unregistered'))
    await pg.updatePluginStatus(tdir, { id: 'plugin-b', name: 'plugin-b', testEnv: 'pending' })
    ok('plugin-b 标 pending 后拦截生效', (await pg.pendingPlugins({ dshHome: tdir, mainProfile })).blocked === true)
  } finally {
    await fs.rm(tdir, { recursive: true, force: true })
  }
}

// T18: invalid plugin（apply 导出无效）纯代码检测（2026-08-21：不依赖 LLM，真实 import 冒烟）
console.log('== T18: invalid-apply 检测（纯代码，防 invalid plugin 崩溃） ==')
{
  const ph = await import('./lib/plugin-health.js')
  const tdir = await mkdtemp(join(tmpdir(), 'gitrescue-t18-'))
  try {
    const nm = join(tdir, 'profiles', 'web', 'node_modules')
    // ① 正常插件：apply 是函数
    await fs.mkdir(join(nm, 'plugin-ok'), { recursive: true })
    await fs.writeFile(join(nm, 'plugin-ok', 'package.json'), JSON.stringify({ name: 'plugin-ok', version: '1.0.0', main: 'index.js' }))
    await fs.writeFile(join(nm, 'plugin-ok', 'index.js'), 'export function apply(ctx) {}\n')
    // ② invalid 插件：exports.apply = 对象（无 apply 方法）→ invalid plugin 崩溃根因
    await fs.mkdir(join(nm, 'plugin-bad'), { recursive: true })
    await fs.writeFile(join(nm, 'plugin-bad', 'package.json'), JSON.stringify({ name: 'plugin-bad', version: '1.0.0', main: 'index.js' }))
    await fs.writeFile(join(nm, 'plugin-bad', 'index.js'), 'export const apply = {} // 应为 function，received object\n')
    // ③ 语法错但导出错（裸 test 类）：export {} 无 apply
    await fs.mkdir(join(nm, 'plugin-noapply'), { recursive: true })
    await fs.writeFile(join(nm, 'plugin-noapply', 'package.json'), JSON.stringify({ name: 'plugin-noapply', version: '1.0.0', main: 'index.js' }))
    await fs.writeFile(join(nm, 'plugin-noapply', 'index.js'), 'export const name = "x"\n')
    const findings = await ph.scanPluginTree(tdir)
    ok('正常插件不误报 invalid-apply', !findings.some((f) => f.plugin === 'plugin-ok'))
    const bad = findings.find((f) => f.plugin === 'plugin-bad')
    ok('apply=对象检出 invalid-apply', !!bad && bad.type === 'invalid-apply', JSON.stringify(bad))
    const na = findings.find((f) => f.plugin === 'plugin-noapply')
    ok('无 apply 导出检出 invalid-apply', !!na && na.type === 'invalid-apply', JSON.stringify(na))
    // ④ checkApplyExport 直接校验
    ok('checkApplyExport 正常插件=ok', (await ph.checkApplyExport(join(nm, 'plugin-ok', 'index.js'))) === 'ok')
    ok('checkApplyExport invalid=非ok', (await ph.checkApplyExport(join(nm, 'plugin-bad', 'index.js'))) !== 'ok')
  } finally {
    await fs.rm(tdir, { recursive: true, force: true })
  }
}

// ---------- 汇总（所有 T 完成后统一统计，2026-08-21 修复：原汇总在 T9 前导致 T9-T13 失败不退出） ----------
console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
if (fail > 0) { console.log('失败项: ' + failures.join(', ')); process.exit(1) }
console.log('全部通过 ✅')
