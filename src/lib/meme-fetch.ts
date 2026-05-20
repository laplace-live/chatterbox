/**
 * 烂梗库主拉取流程,从 `components/memes-list.tsx` 抽出。
 *
 * 拆出来的目的:让 `fetchAllMemes` 能脱离 Preact 组件单独跑测,补全
 * 后端开/关、`cb.fatal`、专属房间、各源失败兜底等所有分支的覆盖。
 *
 * 真实运行时直接 import 各源客户端;测试通过 `_setMemeFetchDepsForTests` 注入
 * 替身(参考 `gm-fetch.ts` 的 `_setGmXhrForTests` 模式 —— 不用 `mock.module`,
 * 因为 bun 早期加载的模块缓存会让后续 mock 漏到这里来)。
 */

import type { LaplaceInternal } from '@laplace.live/internal'

import type { MemeSource } from './meme-sources'

import { fetchCbMergedMemes as _fetchCbMergedMemes, mirrorToCbBackend as _mirrorToCbBackend } from './cb-backend-client'
import { fetchLaplaceMemes as _fetchLaplaceMemes } from './laplace-client'
import { appendLog } from './log'
import { filterBackendMemesForRoom } from './meme-room-filter'
import { fetchSbhzmMemes as _fetchSbhzmMemes, type LaplaceMemeWithSource } from './sbhzm-client'
import { cbBackendEnabled } from './store-meme'

export type MemeSortBy = NonNullable<LaplaceInternal.HTTPS.Workers.MemeListQuery['sortBy']>

// fatal-fallback 日志节流
// ----------
// 启用 cb 后端但后端整体不可达时,30s polling 会让"降级到本地直拉"反复刷屏。
// 改成 1 分钟最多 1 条。每次成功(fetcher 返回 !fatal)清零。
let lastFatalFallbackLogAt = 0
const FATAL_FALLBACK_LOG_COOLDOWN_MS = 60_000
function maybeLogCbFatalFallback(): void {
  const now = Date.now()
  if (now - lastFatalFallbackLogAt < FATAL_FALLBACK_LOG_COOLDOWN_MS) return
  lastFatalFallbackLogAt = now
  appendLog('⚠️ chatterbox-cloud 后端不可达,降级到本地直拉 LAPLACE/SBHZM')
}
function resetFatalFallbackStreak(): void {
  lastFatalFallbackLogAt = 0
}
/** @internal 测试用。 */
export function _resetFatalFallbackLogForTests(): void {
  lastFatalFallbackLogAt = 0
}

/** 跨多个 _source 的统一排序;按 sortBy 三种 key 各自的语义降序。 */
export function sortMemes(memes: LaplaceInternal.HTTPS.Workers.MemeWithUser[], sortBy: MemeSortBy): void {
  memes.sort((a, b) => {
    if (sortBy === 'lastCopiedAt') {
      if (a.lastCopiedAt === null && b.lastCopiedAt === null) return 0
      if (a.lastCopiedAt === null) return 1
      if (b.lastCopiedAt === null) return -1
      return b.lastCopiedAt.localeCompare(a.lastCopiedAt)
    }
    if (sortBy === 'copyCount') return b.copyCount - a.copyCount
    return b.createdAt.localeCompare(a.createdAt)
  })
}

export interface MemeFetchDeps {
  fetchCbMergedMemes: typeof _fetchCbMergedMemes
  fetchLaplaceMemes: typeof _fetchLaplaceMemes
  fetchSbhzmMemes: typeof _fetchSbhzmMemes
  mirrorToCbBackend: typeof _mirrorToCbBackend
}

let _depsOverride: Partial<MemeFetchDeps> | null = null

/** @internal 测试专用。传 `null` 清空覆盖。 */
export function _setMemeFetchDepsForTests(deps: Partial<MemeFetchDeps> | null): void {
  _depsOverride = deps
}

function deps(): MemeFetchDeps {
  return {
    fetchCbMergedMemes: _depsOverride?.fetchCbMergedMemes ?? _fetchCbMergedMemes,
    fetchLaplaceMemes: _depsOverride?.fetchLaplaceMemes ?? _fetchLaplaceMemes,
    fetchSbhzmMemes: _depsOverride?.fetchSbhzmMemes ?? _fetchSbhzmMemes,
    mirrorToCbBackend: _depsOverride?.mirrorToCbBackend ?? _mirrorToCbBackend,
  }
}

/**
 * 拉取并合并所有可用梗源。
 *
 * 两种模式:
 *
 * 1) **cb 后端启用时(Phase C 主路径)**
 *    先调 cb 的 `/memes` —— 后端自己已经聚合了 LAPLACE+SBHZM+自建。但后端的
 *    LAPLACE 镜像没按 roomId 分桶(详见 meme-room-filter.ts 的注释),会跨房间
 *    串内容,所以客户端始终从 LAPLACE upstream 直拉当前房间;SBHZM 仅在专属
 *    房间且后端没拉到时本地兜底。后端整体不可达(fatal=true)时整体降级到旧逻辑。
 *
 * 2) **cb 后端关闭(旧逻辑)**
 *    并行拉 LAPLACE + 房间专属 SBHZM(若有),互不影响。
 *
 * 返回数组里每条都带 `_source` 字段以便 UI 渲染来源 badge。
 */
export async function fetchAllMemes(
  roomId: number,
  sortBy: MemeSortBy,
  source: MemeSource | null
): Promise<LaplaceMemeWithSource[]> {
  const d = deps()

  if (cbBackendEnabled.value) {
    const cb = await d.fetchCbMergedMemes({ roomId, sortBy, perPage: 500 })
    if (!cb.fatal) {
      // 成功一次就清零节流计数,这样下次抖动会立刻提示用户(而不是等 1 分钟)
      resetFatalFallbackStreak()
      const cbItems = filterBackendMemesForRoom(cb.items, source !== null)
      // 后端能用 —— 走主路径。但后端 LAPLACE 镜像没按 roomId 分桶
      //(详见 meme-room-filter.ts 的注释),进入任意房间都会拿到全局池,
      // 串房间显示主播本人最常逛房间(典型是灰泽满)的梗。所以 LAPLACE
      // 始终从 upstream 直拉当前房间;SBHZM 仅在专属房间且后端没拉到时兜底。
      // mirror 推回后端的逻辑保留 —— 留作未来后端按 roomId 分桶后的过渡数据。
      const fallbacks: Array<Promise<LaplaceMemeWithSource[]>> = []
      fallbacks.push(
        d
          .fetchLaplaceMemes(roomId, sortBy)
          .then(data => {
            const tagged = data.map(m => ({ ...m, _source: 'laplace' as const }))
            void d.mirrorToCbBackend(tagged, 'laplace') // fire-and-forget
            return tagged
          })
          .catch(err => {
            appendLog(`⚠️ LAPLACE 加载失败:${err instanceof Error ? err.message : String(err)}`)
            return []
          })
      )
      if (source && !cb.sources.sbhzm) {
        fallbacks.push(
          d
            .fetchSbhzmMemes(source)
            .then(data => {
              void d.mirrorToCbBackend(data, 'sbhzm') // fire-and-forget
              return data
            })
            .catch(err => {
              appendLog(`⚠️ ${source.name} 兜底加载失败:${err instanceof Error ? err.message : String(err)}`)
              return []
            })
        )
      }
      const fallbackArrs = await Promise.all(fallbacks)
      const merged: LaplaceMemeWithSource[] = ([] as LaplaceMemeWithSource[]).concat(cbItems, ...fallbackArrs)
      sortMemes(merged, sortBy)
      return merged
    }
    // fatal:后端整体挂了,告知一次然后走旧逻辑。mirror 推送也跳过(后端不在)。
    // 节流:30s polling + 持续抖动会让这条 log 反复刷屏,叠加上 cb-backend-client
    // 里的网络错误 log,用户实际只想知道一次"现在没在用 cb"。1 分钟内最多一条。
    maybeLogCbFatalFallback()
  }

  // 旧逻辑(后端关闭或后端整体挂了)
  // 即使后端关闭,只要 cbBackendEnabled.value=false 关闭时 mirror 函数会自动 noop,
  // 这里不需要再判断;开启时会推一份给后端贡献数据。
  const tasks: Array<Promise<LaplaceMemeWithSource[]>> = []
  tasks.push(
    d
      .fetchLaplaceMemes(roomId, sortBy)
      .then(data => {
        const tagged = data.map(m => ({ ...m, _source: 'laplace' as const }))
        void d.mirrorToCbBackend(tagged, 'laplace')
        return tagged
      })
      .catch(err => {
        appendLog(`⚠️ LAPLACE 烂梗加载失败:${err instanceof Error ? err.message : String(err)}`)
        return []
      })
  )
  if (source) {
    tasks.push(
      d
        .fetchSbhzmMemes(source)
        .then(data => {
          void d.mirrorToCbBackend(data, 'sbhzm')
          return data
        })
        .catch(err => {
          appendLog(`⚠️ ${source.name} 加载失败:${err instanceof Error ? err.message : String(err)}`)
          return []
        })
    )
  }
  const results = await Promise.all(tasks)
  const merged: LaplaceMemeWithSource[] = ([] as LaplaceMemeWithSource[]).concat(...results)
  sortMemes(merged, sortBy)
  return merged
}
