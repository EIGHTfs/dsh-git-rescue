/**
 * dsh-git-rescue — 救援积分（rescue scores）——事件流权威版
 *
 * 防刷分设计（用户约定 2026-08-18）：**积分不以可写计分文件为权威**（文件可篡改刷分），
 * 改为从插件自身的【保存恢复记录留档】实时加载计算：
 *   - guardian-events.jsonl：`✅ 救援成功` 行 = guardian 自动救援成功（权威）
 *   - events.jsonl：`rollback` 事件（含 scoreType）= 插件侧回退成功（crash/manual）
 *   - events.jsonl：`crash-detected` 事件 = 崩溃检出（发现问题也算一次"救"）
 * DSH 启动后读取记录实时计算；计分快照文件仅缓存展示，每次启动重新计算覆盖（缓存不可信）。
 *
 * 设备标识：用设备稳定 ID（machine-id，区别于 git 私人备份库名），排行榜按设备汇总。
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic.js'
import { hostname } from 'node:os'

/** 积分快照文件名（结果缓存，非权威；启动时重新计算覆盖） */
export function scoreFileName(deviceId) {
  return `rescue-scores-${String(deviceId).slice(0, 12)}.json`
}

/**
 * 从事件流实时计算积分（权威，无副作用）。
 * @param stateRoot 状态目录（含 events.jsonl / guardian-events.jsonl）
 * @param deviceId 设备 ID
 * @returns {deviceId, source, hostname, total, byType:{crash,guardian,manual}, breakdown:{guardianSuccess, rollbacks, crashes}, history:[...]}
 */
export async function computeScoresFromEvents(stateRoot, deviceId, source = 'machine-id') {
  const out = {
    deviceId: String(deviceId),
    source,
    hostname: hostname(),
    total: 0,
    byType: { crash: 0, guardian: 0, manual: 0 },
    breakdown: { guardianSuccess: 0, rollbacks: 0, crashes: 0 },
    history: [],
  }

  // 1) guardian-events.jsonl：`✅ 救援成功` = guardian 自动救援成功
  try {
    const raw = await fs.readFile(join(stateRoot, 'guardian-events.jsonl'), 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      if (line.includes('救援成功')) {
        out.byType.guardian += 1
        out.breakdown.guardianSuccess += 1
        let ts = null
        try { ts = JSON.parse(line).time } catch { /* 忽略 */ }
        out.history.push({ ts: ts ?? Date.now(), type: 'guardian', detail: line.slice(0, 120) })
      }
    }
  } catch { /* guardian 日志可能不存在（未部署 guardian） */ }

  // 2) events.jsonl：rollback 事件（按 scoreType 分类）+ crash-detected
  try {
    const raw = await fs.readFile(join(stateRoot, 'events.jsonl'), 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let d
      try { d = JSON.parse(line) } catch { continue }
      if (d.type === 'rollback') {
        out.breakdown.rollbacks += 1
        const t = d.scoreType === 'manual' ? 'manual' : 'crash'
        out.byType[t] += 1
        out.history.push({ ts: d.ts ?? Date.now(), type: t, detail: `rollback ${d.repo ?? ''} ${d.from ?? ''}→${d.to ?? ''}` })
      } else if (d.type === 'crash-detected') {
        out.breakdown.crashes += 1
        out.byType.crash += 1
        out.history.push({ ts: d.ts ?? Date.now(), type: 'crash', detail: `crash-detected age=${d.lastHeartbeatAgeMs ?? '?'}ms` })
      }
    }
  } catch { /* events.jsonl 可能不存在 */ }

  out.history.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))
  if (out.history.length > 200) out.history = out.history.slice(-200)
  // 计分权重：guardian/manual 救援成功=1分，crash 检测=0.05分
  const CRASH_WEIGHT = 0.05
  out.total = Math.round((out.byType.crash * CRASH_WEIGHT + out.byType.guardian + out.byType.manual) * 100) / 100
  return out
}

/**
 * 计算并缓存积分快照（权威来自事件流；快照文件仅展示，启动时覆盖）。
 * @returns {{ok:boolean, scores:object, path:string}}
 */
export async function refreshScoreSnapshot(stateRoot, deviceId, source = 'machine-id') {
  const scores = await computeScoresFromEvents(stateRoot, deviceId, source)
  const p = join(stateRoot, scoreFileName(deviceId))
  try {
    await fs.mkdir(stateRoot, { recursive: true })
    await writeFileAtomic(p, JSON.stringify(scores, null, 2))
    return { ok: true, scores, path: p }
  } catch (e) {
    return { ok: false, scores, path: p, error: String(e?.message ?? e) }
  }
}

// 兼容旧 API（recordScore 已废弃——防刷分：不再提供可写计分入口）
export async function recordScore() {
  return { ok: false, added: false, error: 'recordScore 已废弃：积分由事件流实时计算，禁止直接写入（防刷分）' }
}
