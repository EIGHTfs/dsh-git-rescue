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

console.log('== T7: 设备身份（备份仓名与主机名无关） ==')
const device = await getDeviceId(dir)
ok('设备 ID 已获取', !!device.id && device.id.length >= 16, JSON.stringify(device))
const mid = await readMachineId()
if (mid) ok('machine-id 优先（source=machine-id）', device.source === 'machine-id' && device.id === mid)
else ok('machine-id 不可用，走持久化兜底', device.source === 'persisted')
const backupInfo = await defaultBackupRepo(dir)
const repoName = backupInfo.repo
ok('备份仓名格式正确', repoName.startsWith('.dsh@'), `repo=${repoName}`)
const hn = hostname().replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase()
ok('备份仓名不含主机名（hostname 撞车不影响）', hn.length === 0 || !repoName.includes(hn), `repo=${repoName} hostname=${hn}`)

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

// ===== T19: unzip 还原点 zip（profile 变化提交 git 时打包，unzip 手动覆盖）=====
console.log('\n== T19: unzip 还原点 zip 功能 ==')
const {
  restorePointDir, restoreStamp, sanitizePluginName,
  inferPluginFromDiff, collectChangedProfileFiles,
  buildRestorePoint, listRestorePoints,
  restoreRestorePoint, removeRestorePoint,
} = await import('./lib/restore-point.js')

async function makeTempRepoForRestore() {
  const dir = await mkdtemp(join(tmpdir(), 'restore-point-test-'))
  await fs.mkdir(join(dir, 'profiles', 'web'), { recursive: true })
  await fs.mkdir(join(dir, 'git-rescue'), { recursive: true })
  // 先初始化 git，再创建文件（避免 untracked 被误判为变更）
  await git.initRepo(dir)
  await fs.writeFile(join(dir, '.gitignore'), 'git-rescue/\n')
  await fs.writeFile(join(dir, 'profiles', 'web', 'cordis.patch.yml'), 'plugins:\n')
  // 提交初始状态
  await git.commit(dir, 'chore(init): initial state')
  return dir
}

const dir19 = await makeTempRepoForRestore()
try {
  // 19-1: 无变更时返回 empty
  console.log('  ① 无变更 → empty')
  const r0 = await buildRestorePoint({ dshRoot: dir19, reason: 'test' })
  ok('无变更返回 empty', r0.ok && r0.empty, JSON.stringify(r0))

  // 19-2: 创建变更文件
  await fs.writeFile(join(dir19, 'profiles', 'web', 'cordis.patch.yml'), 'plugins:\n  - id: test-plugin\n')
  await fs.writeFile(join(dir19, 'settings.yaml'), 'key: value\n')

  // 19-3: buildRestorePoint 打包成功
  console.log('  ② buildRestorePoint 打包')
  const r1 = await buildRestorePoint({ dshRoot: dir19, reason: 'test-reason' })
  ok('打包成功', r1.ok && !r1.empty, JSON.stringify(r1))
  ok('非 empty', !r1.empty)
  ok('有 path', !!r1.path)
  ok('有 name', !!r1.name)

  // 19-4: 文件名后缀标注插件
  console.log('  ③ 文件名后缀标注插件')
  ok('文件名含 .zip', r1.name?.endsWith('.zip'), r1.name)
  ok('文件名含时间戳格式', /^profile-restore-\d{8}-\d{6}-/.test(r1.name || ''), r1.name)

  // 19-5: 打包 count
  console.log('  ④ 打包 count')
  ok('count >= 1', r1.count >= 1, `count=${r1.count}`)

  // 19-6: zip 写入 restore-points/
  console.log('  ⑤ zip 写入 restore-points/')
  ok('path 在 restore-points/ 内', r1.path?.includes('restore-points'), r1.path)

  // 19-7: 解压验证内容
  console.log('  ⑥ 解压验证')
  const { unzipStore } = await import('./lib/zip.js')
  const buf = await fs.readFile(r1.path)
  const entries = unzipStore(buf)
  const entryNames = [...entries.keys()]
  ok('zip 含 manifest.json', entryNames.includes('manifest.json'), entryNames.join(', '))
  ok('zip 含 cordis.patch.yml', entryNames.some((n) => n.includes('cordis.patch.yml')), entryNames.join(', '))
  ok('zip 含 settings.yaml', entryNames.some((n) => n.includes('settings.yaml')), entryNames.join(', '))

  // 19-8: manifest 内容正确
  console.log('  ⑦ manifest 内容')
  const manifestData = entries.get('manifest.json')
  const manifest = JSON.parse(manifestData.toString())
  ok('manifest kind 正确', manifest.kind === 'profile-restore', manifest.kind)
  ok('manifest reason 正确', manifest.reason === 'test-reason', manifest.reason)
  ok('manifest files 列表存在', Array.isArray(manifest.files), typeof manifest.files)

  // 19-9: 手动覆盖恢复
  console.log('  ⑧ 手动覆盖恢复')
  await fs.writeFile(join(dir19, 'settings.yaml'), 'corrupted\n')
  const r2 = await restoreRestorePoint({ dshRoot: dir19, name: r1.name })
  ok('恢复成功', r2.ok, JSON.stringify(r2))
  ok('恢复了 settings.yaml', r2.restored?.some((f) => f.includes('settings.yaml')), r2.restored)

  // 19-10: manifest 不落盘根目录
  console.log('  ⑨ manifest 不落盘')
  const manifestOnDisk = await fs.readFile(join(dir19, 'manifest.json'), 'utf8').catch(() => null)
  ok('manifest 未落盘', manifestOnDisk === null, 'manifest.json 应在 zip 内而非根目录')

  // 19-11: 列表 + 删除
  console.log('  ⑩ 列表 + 删除')
  const list = await listRestorePoints(dir19)
  ok('列表成功', list.ok, JSON.stringify(list))
  ok('列表有 1 个', list.points?.length === 1, `points=${list.points?.length}`)

  const del = await removeRestorePoint({ dshRoot: dir19, name: r1.name })
  ok('删除成功', del.ok, JSON.stringify(del))

  // 19-12: 非法文件名拒绝
  console.log('  ⑪ 非法文件名拒绝')
  const bad1 = await restoreRestorePoint({ dshRoot: dir19, name: '../../etc/passwd' })
  ok('穿越路径拒绝', !bad1.ok, bad1.error)
  const bad2 = await removeRestorePoint({ dshRoot: dir19, name: 'evil.zip' })
  ok('非法名称拒绝', !bad2.ok, bad2.error)

  // 19-13: sanitizePluginName 清洗
  console.log('  ⑫ sanitizePluginName 清洗')
  ok('空格被替换', sanitizePluginName('dsh test') === 'dsh-test', sanitizePluginName('dsh test'))
  ok('特殊字符被清洗', sanitizePluginName('dsh@test!') === 'dsh-test', sanitizePluginName('dsh@test!'))
  ok('空值回退', sanitizePluginName('') === 'unknown', sanitizePluginName(''))
} finally {
  await fs.rm(dir19, { recursive: true, force: true })
}
