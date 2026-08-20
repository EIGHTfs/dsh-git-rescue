/**
 * dsh-git-rescue 2.0.0 — 设备身份与 dsh 版本识别
 *
 * ② 远端备份仓命名：.dsh@<dsh版本>.<设备唯一标识>
 *   - dsh 版本：主实例 @deepseek-ai/dsh 包版本（如 0.1.0-rc.6），由守护进程读取
 *   - 设备标识：/etc/machine-id（Linux 系统级唯一 ID），兜底持久化 UUID
 *   - 为什么不用 hostname：主机名会撞车（不同设备同名）也不稳定（同设备可改名）
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { homedir, hostname } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'

const MACHINE_ID_PATHS = ['/etc/machine-id', '/var/lib/dbus/machine-id']

/** 读系统 machine-id（16+ 位 hex 校验）。 */
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
 * @param {string} stateRoot 插件状态目录（用于持久化兜底 ID）
 * @returns {Promise<{id: string, source: 'machine-id'|'persisted'|'hostname-hash'}>}
 */
export async function getDeviceId(stateRoot) {
  const mid = await readMachineId()
  if (mid) return { id: mid, source: 'machine-id' }
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

/** dsh 核心包候选路径（按优先级探测），覆盖主实例/测试实例/共存部署。 */
const DSH_CORE_PKG_CANDIDATES = [
  '/vol1/@appcenter/deepseek-harness/node_modules/@deepseek-ai/dsh/package.json',
  '/vol1/@appcenter/deepseek-harness-rc8/node_modules/@deepseek-ai/dsh/package.json',
]

/**
 * 读取 dsh 核心版本（@deepseek-ai/dsh 的 version 字段）。
 * 优先环境变量 DSH_CORE_VERSION（显式覆盖），否则探测候选路径；全部失败返回 null。
 * @returns {Promise<string|null>} 如 '0.1.0-rc.6'
 */
export async function getDshVersion() {
  if (process.env.DSH_CORE_VERSION) return process.env.DSH_CORE_VERSION
  for (const p of DSH_CORE_PKG_CANDIDATES) {
    try {
      const raw = await fs.readFile(p, 'utf8')
      const j = JSON.parse(raw)
      if (j.version) return String(j.version)
    } catch { /* 尝试下一个候选 */ }
  }
  return null
}

/**
 * 远端备份仓库默认名：.dsh@<dsh版本>.<设备ID前12位>（② 命名规范）。
 * 例：.dsh@0.1.0-rc.6.87566bf2a1c8
 * @returns {Promise<{repo: string, dshVersion: string|null, deviceId: string}>}
 */
export async function defaultBackupRepo(stateRoot) {
  const { id } = await getDeviceId(stateRoot)
  const dshVersion = await getDshVersion()
  const ver = dshVersion || 'unknown'
  return { repo: `.dsh@${ver}.${id.slice(0, 12)}`, dshVersion, deviceId: id.slice(0, 12) }
}
