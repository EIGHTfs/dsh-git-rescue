/**
 * dsh-git-rescue — 进程现场捕获（stderr 落盘 + TERM 来源追踪）
 *
 * 背景：
 *  - 状态日志只有心跳，没有进程 stderr → 崩溃根因抓不到（harness-startup-failure-log 第七节待办）
 *  - 多次重启的 TERM 是谁发的完全不可见（本次调查最大盲区）
 *
 * 职责：
 *  1. startDshWithLog：以托管方式启动 DSH，stderr/stdout 落盘到 git-rescue/dsh-stderr.log
 *     （保留尾部滚动，避免无限膨胀）
 *  2. captureExitContext：进程消失时抓取退出上下文——信号/退出码、最近的 stderr 尾部、
 *     系统日志（dmesg/journalctl 若可用）中该 PID 的痕迹
 *  3. 生成的现场文本可由 guardian 写入崩溃记录（events + commit）
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

export const DEFAULT_STDERR_LIMIT = 500 * 1024 // 500KB 滚动上限

/** 追加文本到文件，超过 limit 时只保留尾部（滚动）。 */
export async function appendTail(file, text, limit = DEFAULT_STDERR_LIMIT) {
  try {
    await fs.appendFile(file, text)
    const st = await fs.stat(file).catch(() => null)
    if (st && st.size > limit) {
      const buf = await fs.readFile(file)
      const tail = buf.subarray(buf.length - limit)
      await fs.writeFile(file, tail)
    }
  } catch { /* 落盘失败不致命 */ }
}

/**
 * 托管启动 DSH：stderr/stdout 合并落盘（滚动），返回 child。
 * 若 spawn 本身失败返回 null。
 */
export function startDshWithLog(cmd, { logFile, env = process.env, onExit } = {}) {
  const child = spawn('sh', ['-c', cmd], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  })
  child.stdout?.on('data', (d) => appendTail(logFile, d))
  child.stderr?.on('data', (d) => appendTail(logFile, d))
  child.on('error', (e) => {
    appendTail(logFile, `[git-rescue] spawn 失败: ${String(e?.message ?? e)}\n`)
    onExit?.({ error: String(e?.message ?? e) })
  })
  child.on('exit', (code, signal) => {
    appendTail(logFile, `[git-rescue] 进程退出 code=${code} signal=${signal} @ ${new Date().toISOString()}\n`)
    onExit?.({ code, signal })
  })
  return child
}

/** 读最近 N 行 stderr 尾部（供现场留证）。 */
export async function readLogTail(file, n = 40) {
  try {
    const raw = await fs.readFile(file, 'utf8')
    const lines = raw.split('\n').filter(Boolean)
    return lines.slice(-n).join('\n')
  } catch { return '' }
}

/**
 * 抓取进程退出上下文（TERM 来源追踪）：
 *  - pid 的 /proc 残留（不存在则说明已消失）
 *  - 系统日志（journalctl/dmesg 可用时）中该 pid / 端口的最近痕迹
 *  - stderr 尾部（若有）
 *  - 返回结构化文本，供写 events/commit 留证
 */
export async function captureExitContext(pid, port, { stderrFile = null, stderrLines = 40 } = {}) {
  const parts = []
  parts.push(`--- exit context @ ${new Date().toISOString()} ---`)
  parts.push(`pid=${pid ?? 'unknown'} port=${port ?? 'unknown'}`)

  // 1) /proc 残留
  if (pid) {
    try {
      await fs.access(`/proc/${pid}`)
      parts.push(`/proc/${pid} 仍存在（进程可能未完全退出或 PID 被复用）`)
    } catch {
      parts.push(`/proc/${pid} 不存在（进程已消失）`)
    }
  }

  // 2) stderr 尾部
  if (stderrFile) {
    const tail = await readLogTail(stderrFile, stderrLines)
    if (tail) parts.push(`--- stderr tail ---\n${tail}`)
  }

  // 3) 系统日志（尽力而为：journalctl 按 PID 查，dmesg 尾部）
  for (const [name, args] of [
    ['journalctl', pid ? ['-n', '20', '--no-pager', `_PID=${pid}`] : ['-n', '20', '--no-pager']],
    ['dmesg', ['-T', '|', 'tail', '-n', '20']],
  ]) {
    try {
      const { execFile } = await import('node:child_process')
      const out = await new Promise((resolve) => {
        execFile(name, args, { timeout: 3000 }, (err, stdout) => resolve(err ? '' : String(stdout)))
      })
      if (out.trim()) parts.push(`--- ${name} ---\n${out.trim()}`)
    } catch { /* 工具不可用则跳过 */ }
  }

  return parts.join('\n')
}
