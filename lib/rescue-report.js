/**
 * dsh-git-rescue 2.0.0 — 救机流程闭环（需求 2026-08-20 EIGHTfs 提出）
 *
 * 集中实现 5 项功能：
 *  - 需求6：恢复结果全量诊断报告（故障分类/现场/修复动作/改动文件/手动恢复方案）
 *  - 需求2：不可恢复分支自动生成「救机任务清单」md（纯净环境 AI 阅读执行）
 *  - 需求3：崩溃前活跃会话 + 未完成任务总结（可多线程并行续做）
 *  - 需求4：救援成功后把本次经验追加到权威 skill（skills/dsh-git-rescue.md）
 *  - 需求5：救援改动文件打包成 zip 还原点（快照归档，放原 .dsh 根目录）
 */

import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zipStore } from './zip.js'

/** 当前插件根（skills/ 权威 skill 所在）。 */
export function pluginRoot() {
  const here = fileURLToPath(import.meta.url) // .../lib/rescue-report.js
  return dirname(dirname(here))               // 插件根
}

/** 权威 skill 路径（需求4：经验追加目标）。 */
export function authoritySkillPath() {
  return join(pluginRoot(), 'skills', 'dsh-git-rescue.md')
}

// ============ 需求6：全量诊断报告 ============

/**
 * 生成面向用户的救援诊断报告 md（含手动恢复方案）。
 * @param {object} info { dshHome, fault, reason, preHead, good, ok, repairHits, changedFiles, manualSteps }
 * @returns {string} md 文本
 */
export function renderDiagnosticReport(info) {
  const {
    dshHome, fault = {}, reason = '', preHead = '无', good = '无', ok = false,
    repairHits = [], changedFiles = [], manualSteps = [],
    llmAnalysis = '', llmActions = [], llmSeverity = '',
    at = new Date().toISOString(),
  } = info
  const L = []
  L.push(`# DSH 救援诊断报告（${at.slice(0, 19).replace('T', ' ')}）`)
  L.push('')
  L.push('> 由 dsh-git-rescue guardian 自动生成（需求6，2026-08-20）。本报告含问题根因、已做修复、改动文件与手动恢复方案，供人工/纯净环境 AI 充分了解。')
  L.push('')
  L.push('## 一、故障分类')
  L.push(`- 类型: ${fault.type || '未知'}（可回退: ${fault.recoverable === false ? '否' : '是'}）`)
  if (fault.reason) L.push(`- 判定依据: ${fault.reason}`)
  L.push(`- 触发原因: ${reason || '未记录'}`)
  L.push('')
  L.push('## 二、救援动作')
  L.push(`- 坏点: ${preHead}`)
  L.push(`- 回退目标（最后一个好提交）: ${good}`)
  L.push(`- 结果: ${ok ? '✅ 成功' : '❌ 未完全恢复'}`)
  if (repairHits.length) {
    L.push(`- 专项工具命中: ${repairHits.map((h) => `${h.id}(${(h.findings || []).length})`).join('、')}`)
  }
  if (llmAnalysis) {
    L.push('')
    L.push('## 二·五、LLM 自治诊断（guardian 直连模型 API）')
    L.push(`- 严重度: ${llmSeverity || '未知'}`)
    L.push(`- 根因分析: ${llmAnalysis}`)
    if (llmActions.length) {
      L.push('- 建议动作（白名单内）:')
      for (const a of llmActions) L.push(`  - [${a.type}] ${a.reason || ''}${a.commit ? ` (commit=${a.commit})` : ''}`)
    }
  }
  L.push('')
  L.push('## 三、改动文件（还原点）')
  if (changedFiles.length) {
    L.push('```')
    for (const f of changedFiles) L.push(f)
    L.push('```')
  } else {
    L.push('（无额外改动文件记录）')
  }
  L.push('')
  L.push('## 四、手动恢复方案')
  if (manualSteps.length) {
    manualSteps.forEach((s, i) => L.push(`${i + 1}. ${s}`))
  } else {
    L.push('1. 确认 git 状态：`cd ${dshHome} && git status`')
    L.push('2. 若仍异常，用还原点压缩包恢复改动文件（见 .dsh 根目录 restore-*.zip）')
    L.push('3. 重启 DSH 并观察 guardian 日志')
  }
  L.push('')
  return L.join('\n')
}

/** 落盘诊断报告到 .dsh/git-rescue/diagnostic-report-<ts>.md。 */
export async function writeDiagnosticReport(dshHome, info) {
  try {
    const dir = join(dshHome, 'git-rescue')
    await fs.mkdir(dir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const p = join(dir, `diagnostic-report-${ts}.md`)
    await fs.writeFile(p, renderDiagnosticReport({ dshHome, ...info }), 'utf8')
    return { ok: true, path: p }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

// ============ 需求2+3：救机任务清单 ============

/**
 * 生成「救机任务清单」md——不可恢复/长时间未恢复时，给纯净环境 AI 阅读执行。
 * 内容按用户要求：① 读原环境所有 md 作 skill ② 定位罪魁祸首 ③ 读其会话记录
 * ④ 排查至全部插件启动；并附崩溃前活跃会话 + 未完成任务（可多线程）。
 * @param {object} info { dshHome, reason, activeSessions, fault }
 * @returns {string} md 文本
 */
export function renderRescueTaskList(info) {
  const {
    dshHome, reason = '', activeSessions = [], fault = {},
    at = new Date().toISOString(),
  } = info
  const L = []
  L.push(`# 救机任务清单（${at.slice(0, 19).replace('T', ' ')}）`)
  L.push('')
  L.push('> 原环境（DSH 主实例）恢复失败，本清单由 dsh-git-rescue guardian 自动生成。')
  L.push('> **请先完整阅读本文档，再按步骤执行。** 目标：排查直到所有插件启动。')
  L.push('')
  L.push('## 第 0 步：读原环境所有 md 文件作为 skill')
  L.push('- 遍历原环境 `.dsh` 及工作区中所有 `.md` 文件（README、docs/、skills/、开发者文档等），全文通读作为排查知识源')
  L.push('- 重点：`${dshHome}/git-rescue/` 下的诊断报告与事件日志、插件 `skills/` 目录')
  L.push('')
  L.push('## 第 1 步：定位罪魁祸首')
  L.push(`- 故障分类: ${fault.type || '未知'}（${fault.reason || '未记录判定依据'}）`)
  L.push('- 触发原因: ' + (reason || '未记录'))
  L.push('- 查看 `.dsh/git-rescue/guardian-events.jsonl` 最近事件（exit-context / 报错堆栈）')
  L.push('- 查看 `.dsh/git-rescue/dsh-stderr.log` 启动报错')
  L.push('')
  L.push('## 第 2 步：读取罪魁祸首的所有会话记录进行分析')
  L.push('- 会话文件: `.dsh/sessions/<编码路径>/<session-id>/session.jsonl.zstd`')
  L.push('- 用 zstdcat 读取（注意是拼接帧，见技能 dsh-boot-troubleshooting）')
  L.push('- 找出崩溃前最后操作（改了什么配置/插件/文件）')
  L.push('')
  L.push('## 第 3 步：排查直到所有插件启动')
  L.push('1. 修复根因（配置/权限/软链/会话损坏，按 dsh-boot-troubleshooting 技能分类处理）')
  L.push('2. 启动 DSH，逐个确认插件加载成功（设置 → 插件）')
  L.push('3. 直到全部插件启动，任务完成')
  L.push('')
  if (activeSessions.length) {
    L.push('## 附：崩溃前活跃会话与未完成任务（可多线程并行）')
    L.push('')
    L.push('| 会话 | 标题/ID | 状态 | 备注 |')
    L.push('|---|---|---|---|')
    for (const s of activeSessions) {
      L.push(`| ${s.title || s.id || '?'} | ${s.id || ''} | ${s.running ? '运行中' : '暂停'} | 可派独立 AI 多线程续做其未完成任务 |`)
    }
    L.push('')
    L.push('> 多线程提示：每个活跃会话的未完成任务可交给一个独立子代理续做；')
    L.push('> 会话记录在 `.dsh/sessions/` 下按会话 id 对应，续做前先读该会话最后事件。')
  } else {
    L.push('## 附：崩溃前活跃会话')
    L.push('（未检测到崩溃前活跃会话，或检测接口不可达）')
  }
  L.push('')
  return L.join('\n')
}

/** 落盘救机任务清单到 .dsh/git-rescue/rescue-tasklist-<ts>.md（原环境侧，纯净环境可读）。 */
export async function writeRescueTaskList(dshHome, info) {
  try {
    const dir = join(dshHome, 'git-rescue')
    await fs.mkdir(dir, { recursive: true })
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const p = join(dir, `rescue-tasklist-${ts}.md`)
    await fs.writeFile(p, renderRescueTaskList({ dshHome, ...info }), 'utf8')
    return { ok: true, path: p }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

// ============ 需求4：救援经验固化到权威 skill ============

/**
 * 救援成功后，把本次救援经验追加到权威 skill（skills/dsh-git-rescue.md）「九、救援经验」节。
 * 幂等去重：同主题（rootCause 关键词）已存在则不重复追加。
 * 2026-08-20 修复：测试环境（dsh-test-home 等非主 .dsh）不追加——避免测试救援污染权威 skill。
 * @param {object} info { rootCause, detail, dshHome }
 * @returns {Promise<{ok:boolean, path?:string, appended?:boolean, error?:string}>}
 */
export async function appendRescueExperience(info) {
  const { rootCause = '', detail = '', dshHome = '' } = info
  try {
    // 测试环境判定：dshHome 含 test（dsh-test-home / 测试实例目录）且非主环境路径 → 跳过经验固化
    const home = String(dshHome || '')
    if (home && /test|Save-(clean|test)/i.test(home)) {
      return { ok: true, appended: false, skipped: 'test-env', path: authoritySkillPath() }
    }
    const p = authoritySkillPath()
    let content = ''
    try { content = await fs.readFile(p, 'utf8') } catch { /* 首次 */ }
    // 去重：rootCause 关键词已在文件中则不重复
    const key = rootCause.trim().slice(0, 24)
    if (key && content.includes(key)) {
      return { ok: true, appended: false, path: p }
    }
    const line = `${content.endsWith('\n') ? '' : '\n'}${(new Date().toISOString().slice(0, 10))}: ${rootCause}${detail ? `（${detail}）` : ''}\n`
    await fs.appendFile(p, line, 'utf8')
    return { ok: true, appended: true, path: p }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

// ============ 需求5：改动文件 zip 还原点 ============

/**
 * 把 git 仓库的改动文件打包成 zip 还原点，放到原 .dsh 根目录。
 * 内容：git status 未提交改动 + 最近一次救援的 diff 文件（可直接应用恢复）。
 * @param {object} opts { dshHome, gitFileList }  gitFileList 为已收集的改动文件相对路径
 * @returns {Promise<{ok:boolean, path?:string, count?:number, error?:string}>}
 */
export async function packageChangedFiles(opts) {
  const { dshHome, gitFileList = [] } = opts
  try {
    const files = []
    for (const rel of gitFileList) {
      if (!rel || rel.includes('..')) continue
      const abs = join(dshHome, rel)
      try {
        const data = await fs.readFile(abs)
        files.push({ name: rel.replace(/\\/g, '/'), data })
      } catch { /* 文件已被 git 删除则跳过 */ }
    }
    if (!files.length) return { ok: true, count: 0, path: null }
    const zipBuf = zipStore(files)
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const p = join(dshHome, `restore-${ts}.zip`) // 原 .dsh 根目录
    await fs.writeFile(p, zipBuf)
    return { ok: true, path: p, count: files.length }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/** 收集 git 仓库未提交改动文件列表（相对路径）。 */
export async function collectChangedFiles(dshHome, runGit) {
  try {
    const r = await runGit(['status', '--porcelain'], { cwd: dshHome })
    if (!r.ok) return []
    return r.stdout.split('\n').filter(Boolean).map((l) => l.slice(3).trim()).filter(Boolean)
  } catch { return [] }
}
