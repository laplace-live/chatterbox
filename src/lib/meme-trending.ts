/**
 * 跨房间热门 meme 提示——烂梗库 UI 用。
 *
 * 行为模型:
 *   - 烂梗库面板打开时后台异步调一次 fetchTodayRadar(50)。
 *   - 把每个簇的 representativeText 用 memeContentKey 归一化做 key,
 *     value 装 { rank, clusterId, heatScore, slopeScore } 写进 trendingMemeKeys signal。
 *   - 烂梗库渲染每条梗时同样用 memeContentKey 归一化它的 content,
 *     在 trendingMemeKeys 里查；命中 → 🔥 徽章。
 *   - 10 分钟 in-memory TTL: 在 TTL 内的二次调用直接返回缓存,不重发请求。
 *   - 雷达挂 / 网络错误 / 空响应 → signal 保持上一次的值(或初始空 Map),
 *     徽章自然不出现,烂梗库其余功能不受影响。
 *
 * 设计取舍:
 *   - 用 representativeText 而不是逐条 queryClusterRank: 一个簇可能聚合了同义但
 *     拼写不同的多条文本,我们这里只匹配代表文本——会有 false negative
 *     (本地烂梗写法跟雷达 representative 不一致就漏标)，但 false positive 是 0
 *     而且只是徽章问题不影响发送决策,可接受。
 *   - 不在 store 里做持久化: 雷达数据是实时分钟级的,缓存进 GM storage 反而过期。
 */

import { effect, signal } from '@preact/signals'

import { memeContentKey } from './meme-content-key'
import { fetchTodayRadar, type RadarClusterSummary } from './radar-client'
import { radarConsultEnabled } from './store-radar'

export interface TrendingMatch {
  /** Position in today's trending list. 1 = hottest. */
  rank: number
  clusterId: number
  heatScore: number
  slopeScore: number
}

/** Map<normalized meme content key, TrendingMatch>. Empty until first refresh lands. */
export const trendingMemeKeys = signal<Map<string, TrendingMatch>>(new Map())

const TTL_MS = 10 * 60 * 1000
const FETCH_LIMIT = 50

let lastFetchAt = 0
let inflight: Promise<void> | null = null

/**
 * Refresh the trending-meme map if it's stale. Concurrent callers share the
 * same in-flight promise; callers within TTL get a no-op resolution. Errors
 * are swallowed (logged inside fetchTodayRadar). Resolves to undefined.
 *
 * Gated by `radarConsultEnabled` (default OFF, opt-in). When toggle is off
 * this short-circuits without touching the network — production callers
 * (`memes-list.tsx`) ALSO check the toggle before calling, but defense in
 * depth here means a stray import in another component doesn't accidentally
 * hit live-meme-radar.aijc-eric.workers.dev.
 *
 * Pass `force = true` to bypass the TTL — used by tests; production callers
 * should leave it `false`. Tests can also flip `radarConsultEnabled.value`
 * directly to exercise the gated branch.
 */
export async function refreshTrendingMemes(force = false): Promise<void> {
  if (!radarConsultEnabled.value) return undefined
  const now = Date.now()
  if (!force && now - lastFetchAt < TTL_MS) return undefined
  if (inflight) return inflight

  inflight = (async () => {
    try {
      const clusters = await fetchTodayRadar(FETCH_LIMIT)
      lastFetchAt = Date.now()
      trendingMemeKeys.value = buildTrendingMap(clusters)
    } finally {
      inflight = null
    }
  })()
  return inflight
}

// 用户关掉 toggle 时,立刻把已加载的 🔥 徽章 map 清空,这样面板里现存的徽章
// 立即消失而不是等下次 refresh 才生效。同时把 lastFetchAt 归零,允许用户再次
// 打开后立刻拉新数据(否则会被 10 分钟 TTL 拦下)。
effect(() => {
  if (!radarConsultEnabled.value) {
    trendingMemeKeys.value = new Map()
    lastFetchAt = 0
  }
})

/**
 * Pure mapper: turns a sorted-by-trending cluster array into the lookup map
 * the UI binds against. Index 0 → rank 1. Exported for tests; the signal
 * update path goes through refreshTrendingMemes.
 */
export function buildTrendingMap(clusters: RadarClusterSummary[]): Map<string, TrendingMatch> {
  const map = new Map<string, TrendingMatch>()
  for (let i = 0; i < clusters.length; i++) {
    const c = clusters[i]
    const key = memeContentKey(c.representativeText)
    if (!key) continue
    // First write wins so an earlier (hotter) cluster keeps its rank if two
    // clusters happen to normalize to the same key after dedup.
    if (!map.has(key)) {
      map.set(key, {
        rank: i + 1,
        clusterId: c.id,
        heatScore: c.heatScore,
        slopeScore: c.slopeScore,
      })
    }
  }
  return map
}

/**
 * Look up a meme's content against the current trending map. Returns the
 * match (with rank) if hot today, otherwise null. Pure — does not trigger
 * a fetch. Cheap (one regex pass + Map.get).
 */
export function lookupTrendingMatch(content: string): TrendingMatch | null {
  const key = memeContentKey(content)
  if (!key) return null
  return trendingMemeKeys.value.get(key) ?? null
}

/**
 * Test-only reset hook. Wipes cached timestamp + signal so each test starts
 * from a clean slate. Production code does not need this — the TTL takes
 * care of itself across the lifetime of a userscript page load.
 */
export function _resetTrendingMemesForTests(): void {
  lastFetchAt = 0
  inflight = null
  trendingMemeKeys.value = new Map()
}
