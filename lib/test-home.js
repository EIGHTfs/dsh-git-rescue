/**
 * dsh-git-rescue 2.0.0 — 测试环境路径判定（单一真源）
 *
 * v2.0.0 重构时误删（只保留 @Save-clean/@Save-test 救援环境判定），
 * 导致测试实例（DSH_HOME 含 dsh-test-home）崩溃时 guardian 误触发完整 git 回退救援
 * —— 2026-08-21 用户实测「测试环境触发了救援，结果全还原了」，系此缺失所致。
 *
 * 判定规则（沿用 v1.11.0 确立，替代端口范围判断）：
 * DSH_HOME 路径含 `dsh-test-home`（或 `dsh-test-` 前缀目录）即测试环境；
 * 主实例 /vol1/@appshare/DeepSeekHarness/.dsh 不含 → 正式环境。
 * 为什么不用端口：测试实例端口自动分配（3083-3182），残留实例也可能落在范围内，
 * 端口会撞会漂移；DSH_HOME 是实例启动时确定的稳定路径，判断更可靠。
 * 与 isRescueEnv（@Save-clean/@Save-test）互补：测试环境 = 开发折腾区，不自动救援；
 * 救援环境 = 纯净基线，也不自动救援。两者任一命中即禁止自动 git 回退。
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
