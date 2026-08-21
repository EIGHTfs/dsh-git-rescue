/**
 * dsh-git-rescue — 设备身份识别
 *
 * 为什么需要：备份仓库名若只用 hostname，会撞车（不同设备可同名）或不稳定（同一设备可改名）。
 * 因此用【设备稳定唯一标识】生成备份仓名：
 *
 *   1. /etc/machine-id（或 /var/lib/dbus/machine-id）—— Linux 系统级唯一 ID，首选
 *   2. 持久化生成的 UUID（~/.dsh/git-rescue/device-id）—— 跨重启稳定，兜底
 *   3. hostname 哈希 —— 最弱兜底（几乎不会走到）
 *
 * 备份仓默认名 = dsh-git-rescue-backup-<id 前 12 位>；hostname 仅进仓库描述供人识别。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { homedir, hostname } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'

const MACHINE_ID_PATHS = ['/etc/machine-id', '/var/lib/dbus/machine-id']

/** 读系统 machine-id（32 位 hex 校验）。 */
export async function readMachineId() {
  for (const p of MACHINE_ID_PATHS) {
    try {
      const s = (await fs.readFile(p, 'utf8')).trim()
      if (/^[0-9a-fA-F]{16,}$/.test(s)) return s.toLowerCase()
    } catch { /* 无权限或不存在 */ }
  }
  return null
}

/**
 * 获取设备唯一 ID。
 * @param stateRoot 插件状态目录（~/.dsh/git-rescue），用于持久化兜底 ID
 * @returns { id, source } source ∈ machine-id | persisted | hostname-hash
 */
export async function getDeviceId(stateRoot) {
  const mid = await readMachineId()
  if (mid) return { id: mid, source: 'machine-id' }

  // 兜底：持久化 UUID（首次生成后固定）
  try {
    const file = join(stateRoot, 'device-id')
    try {
      const existing = (await fs.readFile(file, 'utf8')).trim()
      if (existing) return { id: existing, source: 'persisted' }
    } catch { /* 首次 */ }
    const uuid = randomUUID().replace(/-/g, '')
    await fs.mkdir(stateRoot, { recursive: true })
    await fs.writeFile(file, uuid + '\n', { mode: 0o600 })
    return { id: uuid, source: 'persisted' }
  } catch { /* 状态目录不可写 */ }

  return { id: createHash('sha256').update(hostname()).digest('hex').slice(0, 32), source: 'hostname-hash' }
}

/** 备份仓库默认名：dsh-git-rescue-backup-<id 前 12 位>（设备唯一，与主机名无关）。 */
export async function defaultBackupRepo(stateRoot) {
  const { id } = await getDeviceId(stateRoot)
  return `dsh-git-rescue-backup-${id.slice(0, 12)}`
}
