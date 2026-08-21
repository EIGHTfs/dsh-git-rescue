/**
 * dsh-git-rescue 2.5.0 — 守护进程重启方案管理（2026-08-21 web 多选共同启用）
 *
 * 用户需求：守护进程重启功能有多个方案，让用户在 guardian web 上多选、共同实现。
 * 方案（可叠加，多保险）：
 *  - monitor    ：bash 循环脚本每 10 秒端口探测，guardian 被杀自动拉起
 *  - cron       ：cron 每分钟保 monitor 存活（辅助 monitor，不独立重启 guardian）
 *  - supervisor ：supervisord 托管 guardian（autorestart=true）
 *  - systemd    ：systemd service（Restart=always）——本环境（容器无 session bus）不可用
 *
 * 配置存 <dshHome>/git-rescue/guardian-protection.json：{ methods: ['monitor','cron','supervisor'] }
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

/** 方案元信息（web 展示 + 可用性判断）。 */
export const PROTECTION_METHODS = {
  monitor: {
    label: 'monitor 脚本',
    desc: 'bash 循环每 10 秒端口探测 3082，被杀自动拉起',
    group: 'direct',
  },
  cron: {
    label: 'cron 每分钟保活',
    desc: 'cron 每分钟检查 monitor 脚本存活（辅助 monitor，需与 monitor 同开）',
    group: 'aux',
  },
  supervisor: {
    label: 'supervisor 托管',
    desc: 'supervisord 管理 guardian 进程（autorestart=true）',
    group: 'direct',
  },
  systemd: {
    label: 'systemd service',
    desc: '系统级进程托管（Restart=always）',
    group: 'direct',
  },
}

const SCRIPTS = {
  monitor: '/vol1/@appshare/DeepSeekHarness/.dsh/rescue/guardian-monitor.sh',
  cronSh: '/vol1/@appshare/DeepSeekHarness/.dsh/rescue/guardian-monitor-cron.sh',
  supervisorConf: '/vol1/@appshare/DeepSeekHarness/.dsh/supervisor/guardian.conf',
  systemdService: '/vol1/@appshare/DeepSeekHarness/.config/systemd/user/dsh-git-rescue-guardian.service',
  log: '/vol1/@appshare/DeepSeekHarness/.dsh/git-rescue/guardian-run.log',
}

/** 配置路径。 */
export function protectionConfigPath(dshHome) {
  return join(dshHome, 'git-rescue', 'guardian-protection.json')
}

/** 默认方案（monitor + cron + supervisor）。 */
export function defaultMethods() {
  return ['monitor', 'cron', 'supervisor']
}

/** 读取配置（无则默认）。 */
export async function readProtectionConfig(dshHome) {
  try {
    const raw = await fs.readFile(protectionConfigPath(dshHome), 'utf8')
    const j = JSON.parse(raw)
    if (Array.isArray(j.methods)) return { methods: j.methods.filter((m) => PROTECTION_METHODS[m]) }
  } catch { /* 首次 */ }
  return { methods: defaultMethods() }
}

/** 保存配置。 */
export async function saveProtectionConfig(dshHome, methods) {
  const valid = [...new Set((methods || []).filter((m) => PROTECTION_METHODS[m]))]
  const cfg = { methods: valid, savedAt: new Date().toISOString() }
  await fs.mkdir(join(dshHome, 'git-rescue'), { recursive: true })
  await fs.writeFile(protectionConfigPath(dshHome), JSON.stringify(cfg, null, 2), 'utf8')
  return cfg
}

/** 检测某方案当前是否在运行。 */
function isRunning(method) {
  try {
    if (method === 'monitor') {
      const out = execSync('pgrep -f "guardian-monitor.sh"', { encoding: 'utf8' }).trim()
      return out.split('\n').filter(Boolean).length > 0
    }
    if (method === 'cron') {
      const out = execSync('crontab -l 2>/dev/null | grep -c "guardian-monitor-cron"', { encoding: 'utf8' }).trim()
      return Number(out) > 0
    }
    if (method === 'supervisor') {
      const out = execSync('pgrep -f supervisord', { encoding: 'utf8' }).trim()
      return out.split('\n').filter(Boolean).length > 0
    }
    if (method === 'systemd') {
      const out = execSync('systemctl --user is-active dsh-git-rescue-guardian.service 2>/dev/null', { encoding: 'utf8' }).trim()
      return out === 'active'
    }
  } catch { /* 未运行 */ }
  return false
}

/** 方案可用性（systemd 在本环境不可用）。 */
export function methodAvailable(method) {
  if (method === 'systemd') {
    try {
      execSync('systemctl --user show-environment > /dev/null 2>&1')
      return true
    } catch { return false }
  }
  return true
}

/** 启用某方案。 */
export async function enableMethod(method) {
  try {
    if (method === 'monitor') {
      execSync(`setsid nohup bash ${SCRIPTS.monitor} >> ${SCRIPTS.log} 2>&1 < /dev/null &`, { shell: '/bin/bash' })
      return { ok: true }
    }
    if (method === 'cron') {
      const line = `* * * * * bash ${SCRIPTS.cronSh} > /dev/null 2>&1`
      const cur = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' })
      if (!cur.includes('guardian-monitor-cron')) {
        execSync(`(echo "${cur}" | grep -v guardian-monitor-cron; echo "${line}") | crontab -`, { shell: '/bin/bash' })
      }
      return { ok: true }
    }
    if (method === 'supervisor') {
      execSync(`setsid /vol1/@appshare/DeepSeekHarness/.local/bin/supervisord -c ${SCRIPTS.supervisorConf} >> ${SCRIPTS.log} 2>&1 < /dev/null &`, { shell: '/bin/bash' })
      return { ok: true }
    }
    if (method === 'systemd') {
      if (!methodAvailable('systemd')) return { ok: false, error: '本环境无 systemd session bus，不可用' }
      execSync(`systemctl --user enable dsh-git-rescue-guardian.service && systemctl --user start dsh-git-rescue-guardian.service`, { shell: '/bin/bash' })
      return { ok: true }
    }
    return { ok: false, error: `未知方案: ${method}` }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/** 停用某方案（不影响其他方案）。 */
export async function disableMethod(method) {
  try {
    if (method === 'monitor') {
      execSync('pkill -f "guardian-monitor.sh"', { shell: '/bin/bash' })
      return { ok: true }
    }
    if (method === 'cron') {
      const cur = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' })
      const next = cur.split('\n').filter((l) => !l.includes('guardian-monitor-cron')).join('\n')
      execSync(`echo "${next}" | crontab -`, { shell: '/bin/bash' })
      return { ok: true }
    }
    if (method === 'supervisor') {
      execSync('pkill -f "supervisord -c" ; pkill -f supervisord', { shell: '/bin/bash' })
      return { ok: true }
    }
    if (method === 'systemd') {
      execSync('systemctl --user disable --now dsh-git-rescue-guardian.service 2>/dev/null', { shell: '/bin/bash' })
      return { ok: true }
    }
    return { ok: false, error: `未知方案: ${method}` }
  } catch (e) {
    // 未在运行也算成功（幂等）
    return { ok: true }
  }
}

/** 全量状态：配置 + 每方案运行状态 + 可用性。 */
export async function protectionStatus(dshHome) {
  const cfg = await readProtectionConfig(dshHome)
  const methods = []
  for (const m of Object.keys(PROTECTION_METHODS)) {
    methods.push({
      id: m,
      ...PROTECTION_METHODS[m],
      enabled: cfg.methods.includes(m),
      running: isRunning(m),
      available: methodAvailable(m),
    })
  }
  return { ok: true, config: cfg, methods }
}
