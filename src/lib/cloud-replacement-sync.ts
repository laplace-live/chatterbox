/**
 * 云端替换规则后台同步。
 *
 * 设计:
 *  - 启动时(app boot 阶段)调一次,刷新 `remoteKeywords` GM signal。
 *  - 之后每 10 分钟自动 sync 一次。
 *  - `replacement.ts` 已有一个 `effect()` 监听 `remoteKeywords`,会自动重建
 *    replacementMap——这里只负责拉数据写 signal,不直接动 map。
 *  - 失败一律静默(日志已在调用方写)。云端不可达不应影响其它发送功能。
 *  - `disableCloudReplacement` GM 键打开时,sync 全程跳过。少数派用户的逃生口,
 *    没有 UI(Apple 风格的 hidden defaults)。
 *
 * 历史背景:Jobs 式审计后把"替换规则"这个心智从设置面板彻底移除——
 * 用户从来不应该思考"替换规则有几层、我在哪一层加规则"。原本同步逻辑挂在
 * `settings/replacement-section.tsx` 的 CloudReplacementSection useEffect 里,
 * 意味着用户不打开设置页,云端规则就永远不刷新。设置 UI 删掉之前,把同步
 * 搬到 boot 路径,与 UI 解耦。
 */

import { GM_getValue } from '$'
import { fetchRemoteKeywords } from './remote-keywords-fetch'
import { remoteKeywords, remoteKeywordsLastSync } from './store-replacement'

const SYNC_INTERVAL_MS = 10 * 60 * 1000
const BOOT_STALE_THRESHOLD_MS = 10 * 60 * 1000

/**
 * 未文档化的"少数派"GM 键。从设置面板里删掉了所有替换规则的可见 UI 之后,
 * 个别 power user 可能想完全关掉云端规则同步(只用本地 GM 持久的旧规则,
 * 或不用规则)。给他们一个 escape hatch,但不在 UI 上暴露。
 * 文档在 README 的「权限说明」里没列(这就是 Apple 'hidden defaults' 的味道)。
 */
function isCloudReplacementDisabled(): boolean {
  return GM_getValue<boolean>('disableCloudReplacement', false) === true
}

let syncTimer: ReturnType<typeof setInterval> | null = null
let started = false

async function syncOnce(): Promise<void> {
  if (isCloudReplacementDisabled()) return
  try {
    const data = await fetchRemoteKeywords()
    remoteKeywords.value = data
    remoteKeywordsLastSync.value = Date.now()
  } catch {
    // 静默吞掉——同步失败应该是 noisy log 之外的事情。replacement 系统会
    // 继续使用上一次成功 sync 的 cached 数据(remoteKeywords 不会被清空)。
  }
}

/**
 * 启动后台云端规则同步。Idempotent:重复调用是 no-op。
 * 由 `components/app.tsx` 在 boot 阶段调一次。
 *
 * 行为:
 *  1. 如果 `remoteKeywordsLastSync` 是空或 > 10 分钟前,立刻 sync 一次。
 *  2. 不论是否立即 sync,都启动 10 分钟 setInterval 持续 sync。
 *  3. `disableCloudReplacement` GM 键打开时,sync 函数本身 short-circuit
 *     ——但 timer 仍然挂着(用户运行时切换 disable 标志能立刻生效或退出)。
 */
export function startCloudReplacementSync(): void {
  if (started) return
  started = true

  const lastSync = remoteKeywordsLastSync.value
  const isStale = lastSync === null || Date.now() - lastSync > BOOT_STALE_THRESHOLD_MS
  if (isStale) {
    void syncOnce()
  }

  if (syncTimer === null) {
    syncTimer = setInterval(() => {
      void syncOnce()
    }, SYNC_INTERVAL_MS)
  }
}

/** Test-only: tear down the timer + reset module state. */
export function _stopCloudReplacementSyncForTests(): void {
  if (syncTimer !== null) {
    clearInterval(syncTimer)
    syncTimer = null
  }
  started = false
}

/** Test-only: trigger one sync without waiting for the interval. */
export async function _syncOnceForTests(): Promise<void> {
  await syncOnce()
}
