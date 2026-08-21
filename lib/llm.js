/**
 * dsh-git-rescue 2.3.0 — guardian 直连 LLM 自治分析/修复（2026-08-22 EIGHTfs 需求升级）
 *
 * 背景：用户提出「守护进程内置的 LLM 感觉很弱智，要大改、要和我（真正的 agent）一样能处理」。
 * 升级（2026-08-22）：
 *  - ① 模型自由选择：从 `DSH_GIT_RESCUE_LLM_MODEL` 或用户模型配置读取，不强绑一个弱模型；
 *     默认用深寻强推理档（deepseek-reasoner），可覆盖为任意用户模型；maxTokens 显著加大。
 *  - ② 全量诊断上下文：不再是"stderr 尾部 40 行截断 2000 字符"，而是多源组装——
 *     主日志尾、stderr 尾、events.jsonl 最近事件、配置变更、权限/挂载实测、git 提交、fault 分类，
 *     结构化分节、关键错误识别，喂给强模型做推理。
 *  - ③ 多轮自治循环：llmDiagnoseRescue 支持"观察→行动→验证→再观察"（turn）迭代，
 *     guardian 执行动作后把结果回喂，最多 MAX_LLM_TURNS 轮，像真 agent 一样收敛，而不是单次四选一。
 *
 * 安全设计（必须遵守，继承 2.0.0）：
 *  1. LLM 只输出结构化 JSON（analysis + suggestedActions[] / turn 决策），不输出自由文本命令
 *  2. guardian 只执行白名单动作（ALLOWED_ACTIONS），白名单外一律拒绝
 *  3. 所有动作执行前记日志、可被 git 回退
 *  4. LLM 调用失败 fail-soft：不影响现有救援流程
 *
 * 动作白名单（当前，后续按需扩）：
 *  - report_only        ：仅分析，无动作（LLM 认为无需操作或不确定）
 *  - suggest_git_reset  ：建议回退到指定 commit（guardian 校验 commit 存在后 restoreProfileOnly）
 *  - suggest_restart    ：建议重启 DSH（guardian 执行 startDsh）
 *  - suggest_config_fix ：建议改配置（guardian 按 repair-tools 已知修复执行，不接受任意路径写入）
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execSync } from 'node:child_process'

export const LLM_DEFAULT = {
  baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
  // 模型自由选择：环境变量优先 → 默认深寻强推理档
  model: process.env.DSH_GIT_RESCUE_LLM_MODEL || 'deepseek-reasoner',
  // maxTokens 显著加大（强推理需要充分输出预算）
  maxTokens: Number(process.env.DSH_GIT_RESCUE_LLM_MAX_TOKENS || 8000),
  timeoutMs: Number(process.env.DSH_GIT_RESCUE_LLM_TIMEOUT_MS || 120_000),
  retries: Number(process.env.DSH_GIT_RESCUE_LLM_RETRIES || 2),
  // 多轮自治
  maxTurns: Number(process.env.DSH_GIT_RESCUE_LLM_MAX_TURNS || 5),
}

/** 动作白名单：guardian 允许执行的 LLM 建议动作。 */
export const ALLOWED_ACTIONS = ['report_only', 'suggest_git_reset', 'suggest_restart', 'suggest_config_fix', 'suggest_file_write']

/**
 * 读取 DEEPSEEK_API_KEY（.dsh/.credentials.yaml）。
 * 2026-08-21：支持回退——当前 DSH_HOME 找不到时回退主环境 ~/.dsh/.credentials.yaml。
 */
export async function readDeepSeekKey(dshHome) {
  const candidates = []
  if (dshHome) candidates.push(join(dshHome, '.credentials.yaml'))
  candidates.push(join(homedir(), '.dsh', '.credentials.yaml'))
  for (const p of candidates) {
    try {
      const raw = await fs.readFile(p, 'utf8')
      const m = raw.match(/DEEPSEEK_API_KEY:\s*["']?([^"'\s]+)/)
      if (m && m[1]) return m[1]
    } catch { /* 下一个候选 */ }
  }
  return null
}

/**
 * 持久化 LLM 配置路径（web 上可选择模型 → 写入这里，resolveModel 优先读它）。
 */
function llmConfigPath(dshHome) {
  return join(dshHome || homedir(), 'git-rescue', 'llm-config.json')
}

/**
 * 读取持久化 LLM 配置（web「模型选择」保存的）。
 * @param {string} [dshHome]
 * @returns {Promise<{model?:string, baseURL?:string}>}
 */
export async function readLlmConfig(dshHome) {
  try {
    const raw = await fs.readFile(llmConfigPath(dshHome), 'utf8')
    const j = JSON.parse(raw)
    return { model: typeof j.model === "string" ? j.model : "", baseURL: typeof j.baseURL === "string" ? j.baseURL : "" }
  } catch { return {} }
}

/**
 * 保存持久化 LLM 配置（web「模型选择」）。原子写(tmp+rename)。
 * @param {string} dshHome
 * @param {{model?:string, baseURL?:string}} cfg
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function writeLlmConfig(dshHome, cfg = {}) {
  try {
    const dir = join(dshHome || homedir(), 'git-rescue')
    await fs.mkdir(dir, { recursive: true })
    const path = llmConfigPath(dshHome)
    const prev = await readLlmConfig(dshHome)
    const next = { ...prev, ...(cfg.model ? { model: cfg.model } : {}), ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}) }
    const tmp = `${path}.tmp-${Date.now()}`
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
    await fs.rename(tmp, path)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/**
 * 解析模型名（自由选择优先）：
 *  exp1: 持久化配置（web「模型选择」保存）——用户显式选定的最高优先
 *  exp2: DSH_GIT_RESCUE_LLM_MODEL 环境变量（显式指定任意模型）
 *  exp3: 用户 settings.yaml 的 agent-default-model.model（若为 deepseek 强推理档）
 *  exp4: 默认 deepseek-reasoner（深寻强推理）
 */
export async function resolveModel(dshHome) {
  const cfg = await readLlmConfig(dshHome)
  if (cfg.model) return cfg.model
  if (process.env.DSH_GIT_RESCUE_LLM_MODEL) return process.env.DSH_GIT_RESCUE_LLM_MODEL
  try {
    const settingsPath = join(dshHome || homedir(), '.dsh', 'settings.yaml')
    // 为避免强依赖 yaml 解析，直接 grep 匹配 agent-default-model 段的 model 行
    const res = execSync(`grep -A2 '^agent-default-model:' '${settingsPath}' 2>/dev/null`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const m = res.match(/model:\s*([^\s]+)/)
    if (m && m[1] && /deepseek|reasoner/.test(m[1])) return m[1]
  } catch { /* 读不到就默认 */ }
  return 'deepseek-reasoner'
}

/**
 * 解析 baseURL（当前 LLM 端点；持久化可覆盖）。与 resolveModel 相同的优先级来源。
 */
export async function resolveBaseUrl(dshHome) {
  const cfg = await readLlmConfig(dshHome)
  if (cfg.baseURL) return cfg.baseURL
  return process.env.DEEPSEEK_BASE_URL || LLM_DEFAULT.baseURL
}

/**
 * 可用模型候选（web「模型选择」下拉；以 deepseek 官方为主 + 网关惯例）。
 */
export const AVAILABLE_LLM_MODELS = [
  { model: "deepseek-reasoner", label: "deepseek-reasoner（强推理，推荐）" },
  { model: "deepseek-chat", label: "deepseek-chat（通用对话）" },
  { model: "deepseek-v4-flash", label: "deepseek-v4-flash（快速档）" },
]

/**
 * 组装多源诊断上下文（不再只给 stderr 尾部 2000 字符）。
 * @param {object} ctx { dshHome, fault, reason, bootLog, stderr, mainLogTail, events, gitLog, repairHits, configChanged }
 * @returns {string} 结构化分节上下文
 */
export function buildRescueContext(ctx) {
  const { fault, reason, bootLog, stderr, mainLogTail, events, gitLog, repairHits, configChanged, dshSnapshot } = ctx || {}
  const sec = []
  const push = (title, body) => { if (body) sec.push(`\n■ ${title}\n${String(body).slice(0, 6000)}`) }
  sec.push(`【故障分类】${JSON.stringify(fault || {})}\n【触发原因】${String(reason || '')}`)
  push('启动标准输出尾部', bootLog)
  push('stderr 尾部', stderr)
  push('主环境日志尾部', mainLogTail)
  push('git-rescue 最近事件(events.jsonl)', events)
  push('git 最近提交', gitLog)
  push('修复工具命中', JSON.stringify(repairHits || []))
  if (configChanged !== undefined) sec.push(`\n【插件配置是否变更】${configChanged ? '是（疑似装/改插件）' : '否'}`)
  // .dsh 智能快照（用户档案/配置/事件/会话概览）——置顶给 LLM 全现场
  if (dshSnapshot) sec.push(`\n■ .dsh 目录智能快照（用户档案/核心配置/事件/会话概览）\n${String(dshSnapshot).slice(0, 120000)}`)
  return sec.join('\n').slice(0, 140000)
}

/**
 * 调用 LLM chat/completions（OpenAI 兼容）。
 * 2026-08-20：加重试；2026-08-21：jsonMode=false 对话纯文本；
 * 2026-08-22：模型 resolveModel 自由选择、maxTokens 加大。
 */
export async function llmChat(opts) {
  const { dshHome, system = '', user = '', schemaHint = '', jsonMode = true, model } = opts
  try {
    const apiKey = await readDeepSeekKey(dshHome)
    if (!apiKey) return { ok: false, error: 'DEEPSEEK_API_KEY 未配置（.dsh/.credentials.yaml）' }
    const resolvedModel = model || (await resolveModel(dshHome))
    const baseURL = await resolveBaseUrl(dshHome)
    const body = {
      model: resolvedModel,
      max_tokens: LLM_DEFAULT.maxTokens,
      messages: [
        { role: 'system', content: jsonMode
          ? `${system}\n${schemaHint ? `输出必须是 JSON 对象，结构：${schemaHint}` : '输出必须是 JSON 对象。'}`
          : system },
        { role: 'user', content: user },
      ],
    }
    if (jsonMode) body.response_format = { type: 'json_object' }
    let lastError = ''
    for (let attempt = 0; attempt <= LLM_DEFAULT.retries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt))
      try {
        const ctl = AbortSignal.timeout(LLM_DEFAULT.timeoutMs)
        const res = await fetch(baseURL + '/chat/completions', {
          method: 'POST',
          signal: ctl,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
        })
        if (!res.ok) { lastError = `LLM HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`; continue }
        const j = await res.json()
        const raw = j?.choices?.[0]?.message?.content || ''
        if (!raw) { lastError = 'LLM 返回空 content（重试中）'; continue }
        let content = raw
        // 兼容 reasoning_content：若只有 content，忽略 reasoning_content（openrouter/deepseek reasoner 有 reasoning_content）
        if (j?.choices?.[0]?.message?.reasoning_content) {
          // 纯文本模式可附加思考痕迹；JSON 模式只取 content
          if (!jsonMode) content = `[思考痕迹]\n${j.choices[0].message.reasoning_content}\n[回答]\n${raw}`
        }
        if (!jsonMode) return { ok: true, raw: content }
        let json = null
        try { json = JSON.parse(content) } catch { lastError = 'LLM 返回非法 JSON（重试中）'; continue }
        return { ok: true, raw: content, json }
      } catch (e) { lastError = String(e?.message ?? e) }
    }
    return { ok: false, error: `LLM 调用失败（重试 ${LLM_DEFAULT.retries} 次后仍失败）: ${lastError}` }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/**
 * 校验 LLM 建议动作是否在白名单且结构合法（安全闸门）。
 */
export function validateLlmAction(action) {
  if (!action || typeof action !== 'object') return { ok: false, error: '动作非对象' }
  const type = action.type
  if (!ALLOWED_ACTIONS.includes(type)) return { ok: false, error: `动作类型不在白名单: ${type}` }
  if (type === 'suggest_git_reset') {
    if (!action.commit || typeof action.commit !== 'string' || action.commit.length < 7) {
      return { ok: false, error: 'suggest_git_reset 需要合法 commit 引用' }
    }
  }
  if (type === 'suggest_config_fix') {
    if (!action.fixId || typeof action.fixId !== 'string') {
      return { ok: false, error: 'suggest_config_fix 需要 fixId（repair-tools 已知修复标识）' }
    }
  }
  if (type === 'suggest_file_write') {
    // LLM 请求写 .dsh 内一个文件（相对 dshHome 的路径 + 文本内容）。
    // 这里只做结构校验；绝对路径穿越/扩展名/大小守卫放在 executeLlmActions（有 dshHome）。
    if (typeof action.path !== 'string' || !action.path || action.path.includes('\0')) {
      return { ok: false, error: 'suggest_file_write 需要非空 path（相对 .dsh 的路径）' }
    }
    if (typeof action.content !== 'string' || action.content.length < 1 || action.content.length > 200 * 1024) {
      return { ok: false, error: 'suggest_file_write content 需为 1..200KB 字符串' }
    }
    if (typeof action.reason !== 'string' || !action.reason) {
      return { ok: false, error: 'suggest_file_write 需要 reason' }
    }
  }
  return { ok: true, action }
}

/**
 * 救援诊断 LLM 分析（自治救机第一层）：
 * 喂【全量多源上下文】，得到结构化诊断 + 白名单建议动作。
 * 强模型 + 大 token + 完整现场 → 定位根因而非标签式判断。
 * fail-soft：任何失败返回 { ok:false }，调用方回退到模板报告。
 */
export async function llmDiagnoseRescue(ctx) {
  const { dshHome } = ctx
  const schemaHint = `{"analysis":"根因分析(中文,400字内,要具体到报错和修复方向)","severity":"low|medium|high","rootCauses":[{"layer":"system|boot|plugin|data|unknown","detail":"具体根因"}],"suggestedActions":[{"type":"report_only|suggest_git_reset|suggest_restart|suggest_config_fix|suggest_file_write","commit":"(仅suggest_git_reset)","fixId":"(仅suggest_config_fix,可选)","path":"(仅suggest_file_write,相对.dsh的路径,如settings.yaml/profiles/web/cordis.patch.yml)","content":"(仅suggest_file_write,完整新文件内容)","reason":"为什么建议"}]}`
  const system = '你是 DSH(DeepSeek Harness) 的救援诊断 AI，具备强推理能力。你会收到完整的多源故障现场（日志/事件/配置/提交）。你的任务是：像资深运维一样精确判断故障层级与根因（系统层/引导层/插件层/数据层），再给白名单动作建议。你的建议由守护进程在严格白名单内执行。你可以用 suggest_file_write 请求改写 .dsh 下任意配置文件（settings.yaml / profiles/web/cordis.patch.yml / profiles/web/package.json 等），path 填相对 .dsh 的路径、content 填完整新内容；守护进程会备份原文件再写，失败自动回滚。不确定时 type=report_only 且把不确定点写进 analysis。'
  const user = buildRescueContext(ctx)
  const r = await llmChat({ dshHome, system, user, schemaHint })
  if (!r.ok) return r
  if (!r.json) return { ok: false, error: 'LLM 返回非 JSON', raw: r.raw }
  const acts = Array.isArray(r.json.suggestedActions) ? r.json.suggestedActions : []
  const valid = []
  for (const a of acts) { const v = validateLlmAction(a); if (v.ok) valid.push(v.action) }
  return {
    ok: true,
    analysis: r.json.analysis || '',
    severity: r.json.severity || 'low',
    rootCauses: Array.isArray(r.json.rootCauses) ? r.json.rootCauses : [],
    suggestedActions: valid,
    raw: r.raw,
  }
}

/**
 * 多轮自治救援（2026-08-22 新增，供 guardian recover 调用 —— "观察→行动→验证"循环）：
 * 第 1 轮调 llmDiagnoseRescue 拿动作 → 调用方 executeLlmActions 执行并 probe →
 * 若未恢复，把【执行结果 + 新的探活/日志证据】回喂给下一轮（turn 递进）→ 最多 LLM_DEFAULT.maxTurns 轮。
 *
 * 注：执行器（executeLlmActions）由 guardian/server.js 提供，因为只有它能 startDsh/restoreProfileOnly/probe。
 * 本函数只负责"多轮喂上下文 + 规约动作"。
 *
 * @param {object} opts { dshHome, turn0ctx, onExecute, probe }
 *   turn0ctx   首轮诊断上下文（buildRescueContext 已含多源）
 *   onExecute  async (actions)=>返回 { executed, recovered, results }（由 server.js 实现）
 *   probe      async ()=> { ok }
 * @returns {Promise<{recovered:boolean, turns:number, analysis:string, history:Array}>}
 */
export async function llmMultiTurnRescue({ dshHome, turn0ctx, onExecute, probe }) {
  const history = []
  let ctx = turn0ctx || {}
  let recovered = false
  let lastAnalysis = ''
  for (let turn = 1; turn <= LLM_DEFAULT.maxTurns; turn++) {
    // 首轮后把上一轮执行结果 + 探活回馈拼进上下文
    if (history.length) {
      const last = history[history.length - 1]
      ctx = {
        ...ctx,
        bootLog: `${ctx.bootLog || ''}\n\n【第 ${turn - 1} 轮执行结果】${JSON.stringify(last.execResult || {})}\n【第 ${turn - 1} 轮后探活】${last.probedAfterOk ? '恢复健康' : '仍未恢复'}${last.extraEvidence ? `\n【新证据】${last.extraEvidence}` : ''}`,
      }
    }
    const r = await llmDiagnoseRescue({ dshHome, ...ctx })
    if (!r.ok) { history.push({ turn, ok: false, error: r.error }); break }
    lastAnalysis = r.analysis
    const execResult = onExecute ? await onExecute(r.suggestedActions) : { executed: [], recovered: false, results: [] }
    const probedAfter = probe ? await probe() : { ok: false }
    recovered = !!execResult.recovered || !!probedAfter?.ok
    history.push({ turn, analysis: r.analysis, actions: r.suggestedActions, execResult, probedAfterOk: !!probedAfter?.ok })
    if (recovered) break
    if (r.severity === 'low' && !r.suggestedActions.length) break // 无动作且低危，不再空转
  }
  return { recovered, turns: history.length, analysis: lastAnalysis, history }
}

/**
 * 收集 .dsh 智能快照（2026-08-22 用户要求内置 LLM 读 .dsh；全量不可行——629MB/1331 文件，
 * 改为"选择性快照"：只收文本配置类/关键状态，跳过二进制/超大/zstd/zip/图片/node_modules/.git/凭据）。
 * 这样内置 LLM 能认识用户（remember-me）+ 看核心配置 + 故障现场，token 可控。
 *
 * @param {string} dshHome .dsh 目录（CFG.dshHome）
 * @param {object} [opts] { maxTotalChars, maxFileChars }
 * @returns {Promise<string>} 结构化文本快照（脱敏）
 */
export async function collectDshSnapshot(dshHome, opts = {}) {
  const maxTotalChars = opts.maxTotalChars ?? 200_000   // 总上限 ~200KB
  const maxFileChars = opts.maxFileChars ?? 30_000      // 单文件 ~30KB
  const root = dshHome || join(homedir(), '.dsh')
  const skipDirs = new Set(['node_modules', 'node_modules_local', '.git', 'sessions', 'storages', 'snapshot-archive', 'session-transfer', 'supervisor', 'rescue'])
  // 跳过二进制/大文件扩展（含 zip/zstd/图片/锁文件等）
  const skipExt = /\.(zip|zstd|gz|tar|jpg|jpeg|png|gif|webp|ico|so|bin|lock|sqlite|zst|bak)$/i
  const out = []
  let total = 0
  const push = (title, body) => {
    if (!body) return
    const s = String(body).slice(0, maxFileChars)
    out.push(`\n### ${title}\n${s}`)
    total += s.length
  }
  // 1) 用户档案（remember-me，认识用户）——脱敏保留画像/规矩，去绝对路径
  try {
    const rm = await fs.readFile(join(root, 'skills', 'remember-me.md'), 'utf8')
    const sanitized = rm
      .replace(/\/vol1\/[^\s]+/g, '<内部路径>')
      .replace(/\b10\.10\.10\.\d+\b/g, '<内网IP>')
      .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '<IP>')
    push('用户档案(remember-me, 脱敏)', sanitized)
  } catch { /* 无档案 */ }
  // 2) 核心配置
  for (const rel of ['settings.yaml', '.gitignore', 'profiles/web/package.json', 'profiles/web/cordis.yml', 'profiles/web/cordis.patch.yml', 'profiles/web/pnpm-workspace.yaml']) {
    try { push(`配置:${rel}`, await fs.readFile(join(root, rel), 'utf8')) } catch { /* 缺失跳过 */ }
  }
  // 3) 守护/故障现场（git-rescue 状态）
  const gr = join(root, 'git-rescue')
  for (const rel of ['heartbeat', 'config.json', 'device-last.json', 'backup-select.json', 'llm-config.json', 'plugin-registry.json']) {
    try { push(`状态:${rel}`, await fs.readFile(join(gr, rel), 'utf8')) } catch { /* 缺失 */ }
  }
  // events.jsonl 只取最近 40 行（防过大）
  try {
    const ev = await fs.readFile(join(gr, 'events.jsonl'), 'utf8')
    push('事件流(events.jsonl, 最近40条)', String(ev).split('\n').slice(-40).join('\n'))
  } catch { /* 无 */ }
  // 4) 技能清单（只列名，不读全——省 token）
  try {
    const names = (await fs.readdir(join(root, 'skills'))).filter((f) => f.endsWith('.md')).join('\n')
    push('可用 skill 清单', names)
  } catch { /* 无 */ }
  // 5) 会话概览（标题/时间，不读 zstd 正文）
  try {
    const sdir = join(root, 'sessions')
    const titles = []
    const entries = await fs.readdir(sdir)
    for (const e of entries) titles.push(e)
    push('会话目录概览(编码的项目路径)', titles.join('\n'))
  } catch { /* 无 */ }

  // 6) 追加一行的凭据存在性提示（不读值）
  try { await fs.access(join(root, '.credentials.yaml')); out.push(`\n### 凭据\n.credentials.yaml 存在（600，仅 owner 可读），内容不注入（防泄密）。`) } catch { /* 无 */ }

  // 超出总上限则截断（保留开头）
  if (total > maxTotalChars) {
    let acc = 0; const trimmed = []
    for (const block of out) { acc += block.length; if (acc > maxTotalChars) break; trimmed.push(block) }
    return trimmed.join('\n') + `\n\n[快照超过 ${maxTotalChars} 字符，已截断]`
  }
  return out.join('\n')
}
