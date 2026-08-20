/**
 * dsh-git-rescue 2.0.0 — 管理员密码存储（2026-08-20 EIGHTfs 需求）
 *
 * 用途：守护进程网页提供「填写管理员密码」入口 → 存本机敏感目录 →
 * 需要提权的操作（Windows 开启 SSH 等）自动用密码以管理员执行，免 UAC 弹窗。
 *
 * 存储规范（与 data/sensitive/sudo-key 同规格）：
 *   - 位置：workspace/data/sensitive/admin-password（600 权限）
 *   - 不进 git / 不进公开仓库（dsh-git-push 审计会拦敏感信息）
 *   - 状态只报「已配置/未配置」，不返回明文
 *
 * 安全：密码只在本机敏感目录；读取仅限守护进程内部提权操作；网页输入框用 password 类型。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'

/** 敏感目录（与 github-token / sudo-key 同级）。 */
export function sensitiveDir(workspace) {
  return join(workspace, 'data', 'sensitive')
}

/** 管理员密码文件路径。 */
export function adminPasswordPath(workspace) {
  return join(sensitiveDir(workspace), 'admin-password')
}

/** 保存管理员密码（600 权限）。 */
export async function saveAdminPassword(workspace, password) {
  try {
    if (!password || typeof password !== 'string' || !password.trim()) {
      return { ok: false, error: '密码为空' }
    }
    const dir = sensitiveDir(workspace)
    await fs.mkdir(dir, { recursive: true })
    const p = adminPasswordPath(workspace)
    await fs.writeFile(p, password.trim() + '\n', { mode: 0o600 })
    return { ok: true, path: p, configured: true }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/** 读取管理员密码（未配置返回 null）。 */
export async function readAdminPassword(workspace) {
  try {
    const raw = await fs.readFile(adminPasswordPath(workspace), 'utf8')
    const pw = raw.trim()
    return pw || null
  } catch { return null }
}

/** 管理员密码状态（不返回明文）。 */
export async function adminPasswordStatus(workspace) {
  const pw = await readAdminPassword(workspace)
  return { configured: !!pw, path: pw ? adminPasswordPath(workspace) : null }
}

/** 清除管理员密码（用户主动清除，防残留）。 */
export async function clearAdminPassword(workspace) {
  try {
    await fs.rm(adminPasswordPath(workspace), { force: true })
    return { ok: true, configured: false }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}
