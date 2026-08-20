/**
 * dsh-git-rescue — 故障分类（P0/P1：分清"能回退"与"不能回退"）
 *
 * 背景（AGNES-LESSON + dsh-boot-troubleshooting）：DSH 启动失败/无限重启有四层原因——
 * 系统层（/vol1 只读）、引导层（软链冲突）、插件层（导出/依赖错误）、**资源层（内存 OOM）**。
 * 只有**插件层**能靠 git 回退恢复；系统/引导/内存故障回退无意义（甚至浪费重启次数）。
 *
 * 本模块：探活失败时对故障分类，决定 guardian 是否走 git 回退救援。
 * 纯逻辑 + 注入探测函数，可单测。
 *
 * 2026-08-21 新增 OOM 识别：用户实测"内存崩了好几次"——OOM 崩溃此前被误判 unknown
 * → 走 git 回退（无用）→ 拉起 → 又崩 → 死循环。现在识别为 oom 类型：不回退、直接拉起
 * （OOM 崩溃后进程已退出、内存已释放，拉起成功率最高），并附带内存诊断。
 */

import { totalmem, freemem } from 'node:os'

/**
 * 故障类型：
 *  - system   ：系统盘只读 / I/O 错误——不可回退，需人工 remount rw / 修盘
 *  - boot     ：引导层软链冲突 / 挂载不支持软链——不可回退，需人工处理 node_modules
 *  - oom      ：内存不足（V8 堆耗尽 / 系统 OOM killer）——不可回退（回退无意义），
 *               崩溃后进程已退出内存已释放，直接拉起 + 内存诊断
 *  - plugin   ：插件配置变更 / 插件加载失败——可回退（git 恢复事故前配置）
 *  - unknown  ：无法判定——保守按可回退处理（回退不损坏系统）
 */
export function classifyFault({ systemHints = '', bootHints = '', pluginConfigChanged = false } = {}) {
  // 系统故障特征：/vol1 只读、I/O error、Remounting filesystem read-only、Read-only file system
  const sysPat = /read-only file system|remounting filesystem read-only|i\/o error|io error|input\/output error|ext4-fs error/i
  if (sysPat.test(systemHints)) return { type: 'system', recoverable: false, reason: '系统盘只读/I-O 错误，回退无意义，需人工修盘后 remount rw' }

  // 引导故障特征：软链冲突 / 挂载不支持软链
  const bootPat = /not a symlink|exists and is not a symlink|enotsup|operation not supported|cannot create symbolic link|symlink/i
  if (bootPat.test(bootHints)) return { type: 'boot', recoverable: false, reason: '引导层软链冲突/挂载不支持软链，需人工处理 node_modules' }

  // OOM 故障特征（2026-08-21 新增）：V8 堆耗尽 / 系统 OOM killer / SIGABRT。
  // 注意 "Aborted"/"SIGABRT" 与 Node FATAL 崩溃常伴，误报风险低于"回退死循环"代价。
  const oomPat = /javascript heap out of memory|fatal error|allocation failed|heap limit|heap out of memory|out of memory|oom-killer|killed process|sigabrt|aborted|cannot allocate memory/i
  if (oomPat.test(bootHints) || oomPat.test(systemHints)) {
    return { type: 'oom', recoverable: false, reason: '内存不足（OOM）——git 回退无意义，崩溃后内存已释放，直接拉起并诊断内存' }
  }

  // 插件故障：插件配置有变更（可回退恢复事故前配置）
  if (pluginConfigChanged) return { type: 'plugin', recoverable: true, reason: '插件配置变更（疑似装/改插件导致），git 回退可恢复' }

  // 未知：保守按可回退处理（回退是安全的最后手段）
  return { type: 'unknown', recoverable: true, reason: '无法判定故障类型，保守走 git 回退' }
}

/**
 * 探测系统层故障提示（注入式，供单测；生产用 mount/dmesg）。
 * @param exec 执行函数 async (cmdArgs: string[]) => string，用于跑 mount/dmesg
 * @returns {string} 系统提示文本（无则空串）
 */
export async function probeSystemHints(exec) {
  let hints = ''
  // 1) /vol1 挂载是否只读
  try {
    const mountOut = await exec(['mount'])
    const ro = mountOut.split('\n').filter((l) => l.includes('/vol1') && l.includes('ro,'))
    if (ro.length) hints += ` /vol1 mount ro: ${ro[0].slice(0, 80)}`
  } catch { /* mount 不可用 */ }
  // 2) dmesg 尾部错误（I/O / remount read-only / OOM killer）——exec 实现自行处理尾部截取
  try {
    const dmesgOut = await exec(['dmesg', '-T'])
    const tail = String(dmesgOut).split('\n').slice(-60).join('\n')
    const m = tail.match(/I\/O error|EXT4-fs error|Remounting filesystem read-only|Read-only file system|Out of memory|oom-killer/i)
    if (m) hints += ` dmesg: ${m[0]}`
  } catch { /* dmesg 需要权限，跳过 */ }
  return hints.trim()
}

/**
 * 内存摘要（跨平台，零依赖）：Node os.totalmem/freemem。
 * 供 guardian 的 OOM 诊断与插件 status 共用。
 * @returns {{totalMb:number, freeMb:number, usedMb:number, detail:string}}
 */
export function readMemSummary() {
  const totalMb = Math.floor(totalmem() / 1024 / 1024)
  const freeMb = Math.floor(freemem() / 1024 / 1024)
  return {
    totalMb,
    freeMb,
    usedMb: totalMb - freeMb,
    detail: `${totalMb}MB 总内存 / ${freeMb}MB 可用（已用 ${totalMb - freeMb}MB）`,
  }
}

/**
 * OOM 防护的自适应堆上限（2026-08-21，替代硬编码 4096）：
 *   - env DSH_MAX_OLD_SPACE 显式覆盖（用户"不限制/加大"诉求的落地口）
 *   - 默认 = 物理内存 50%，下限 2048MB、上限 8192MB（防小内存机器堆上限过大反而触发系统 OOM killer）
 * 纯函数可单测。
 * @param totalMb 物理内存 MB（不传自动取 os.totalmem）
 * @param envOverride DSH_MAX_OLD_SPACE 环境变量值（可选）
 * @returns {string} --max-old-space-size=<MB>
 */
export function computeMaxOldSpace(totalMb, envOverride) {
  const override = Number(envOverride)
  if (Number.isFinite(override) && override > 0) return `--max-old-space-size=${Math.floor(override)}`
  const t = Number.isFinite(totalMb) && totalMb > 0 ? totalMb : Math.floor(totalmem() / 1024 / 1024)
  const mb = Math.max(2048, Math.min(8192, Math.floor(t * 0.5)))
  return `--max-old-space-size=${mb}`
}
