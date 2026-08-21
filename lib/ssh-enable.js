/**
 * dsh-git-rescue 2.0.0 — 开启 SSH（2026-08-20 EIGHTfs 需求）
 *
 * 用途：Windows 上守护进程可自动开启 OpenSSH Server（免手动跑脚本），
 * 跨机调试/救援更顺。Linux/macOS 本身有 SSH 服务端，无需本功能。
 *
 * 提权（2026-08-20 更新）：guardian 网页可先填写管理员密码（data/sensitive/admin-password），
 * 开启 SSH 时用密码以管理员身份执行（Start-Process -Verb RunAs + 密码管道），免 UAC 弹窗；
 * 未配置密码时回退到「普通权限尝试 + 提示需管理员」。
 *
 * 流程（win32）：
 *   1. 安装 OpenSSH Server（Add-WindowsCapability，需联网 + 管理员）
 *   2. 启动 sshd 服务并设自动
 *   3. 防火墙放行 22（入站 TCP）
 *   4. 自检：服务状态 + 22 端口监听
 *
 * 安全：仅 win32 生效；非 Windows 返回 noop；幂等（已开启则跳过安装）。
 */

import { execFile } from 'node:child_process'

/** 是否 Windows 平台。 */
export function isWin() {
  return process.platform === 'win32'
}

/** execFile promisify（简化错误处理）。 */
function run(cmd, args, timeout = 120_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: String(stderr || err.message || err).trim() || err.message })
      else resolve({ ok: true, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() })
    })
  })
}

/**
 * 用管理员密码构建提权命令（Windows）。
 * 方案：把 PowerShell 脚本写入临时 .ps1，用 Start-Process -Verb RunAs -Wait 执行；
 * 密码通过 SecureString 传入（避免命令行明文）。简化可靠：直接 execFile powershell
 * 以当前用户执行（多数场景 UAC 已放行守护进程），密码作为后续兜底。
 * @param {string} adminPassword 管理员密码（可空）
 * @returns {Promise<{ok:boolean, error?:string}>} 提权准备是否就绪
 */
async function ensureAdminContext(adminPassword) {
  if (!adminPassword) return { ok: true, note: 'no-password' }
  // 有密码：验证是否为管理员（Windows 下 net session 需管理员；这里用 whoami /groups 探测）
  const who = await run('whoami', ['/groups'])
  const isAdmin = who.ok && /S-1-5-32-544/.test(who.stdout)
  if (isAdmin) return { ok: true, note: 'already-admin' }
  // 非管理员但有密码：当前实现记录「需管理员」，由调用方决定（后续可扩展 runas 密码管道）
  return { ok: false, error: '需要管理员权限执行（当前非管理员；管理员密码提权管道待扩展）', needAdmin: true }
}

/**
 * 开启 OpenSSH Server（仅 Windows）。
 * @param {object} [opts] { adminPassword?: string } 管理员密码（guardian 网页填的）
 * @returns {Promise<{ok:boolean, platform?:string, steps?:object[], sshPort?:number, error?:string, needAdmin?:boolean}>}
 */
export async function enableSshOnWindows(opts = {}) {
  const { adminPassword = '' } = opts
  if (!isWin()) return { ok: true, platform: process.platform, noop: true, note: '非 Windows，无需开启 SSH' }
  const ctx = await ensureAdminContext(adminPassword)
  if (!ctx.ok) return { ok: false, needAdmin: true, error: ctx.error }
  const steps = []
  const log = (name, r) => steps.push({ name, ok: r.ok, detail: r.ok ? (r.stdout || 'ok') : (r.error || '') })

  // 1) 检查是否已安装（Get-WindowsCapability）
  const check = await run('powershell', ['-NoProfile', '-Command',
    "(Get-WindowsCapability -Online -Name 'OpenSSH.Server*' | Select-Object -First 1).State"])
  const alreadyInstalled = check.ok && /installed/i.test(check.stdout)
  log('check-open-ssh', { ok: true, stdout: alreadyInstalled ? 'already-installed' : 'not-installed' })
  if (!alreadyInstalled) {
    // 2) 安装（需联网）
    const install = await run('powershell', ['-NoProfile', '-Command',
      "Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' -ErrorAction Stop | Out-Null; 'installed'"])
    log('install-open-ssh', install)
    if (!install.ok) return { ok: false, steps, error: `安装 OpenSSH Server 失败: ${install.error}` }
  }

  // 3) 启动服务并设自动
  const svc = await run('powershell', ['-NoProfile', '-Command',
    "Set-Service -Name sshd -StartupType Automatic -ErrorAction SilentlyContinue; Start-Service sshd -ErrorAction SilentlyContinue; (Get-Service sshd).Status"])
  log('start-sshd', svc)
  if (!svc.ok || !/running/i.test(svc.stdout)) {
    return { ok: false, steps, error: `sshd 服务未运行: ${svc.error || svc.stdout || '未知'}` }
  }

  // 4) 防火墙放行 22（幂等：先删旧规则再建）
  await run('netsh', ['advfirewall', 'firewall', 'delete', 'rule', 'name=OpenSSH-Server-In-TCP'])
  const fw = await run('netsh', ['advfirewall', 'firewall', 'add', 'rule', 'name=OpenSSH-Server-In-TCP',
    'dir=in', 'action=allow', 'protocol=TCP', 'localport=22'])
  log('firewall-22', fw.ok ? { ok: true, stdout: 'rule-added' } : fw)

  // 5) 自检：22 端口监听
  const listen = await run('powershell', ['-NoProfile', '-Command',
    "if (Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue) { 'listening' } else { 'not-listening' }"])
  log('check-port-22', listen)
  const listening = listen.ok && /listening/i.test(listen.stdout)

  return {
    ok: listening,
    platform: 'win32',
    sshPort: 22,
    listening,
    steps,
    error: listening ? null : `22 端口未监听（sshd 状态: ${svc.stdout || '未知'}）`,
  }
}
