/**
 * dsh-git-rescue 2.0.0 — guardian 直连 LLM 自治分析/修复（2026-08-20 EIGHTfs 需求）
 *
 * 背景：用户提出「不一定要纯净环境，守护进程本身能直接接入 LLM 模型 API」。
 * 已验证：.dsh/.credentials.yaml 的 DEEPSEEK_API_KEY 可直接调
 * https://api.deepseek.com/v1/chat/completions（模型 deepseek-v4-flash/pro）。
 *
 * 安全设计（LLM 自治执行修复，必须遵守）：
 *  1. LLM 只输出**结构化 JSON**（分析 + suggestedActions[]），不输出自由文本命令
 *  2. guardian 只执行**白名单动作**（ALLOWED_ACTIONS），白名单外一律拒绝
 *  3. 所有动作执行前记日志、可被 git 回退（复用现有坏点/回退机制）
 *  4. LLM 调用失败 fail-soft：不影响现有救援流程（诊断报告仍按模板生成）
 *
 * 动作白名单（当前）：
 *  - report_only    ：仅分析，无动作（LLM 认为无需操作或不确定）
 *  - suggest_git_reset：建议回退到指定 commit（guardian 校验 commit 存在后执行 hardReset）
 *  - suggest_restart  ：建议重启 DSH（guardian 执行 startDsh）
 *  - suggest_config_fix：建议改配置（guardian 按 repair-tools 已知修复执行，不接受任意路径写入）
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const LLM_DEFAULT = {
  baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
  model: process.env.DSH_GIT_RESCUE_LLM_MODEL || 'deepseek-v4-flash',
  maxTokens: Number(process.env.DSH_GIT_RESCUE_LLM_MAX_TOKENS || 2000),
  timeoutMs: Number(process.env.DSH_GIT_RESCUE_LLM_TIMEOUT_MS || 60_000),
  retries: Number(process.env.DSH_GIT_RESCUE_LLM_RETRIES || 2), // 2026-08-20：偶发空响应重试次数
}

/** 动作白名单：guardian 允许执行的 LLM 建议动作。 */
export const ALLOWED_ACTIONS = ['report_only', 'suggest_git_reset', 'suggest_restart', 'suggest_config_fix']

/** 读取 DEEPSEEK_API_KEY（.dsh/.credentials.yaml）。 */
export async function readDeepSeekKey(dshHome) {
  try {
    const p = join(dshHome || join(homedir(), '.dsh'), '.credentials.yaml')
    const raw = await fs.readFile(p, 'utf8')
    const m = raw.match(/DEEPSEEK_API_KEY:\s*["']?([^"'\s]+)/)
    return m ? m[1] : null
  } catch { return null }
}

/**
 * 调用 LLM chat/completions（OpenAI 兼容）。
 * 2026-08-20：加重试——LLM 偶发返回空 content / 非法 JSON，重试 retries 次。
 * 2026-08-21：新增 jsonMode=false——对话场景输出纯文本（不强制 JSON、不解析）。
 * @param {object} opts { dshHome, system, user, schemaHint, jsonMode }
 * @returns {Promise<{ok:boolean, raw?:string, json?:object, error?:string}>}
 */
export async function llmChat(opts) {
  const { dshHome, system = '', user = '', schemaHint = '', jsonMode = true } = opts
  try {
    const apiKey = await readDeepSeekKey(dshHome)
    if (!apiKey) return { ok: false, error: 'DEEPSEEK_API_KEY 未配置（.dsh/.credentials.yaml）' }
    const body = {
      model: LLM_DEFAULT.model,
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
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 1500 * attempt)) // 退避：1.5s / 3s
      }
      try {
        const ctl = AbortSignal.timeout(LLM_DEFAULT.timeoutMs)
        const res = await fetch(LLM_DEFAULT.baseURL + '/chat/completions', {
          method: 'POST',
          signal: ctl,
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          const err = await res.text().catch(() => '')
          lastError = `LLM HTTP ${res.status}: ${err.slice(0, 300)}`
          continue // 4xx/5xx 也重试（限流/瞬时错误）
        }
        const j = await res.json()
        const raw = j?.choices?.[0]?.message?.content || ''
        if (!raw) { lastError = 'LLM 返回空 content（重试中）'; continue }
        if (!jsonMode) return { ok: true, raw } // 纯文本模式：直接返回
        let json = null
        try { json = JSON.parse(raw) } catch { lastError = 'LLM 返回非法 JSON（重试中）'; continue }
        return { ok: true, raw, json }
      } catch (e) {
        lastError = String(e?.message ?? e)
        // 超时/网络错误也重试
      }
    }
    return { ok: false, error: `LLM 调用失败（重试 ${LLM_DEFAULT.retries} 次后仍失败）: ${lastError}` }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/**
 * 校验 LLM 建议动作是否在白名单且结构合法。
 * @param {object} action 候选动作
 * @returns {{ok:boolean, action?:object, error?:string}}
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
    // 不接受任意路径写入；只允许 repair-tools 已知修复（由调用方传 resolve 函数执行）
    if (!action.fixId || typeof action.fixId !== 'string') {
      return { ok: false, error: 'suggest_config_fix 需要 fixId（repair-tools 已知修复标识）' }
    }
  }
  return { ok: true, action }
}

/**
 * 救援诊断 LLM 分析（自治救机第一层）：
 * 把故障现场打包给 LLM，得到结构化诊断 + 白名单建议动作。
 * fail-soft：任何失败返回 { ok:false }，调用方回退到模板报告。
 */
export async function llmDiagnoseRescue(ctx) {
  const { dshHome, fault, reason, bootLog, gitLog, repairHits } = ctx
  const schemaHint = `{"analysis":"根因分析(中文,200字内)","severity":"low|medium|high","suggestedActions":[{"type":"report_only|suggest_git_reset|suggest_restart|suggest_config_fix","commit":"(仅suggest_git_reset)","fixId":"(仅suggest_config_fix,可选)","reason":"为什么建议"}]}`
  const system = '你是 DSH(DeepSeek Harness) 的救援诊断 AI。你只输出 JSON。你的建议会由守护进程在严格白名单内执行（git 回退/重启/已知修复），不会执行任意命令。不确定时 type=report_only。'
  const user = [
    '【故障分类】', JSON.stringify(fault || {}),
    '【触发原因】', String(reason || ''),
    '【启动日志尾部】', String(bootLog || '').slice(-2000),
    '【git 最近提交】', String(gitLog || ''),
    '【修复工具命中】', JSON.stringify(repairHits || []),
    '',
    '请分析根因并给出白名单动作建议。',
  ].join('\n')
  const r = await llmChat({ dshHome, system, user, schemaHint })
  if (!r.ok) return r
  if (!r.json) return { ok: false, error: 'LLM 返回非 JSON', raw: r.raw }
  const acts = Array.isArray(r.json.suggestedActions) ? r.json.suggestedActions : []
  const valid = []
  for (const a of acts) {
    const v = validateLlmAction(a)
    if (v.ok) valid.push(v.action)
  }
  return { ok: true, analysis: r.json.analysis || '', severity: r.json.severity || 'low', suggestedActions: valid, raw: r.raw }
}
