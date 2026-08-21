/**
 * dsh-git-rescue — 测试环境路径判定（单一真源）
 *
 * v1.11.0 抽离：原 isTestHomePath 定义在 lib/test-env-entry.js，guardian（独立进程）
 * 与插件主进程都需要判定「DSH_HOME 是否为测试环境」——抽到这里共用，避免两处重复实现漂移。
 *
 * 判定规则（v1.10.0 确立，替代端口范围判断）：
 * DSH_HOME 路径含 `dsh-test-home`（或 `dsh-test-` 前缀目录）即测试环境；
 * 主实例 /vol1/@appshare/DeepSeekHarness/.dsh 不含 → 正式环境。
 * 为什么不用端口：测试实例端口自动分配（3083-3182），残留实例也可能落在范围内，
 * 端口会撞会漂移；DSH_HOME 是实例启动时确定的稳定路径，判断更可靠。
 */

/**
 * 判断 DSH_HOME 路径是否为测试环境。
 * 匹配 `dsh-test-home` / `dsh-test-rc7` / `dsh-test-clean`（含 `-` 变体如 dsh-test-home-clean 纯净环境）。
 * @param {string|null|undefined} dshHome 实例 home 路径
 * @returns {boolean|null} true=测试环境 / false=正式环境 / null=无法判定（空输入）
 */
export function isTestHomePath(dshHome) {
  if (!dshHome) return null
  const norm = String(dshHome).replace(/\\/g, '/')
  return /(^|\/)dsh-test-(home|rc7|clean)([\/-]|$)/.test(norm)
}
