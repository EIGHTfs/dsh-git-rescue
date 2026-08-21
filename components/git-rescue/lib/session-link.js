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
  probe: '/api/session-manager/list',     // GET：探测（0.4+ 有）
  scan: '/api/session-manager/scan',      // POST：扫描并自动续跑（0.3+ 有）
  continue: '/api/session-manager/continue', // POST：续跑单会话 {sessionId}
}

function dshBaseUrl() {
  const host = process.env.DSH_HOST || '127.0.0.1'
  const port = process.env.DSH_PORT || 3081
  return `http://${host}:${port}`
}

/**
 * 探测 session-manager 是否安装可用（只读探测，无副作用）。
 * 兼容多版本：GET list（0.4+）或 GET scan（0.3+，返回 405/200 都说明路由存在）。
 * 注意：不 POST scan 做探测（避免探测即触发续跑）。
 * @returns {Promise<boolean>}
 */
export async function sessionManagerAvailable() {
  for (const path of [SM_API.probe, SM_API.scan]) {
    try {
      const res = await fetch(`${dshBaseUrl()}${path}`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000),
      })
      // 200/404/405/500 都说明路由存在（插件已装）；000/网络错误才说明没装
      if (res.status !== 0) return true
    } catch { /* 继续试下一个端点 */ }
  }
  return false // 两个端点都不响应 → 未安装
}

/**
 * 触发会话恢复联动（探测 + 调用合并）：
 *  - POST scan：返回 200/4xx = session-manager 已装且联动成功；000/网络错误 = 未装，跳过
 *  - scan 幂等安全（session-manager 自带冷却/并发护栏），作为崩溃恢复的一部分可接受
 *  - 兼容 0.3+（scan 路由 0.3 已有）与 0.6+（含 list/continue 等）
 * @returns {{ok:boolean, linked:boolean, skipped:boolean, status?:number, detail?:string}}
 */
export async function linkSessionRecovery({ action = 'scan', sessionId = null, reason = '' } = {}) {
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
    if (res.status === 0) {
      return { ok: true, linked: false, skipped: true, detail: 'session-manager 未安装，跳过会话恢复联动' }
    }
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
    // 联动失败静默：不影响 git-rescue 主流程（含未安装导致的连接失败）
    return { ok: false, linked: false, skipped: true, detail: `session-manager 联动失败/未安装: ${String(e?.message ?? e)}` }
  }
}
