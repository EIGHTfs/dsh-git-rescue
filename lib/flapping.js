/**
 * dsh-git-rescue — flapping（抖动/无限重启）检测器
 *
 * 背景：主实例曾出现"45 分钟内换 5 个 PID"的无限重启，但现有机制把每次重启
 * 当作独立事件，无人识别"反复拉起即崩"的 flapping 模式 → 用户感知"无限重启"
 * 系统侧却完全无声。
 *
 * 职责：记录每次重启时间戳，按滑动窗口判定 flapping，并给出升级建议：
 *  - 'watch'   ：窗口内已达 2 次（接近阈值），继续观察
 *  - 'flapping'：窗口内 ≥ maxRestarts 次 → 升级处理
 *  - 'ok'      ：窗口内无异常
 *
 * 升级处理（由调用方执行）：
 *  1. 停止自动拉起循环（防抖）
 *  2. 保留现场（commit 坏状态）
 *  3. 回退到上一个好版本
 *  4. 告警人工（日志/事件流）
 *
 * 纯逻辑、无 I/O，可独立单测。
 */

export const DEFAULT_OPTIONS = {
  windowMs: 10 * 60 * 1000,   // 滑动窗口：10 分钟
  maxRestarts: 3,             // 窗口内 ≥3 次重启 → flapping
  warnAt: 2,                  // 窗口内 ≥2 次 → 提示 watch
}

export function createFlappingDetector(options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const restarts = [] // [{ts, pid}]

  /**
   * 记录一次重启/启动事件，返回当前判定。
   * @param {number} ts 时间戳
   * @param {*} pid 标识（如 recover#xxx）
   * @param {string} [kind] 重启类别：'crash'（崩溃，累计）/ 'update'（更新重启，不计入 flapping）/ 'manual'（手动，不计入 flapping）
   * @returns {Object} { level:'ok'|'watch'|'flapping', count, windowMs, restarts, skippedKind? }
   */
  function record(ts = Date.now(), pid = null, kind = 'crash') {
    const now = ts
    // 清理窗口外的旧记录
    while (restarts.length > 0 && now - restarts[0].ts > opts.windowMs) restarts.shift()
    // 因更新/手动而重启 ≠ 崩溃循环，不计入 flapping（否则 10 分钟多次更新/手动会被误判"无限重启"）
    if (kind === 'update' || kind === 'manual') {
      return { level: 'ok', count: restarts.length, windowMs: opts.windowMs, restarts: [...restarts], skippedKind: kind }
    }
    restarts.push({ ts, pid })

    const count = restarts.length
    if (count >= opts.maxRestarts) {
      return { level: 'flapping', count, windowMs: opts.windowMs, restarts: [...restarts] }
    }
    if (count >= opts.warnAt) {
      return { level: 'watch', count, windowMs: opts.windowMs, restarts: [...restarts] }
    }
    return { level: 'ok', count, windowMs: opts.windowMs, restarts: [...restarts] }
  }

  /** 当前窗口内重启次数（不新增记录）。 */
  function count(ts = Date.now()) {
    const now = ts
    while (restarts.length > 0 && now - restarts[0].ts > opts.windowMs) restarts.shift()
    return restarts.length
  }

  /** 重置（例如回退成功、人工介入后）。 */
  function reset() {
    restarts.length = 0
  }

  return { record, count, reset, get restarts() { return [...restarts] } }
}
