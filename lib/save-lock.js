/**
 * dsh-git-rescue 2.0.0 — 纯净环境防装插件锁定（save-lock，④）
 *
 * 目的：纯净环境（<版本>@Save-clean）必须保持"初始、无插件"的干净基线，
 * 任何尝试往纯净环境安装/注册插件的行为都会破坏救援基线 → 内置锁定。
 *
 * 机制（三层，从强到弱）：
 *  1. 环境标记：目录下 .dsh-env-lock 文件存在即视为锁定环境（由 createCleanEnv 写入）
 *  2. 启动自检：插件 apply 时检测运行于 Save-clean 环境 → 拒绝注册除自身外的任何插件路由，
 *     并把「禁止插件安装」写入 status 供排查
 *  3. 配置只读：锁定环境下禁写 cordis.patch.yml / package.json 的插件相关段
 *
 * 说明：本插件自身是纯净环境唯一允许的插件（干净基线 + 救生圈，2026-08-20 用户约定）。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { isSaveClean } from './rescue-env.js'

export const LOCK_FILE = '.dsh-env-lock'

/**
 * 判断当前 DSH_HOME 是否为锁定环境（Save-clean 且带锁定标记）。
 * @param {string} dshHome
 * @returns {Promise<{locked: boolean, reason?: string}>}
 */
export async function isLockedEnv(dshHome) {
  if (!dshHome) return { locked: false }
  if (!isSaveClean(dshHome)) return { locked: false }
  try {
    await fs.access(join(dshHome, LOCK_FILE))
    return { locked: true, reason: `${dshHome} 是纯净环境（@Save-clean）且带锁定标记，禁止安装/注册新插件` }
  } catch {
    return { locked: false, reason: 'Save-clean 环境但缺少锁定标记，视为未锁定' }
  }
}

/**
 * 校验插件安装请求是否被允许。
 * @param {string} dshHome
 * @param {object} opts { pluginName }
 * @returns {Promise<{allowed: boolean, error?: string}>}
 */
export async function checkInstallAllowed(dshHome, { pluginName = '' } = {}) {
  const { locked, reason } = await isLockedEnv(dshHome)
  if (!locked) return { allowed: true }
  // 纯净环境唯一例外：救援插件自身（救生圈）
  if (pluginName === 'dsh-git-rescue') return { allowed: true }
  return { allowed: false, error: reason }
}

/**
 * 检查并返回当前环境的锁定状态（供 status API 展示）。
 * @param {string} dshHome
 */
export async function saveLockStatus(dshHome) {
  const { locked, reason } = await isLockedEnv(dshHome)
  return { locked, reason: reason ?? null, allowedPlugin: 'dsh-git-rescue' }
}

/** 写入锁定标记（创建纯净环境时调用）。 */
export async function writeLockFile(dshHome) {
  await fs.writeFile(join(dshHome, LOCK_FILE), `clean-env-lock v1\ncreated: ${new Date().toISOString()}\n`, 'utf8')
}

/** 移除锁定标记（解锁，谨慎使用）。 */
export async function removeLockFile(dshHome) {
  await fs.rm(join(dshHome, LOCK_FILE), { force: true })
}
