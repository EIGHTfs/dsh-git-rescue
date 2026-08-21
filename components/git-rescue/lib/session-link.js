/**
 * dsh-git-rescue — 会话恢复联动（与 dsh-session-manager 插件协同）
 *
 * 设计原则（用户约定）：**恢复会话作为联动而非内置**——
 *  git-rescue 只管「崩溃检出/重启完成」，恢复中断的会话交给
 *  dsh-session-manager 插件；**装了才调用，没装就不调用，不内置**。
 *
 * 调用时机：git-rescue 启动时检出崩溃（crash-detected）后，调用
 *  session-manager 的 scan（扫描全部会话并自动续跑可续的）。
 *
 * 探测：GET /api/session-manager/list 返回 200 = 已安装可用；否则跳过。
 * 全部失败静默（联动失败不影响 git-rescue 主流程）。
 */

export const SM_API = {
  probe: '/api/session-manager/list',     // GET：探测是否安装
  scan: '/api/session-manager/scan',      // POST：扫描并自动续跑
  continue: '/api/session-manager/continue', // POST：续跑单会话 {sessionId}
}

function dshBaseUrl() {
  const host = process.env.DSH_HOST || '127.0.0.1'
  const port = process.env.DSH_PORT || 3081
  return `http://${host}:${port}`
}

/**
 * 探测 session-manager 是否安装可用。
 * @returns {Promise<boolean>}
 */
export async function sessionManagerAvailable() {
  try {
    const res = await fetch(`${dshBaseUrl()}${SM_API.probe}`, {
      signal: AbortSignal.timeout(3000),
    })
    return res.status >= 200 && res.status < 300
  } catch {
    return false // 未安装/未响应 → 视为不可用，静默跳过
  }
}

/**
 * 触发会话恢复联动：
 *  - 未安装 session-manager → 跳过（不报错，记录事件 skipped）
 *  - 已安装 → 调用 scan 自动续跑全部可续会话
 * @returns {{ok:boolean, linked:boolean, skipped:boolean, status?:number, detail?:string}}
 */
export async function linkSessionRecovery({ action = 'scan', sessionId = null, reason = '' } = {}) {
  const available = await sessionManagerAvailable()
  if (!available) {
    return { ok: true, linked: false, skipped: true, detail: 'session-manager 未安装，跳过会话恢复联动' }
  }

  try {
    let path = SM_API.scan
    let body = null
    if (action === 'continue' && sessionId) {
      path = SM_API.continue
      body = JSON.stringify({ sessionId })
    }
    const res = await fetch(`${dshBaseUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15_000),
    })
    const data = await res.json().catch(() => null)
    const ok = res.status >= 200 && res.status < 300
    return {
      ok,
      linked: true,
      skipped: false,
      status: res.status,
      detail: ok ? (data?.message || `scan 已触发（${reason || '崩溃恢复'}）`) : `scan 返回 HTTP ${res.status}`,
    }
  } catch (e) {
    // 联动失败静默：不影响 git-rescue 主流程
    return { ok: false, linked: true, skipped: false, detail: `session-manager 联动失败: ${String(e?.message ?? e)}` }
  }
}
