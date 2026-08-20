/**
 * dsh-git-rescue — 沙盒/容器环境能力检测（v1.10.0）
 *
 * 实测背景（container-root-privilege skill，2026-08-19）：
 *   - bwrap 容器内 sudo/su/pkexec 全失败：NoNewPrivs=1（内核禁提权）+ CapEff=0（无 capability）
 *     + /etc/sudo.conf 属主 uid 65534（应为 0）——三重限制叠加，容器内提权是死路
 *   - /vol1 只读时容器内无法 remount rw，必须外部 SSH root@<host> 处理
 *   - 教训：不要浪费时间尝试容器内提权，先探测环境再决定动作（verify-before-diagnose）
 *
 * 本模块把环境能力检测固化为代码，供 status API / guardian / 故障分类决策使用。
 * 纯读操作（/proc、/etc），零副作用，可安全在任意实例调用；任何读取失败按"未知"降级，不抛错。
 */

import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'

/** 读 /proc/self/status 中指定字段（如 NoNewPrivs / CapEff / CapPrm / Uid）。读不到返回 null。 */
async function readStatusField(field) {
  try {
    const raw = await fs.readFile('/proc/self/status', 'utf8')
    const m = raw.match(new RegExp(`^${field}:\\s+(.+)$`, 'm'))
    return m ? m[1].trim() : null
  } catch { return null }
}

/** 容器标志检测：/.dockerenv 存在 或 cgroup 含容器标识 或 /proc/1/comm 非系统 init。 */
async function detectContainer() {
  try {
    if (existsSync('/.dockerenv')) return true
    for (const p of ['/proc/1/cgroup', '/proc/self/cgroup']) {
      try {
        const raw = await fs.readFile(p, 'utf8')
        if (/docker|containerd|kubepods|lxc|bwrap|podman|runc/i.test(raw)) return true
      } catch { /* 读不到继续 */ }
    }
    try {
      const comm = (await fs.readFile('/proc/1/comm', 'utf8')).trim()
      if (!/^(init|systemd|tini|s6-svscan|supervisord)$/i.test(comm)) return true // 非标准 init = 容器/sandbox 特征
    } catch { /* 读不到不算 */ }
  } catch { /* 忽略 */ }
  return false
}

/** sudo 可行性（纯读判断，不执行 sudo）：任一硬限制命中即 false。 */
async function detectSudoUsable() {
  try {
    const noNewPrivs = (await readStatusField('NoNewPrivs')) === '1'
    if (noNewPrivs) return false // 内核级禁提权，sudo/setuid 全失效
    const capEff = await readStatusField('CapEff')
    if (capEff && /^0+$/.test(capEff)) return false // CapEff 全零 = 无任何 capability
    try {
      const st = await fs.stat('/etc/sudo.conf')
      if (st.uid !== 0) return false // sudo.conf 属主非 root，sudo 直接拒绝
    } catch { return false } // 无 sudo.conf = 环境不提供 sudo
    return true
  } catch { return false }
}

/** 只读挂载点列表：/proc/mounts 中挂载选项含 ro 的行。 */
async function detectReadOnlyMounts() {
  try {
    const raw = await fs.readFile('/proc/mounts', 'utf8')
    const list = []
    for (const line of raw.split('\n')) {
      const m = line.match(/^(\S+) (\S+) (\S+) (\S+)/)
      if (!m) continue
      const [, dev, mount, type, opts] = m
      if (opts.split(',').includes('ro')) list.push({ mount, type, dev })
    }
    return list
  } catch { return [] }
}

/**
 * 沙盒环境能力检测主入口。
 * @returns {Promise<object>} {
 *   isSandbox  — 容器/bwrap 沙盒（cgroup/dockerenv/NoNewPrivs 任一命中）
 *   noNewPrivs — 内核禁提权标志（sudo/setuid 永久失效）
 *   capEff     — 当前进程 capability 十六进制（全零 = 无特权）
 *   isRoot     — 当前是否 root（uid 0）
 *   canSudo    — sudo 提权路径是否可行（NoNewPrivs/CapEff/sudo.conf 三重判断）
 *   readOnlyMounts — 只读挂载点列表（前 10 条）
 *   detectedAt
 * }
 */
export async function detectSandbox() {
  const [noNewPrivs, capEff, uid, container] = await Promise.all([
    readStatusField('NoNewPrivs'),
    readStatusField('CapEff'),
    readStatusField('Uid'),
    detectContainer(),
  ])
  const isRoot = typeof process.getuid === 'function' ? process.getuid() === 0 : uid === '0'
  const canSudo = await detectSudoUsable()
  const readOnlyMounts = await detectReadOnlyMounts()
  return {
    isSandbox: !!container || noNewPrivs === '1',
    noNewPrivs: noNewPrivs === '1',
    capEff: capEff ?? null,
    isRoot,
    canSudo,
    readOnlyMounts: readOnlyMounts.slice(0, 10),
    detectedAt: new Date().toISOString(),
  }
}
