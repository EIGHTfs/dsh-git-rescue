/**
 * dsh-git-rescue — 业务就绪探活（健康检查升级）
 *
 * 背景：曾出现"进程在、端口在，但 tools 服务未激活"的假活期（api-proxy
 * presenter 大量报 `cannot get required service "tools" in inactive context`），
 * 旧探活只 GET / 200 就判健康，把"启动成功但服务未就绪"误判为健康。
 *
 * 职责：按序探测多个端点，全部通过才算健康：
 *  1. 根路径 GET /（进程活着、HTTP 层通）
 *  2. 业务端点 GET /api/status（DSH 业务路由可用，非白屏/未就绪）
 *  3. 可选：工具服务枚举探测（GET /api/tools 或等价，可配置）
 *
 * 结果分级：
 *  - healthy      ：全部通过
 *  - degraded     ：根通但业务端点失败（服务未就绪 → 判为假活，触发救援）
 *  - down         ：根都不通（进程挂了）
 *
 * 纯函数 + fetch 注入，可单测（mock fetch）。
 */

export const DEFAULT_PROBE = {
  rootPath: '/',
  apiPath: '/api/status',
  toolsPath: '/api/tools',
  timeoutMs: 5000,
  // 业务端点视为健康的状态码范围（DSH API 正常返回 2xx；404=路由未就绪/白屏）
  apiOkStatus: [200, 201, 202, 204],
}

export async function probeDshHealth(fetchImpl, host, port, opts = {}) {
  const o = { ...DEFAULT_PROBE, ...opts }
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : fetch
  const base = `http://${host}:${port}`

  async function tryGet(path) {
    try {
      const res = await doFetch(base + path, { signal: AbortSignal.timeout(o.timeoutMs) })
      return { status: res.status, ok: res.ok }
    } catch (e) {
      return { status: 0, ok: false, error: String(e?.message ?? e) }
    }
  }

  // 1) 根路径：进程活着？
  const root = await tryGet(o.rootPath)
  if (!root.ok && root.status === 0) return { level: 'down', detail: { root } }

  // 2) 业务端点：服务就绪？API 404 = 白屏/未就绪（根可能由静态兜底返回 200）
  const api = await tryGet(o.apiPath)
  const apiOk = o.apiOkStatus.includes(api.status)
  if (!apiOk) {
    return { level: 'degraded', detail: { root, api } }
  }

  // 3) 工具服务枚举（可配禁用：toolsPath 传 null）
  let tools = null
  if (o.toolsPath) {
    tools = await tryGet(o.toolsPath)
    const toolsOk = o.apiOkStatus.includes(tools.status)
    if (!toolsOk) return { level: 'degraded', detail: { root, api, tools } }
  }

  return { level: 'healthy', detail: { root, api, tools } }
}
