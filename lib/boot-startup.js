/**
 * dsh-git-rescue 2.0.0 — 开机自启注册（③）
 *
 * 依据被救援机写系统开机自启的守护进程：
 *  - 守护进程启动命令生成在 **.dsh 目录这一层**（git 仓库根目录）
 *    → .dsh/rescue/rescue-start.sh（启动 guardian + 救援环境管理）
 *  - 系统自启钩子：/etc/rc.local（本机 systemd rc-local.service 已 enabled，
 *    只需创建 /etc/rc.local 文件并写入调用）；无 systemd 时回退 /etc/rc.d/rc.local。
 *  - 写入需 root；无权限时返回明确错误并留待用户执行（guardian-boot.sh 方式兼容）。
 *
 * 安全：脚本内容固定模板，不含凭据；日志统一写 .dsh/git-rescue/ 下。
 */

import { promises as fs } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const RESCUE_DIR_NAME = 'rescue'
export const START_SCRIPT_NAME = 'rescue-start.sh'
export const BOOT_SCRIPT_NAME = 'guardian-boot.sh'

/**
 * 当前插件安装根目录（lib/ 的上级 = 插件根）。
 * 2026-08-20 修复：boot 脚本不再硬编码 workspace 旧路径——无论插件装在
 * 任务目录/主环境 node_modules/测试环境，都从 import.meta.url 推导，
 * 保证开机自启拉起的是**当前安装的新代码**（防旧代码残留抢 3082 端口）。
 */
export function installRoot() {
  const here = fileURLToPath(import.meta.url) // .../lib/boot-startup.js
  return dirname(dirname(here))               // 插件根
}

/** 当前安装的 guardian server.js 绝对路径。 */
export function guardianServerPath() {
  return join(installRoot(), 'guardian', 'server.js')
}

/** .dsh 目录这一层的救援目录（git 仓库根下的 rescue 子目录）。 */
export function rescueDir(dshHome) {
  return join(dshHome, RESCUE_DIR_NAME)
}

/** 守护进程启动脚本路径（.dsh/rescue/rescue-start.sh）。 */
export function startScriptPath(dshHome) {
  return join(rescueDir(dshHome), START_SCRIPT_NAME)
}

/**
 * 生成守护进程启动脚本内容（固定模板，命令放 .dsh 这一层）。
 * @param {object} cfg { dshHome, dshPort, guardianPort, nodeBin, guardianServer }
 */
export function renderStartScript(cfg) {
  const {
    dshHome = '/vol1/@appshare/DeepSeekHarness/.dsh',
    dshPort = 3081,
    guardianPort = 3082,
    nodeBin = '/vol1/@appcenter/deepseek-harness/bin/node',
    guardianServer = guardianServerPath(), // 2026-08-20 修复：从安装位置推导，不硬编码旧路径
  } = cfg
  const logFile = join(dshHome, 'git-rescue', 'guardian-boot.log')
  return `#!/bin/bash
# dsh-git-rescue 守护进程启动脚本（自动生成，③ 开机自启）
# 位置：.dsh 目录这一层（git 仓库根目录）
# 职责：幂等启动 guardian 守护进程（已在运行则跳过）
DSH_HOME="${dshHome}"
GUARDIAN_SERVER="${guardianServer}"
LOG="${logFile}"
mkdir -p "$(dirname "$LOG")"

if pgrep -f "guardian/server.js" > /dev/null 2>&1; then
  echo "$(date +%T) guardian 已在运行，跳过" >> "$LOG"
  exit 0
fi

cd "$(dirname "$GUARDIAN_SERVER")" || exit 1
echo "$(date +%T) 启动 guardian（开机自启）" >> "$LOG"
DSH_PORT=${dshPort} \\
DSH_HOME="${dshHome}" \\
GUARDIAN_PORT=${guardianPort} \\
GUARDIAN_INTERVAL_MS=10000 \\
GUARDIAN_FAIL_THRESHOLD=3 \\
setsid nohup node "\${GUARDIAN_SERVER}" >> "$LOG" 2>&1 < /dev/null &
sleep 3
pgrep -f "guardian/server.js" > /dev/null 2>&1 && echo "$(date +%T) ✅ guardian 已启动" >> "$LOG" || echo "$(date +%T) ❌ guardian 启动失败" >> "$LOG"
exit 0
`
}

/**
 * 在 .dsh 目录这一层生成守护进程启动脚本（rescue-start.sh）。
 * @returns {Promise<{ok:boolean, path:string, error?:string}>}
 */
export async function writeStartScript(dshHome, cfg = {}) {
  try {
    const dir = rescueDir(dshHome)
    await fs.mkdir(dir, { recursive: true })
    const p = startScriptPath(dshHome)
    await fs.writeFile(p, renderStartScript({ dshHome, ...cfg }), { mode: 0o700 })
    return { ok: true, path: p }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

/**
 * 生成 guardian 开机自启脚本（兼容旧 guardian-boot.sh 命名，放 .dsh/rescue/）。
 */
export function renderBootScript(cfg) {
  const start = startScriptPath(cfg.dshHome || '/vol1/@appshare/DeepSeekHarness/.dsh')
  return `#!/bin/bash
# dsh-git-rescue guardian 开机自启脚本（自动生成，③）
# 由 /etc/rc.local 调用；幂等（已在运行则跳过）
exec bash "${start}"
`
}

/** 系统自启钩子候选路径（本机 systemd rc-local.service 已 enabled）。 */
export function rcLocalCandidates() {
  return ['/etc/rc.local', '/etc/rc.d/rc.local']
}

/**
 * 注册系统开机自启：把调用写入 /etc/rc.local（存在则追加，不存在则创建）。
 * 需要 root 权限；失败时给出人工执行指引。
 * @returns {Promise<{ok:boolean, rcLocal?:string, error?:string, manual?:string}>}
 */
export async function installBootAutostart(dshHome, cfg = {}) {
  try {
    // 1) 先确保 .dsh 层启动脚本存在
    const w = await writeStartScript(dshHome, cfg)
    if (!w.ok) return { ok: false, error: `启动脚本生成失败: ${w.error}` }
    // 2) 写入 /etc/rc.local
    const rc = '/etc/rc.local'
    const bootCall = `\n# dsh-git-rescue 守护进程开机自启（③）\nif [ -x "${w.path}" ]; then\n  bash "${w.path}"\nfi\n`
    let content = ''
    try { content = await fs.readFile(rc, 'utf8') } catch { /* 不存在则新建 */ }
    if (!content.includes('dsh-git-rescue 守护进程开机自启')) {
      // rc.local 需要可执行 + 头部 shebang
      const header = content.trim() ? '' : '#!/bin/bash\n'
      const merged = header + content.trimEnd() + '\n' + bootCall
      await fs.writeFile(rc, merged, { mode: 0o755 })
    }
    return { ok: true, rcLocal: rc, script: w.path }
  } catch (e) {
    const msg = String(e?.message ?? e)
    // 权限不足时的兼容路径：/etc/rc.local 已存在由用户执行，脚本已生成在 .dsh 层
    const manual = `启动脚本已生成: ${startScriptPath(dshHome)}。请以 root 执行一次:\n  echo 'bash ${startScriptPath(dshHome)}' >> /etc/rc.local && chmod 755 /etc/rc.local`
    return { ok: false, error: msg, manual, script: startScriptPath(dshHome) }
  }
}

/** 查询开机自启注册状态。 */
export async function bootAutostartStatus(dshHome) {
  const script = startScriptPath(dshHome)
  const hasScript = await fs.access(script).then(() => true).catch(() => false)
  let rcLocal = null
  let rcRegistered = false
  for (const rc of rcLocalCandidates()) {
    try {
      const content = await fs.readFile(rc, 'utf8')
      rcLocal = rc
      rcRegistered = content.includes('dsh-git-rescue')
      break
    } catch { /* 下一个 */ }
  }
  return {
    script,
    hasScript,
    rcLocal,
    rcRegistered,
    registered: hasScript && rcRegistered,
    rescueDir: rescueDir(dshHome),
  }
}

/** 移除开机自启注册（从 /etc/rc.local 删除相关段）。 */
export async function uninstallBootAutostart(dshHome) {
  try {
    const rc = '/etc/rc.local'
    const content = await fs.readFile(rc, 'utf8')
    const marker = 'dsh-git-rescue 守护进程开机自启'
    if (content.includes(marker)) {
      // 删除从 marker 到文件尾（自启段固定在末尾）
      const idx = content.indexOf('# ' + marker)
      const cleaned = idx >= 0 ? content.slice(0, idx).trimEnd() + '\n' : content
      await fs.writeFile(rc, cleaned, { mode: 0o755 })
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}
