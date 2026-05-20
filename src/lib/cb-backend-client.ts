/**
 * chatterbox-cloud 后端客户端。
 *
 * 后端 = 自建第三方烂梗库 + Phase C 时聚合 LAPLACE/SBHZM。仓库内嵌一份实现,
 * 见 `server/`。
 *
 * Phase A 阶段后端只有 GET /health 和 GET /memes(写死 3 条样例),用来验收
 * userscript ↔ 后端这条链路。Phase B/C 才会有 POST /memes、admin、聚合。
 *
 * 走 GM_xmlhttpRequest 而不是 fetch,理由:
 *  1. 本地开发时 userscript 跑在 live.bilibili.com,后端跑在 localhost:8787,
 *     浏览器 CORS 会跨域。GM 渠道不受 CORS 限制。
 *  2. 部署到 *.workers.dev 后会做 CORS,但走 GM 仍然安全 + 与 sbhzm-client.ts
 *     一致,降低维护成本。
 *
 * 因此后端域名也必须列在 `vite.config.ts` 的 `connect` 列表里
 * (vite-plugin-monkey 据此生成 `// @connect`)。
 */

import type { LaplaceMemeWithSource } from './sbhzm-client'

import { BASE_URL } from './const'
import { FetchCache } from './fetch-cache'
import { type GmFetchResponse, gmFetch } from './gm-fetch'
import { appendLog } from './log'
import { memeContentKey } from './meme-content-key'
import { cbBackendEnabled, cbBackendHealthDetail, cbBackendHealthState, cbBackendUrlOverride } from './store-meme'

/** 后端响应的形状(后端会把 _source 标记每一条:'cb'/'laplace'/'sbhzm')。 */
interface CbMemeListResponse {
  items: Array<LaplaceMemeWithSource & { _source?: string }>
  total: number
  page: number
  perPage: number
  sources: { laplace: boolean; sbhzm: boolean; cb: boolean }
}

interface CbHealthResponse {
  ok: boolean
  phase: string
  upstreams: { laplace: boolean; sbhzm: boolean; cb: boolean }
}

/** 客户端拿到的合并结果:扁平 items 数组 + 各源是否成功 + 错误标记(网络层失败)。 */
export interface CbMergedResult {
  items: LaplaceMemeWithSource[]
  /**
   * 后端对各源的可用性自评。客户端据此决定要不要 fallback 直拉:
   *  - laplace=false → 客户端自己 fetch LAPLACE
   *  - sbhzm=false  → 客户端自己 fetch SBHZM(仅当当前房间有专属源)
   *  - cb=false     → 整个后端挂了或被 sourceFilter 屏蔽
   */
  sources: { laplace: boolean; sbhzm: boolean; cb: boolean }
  /** 后端整体不可达(网络/HTTP/JSON 任一层失败)。客户端应整体降级到旧行为。 */
  fatal: boolean
}

export interface FetchCbOptions {
  roomId?: number | null
  sortBy?: 'lastCopiedAt' | 'copyCount' | 'createdAt'
  perPage?: number
  /** 调试用:只要某个源。生产代码留空,后端默认 'all'。 */
  source?: 'cb' | 'laplace' | 'sbhzm'
}

/**
 * 校验并归一化用户填到 settings 里的 backend URL override。
 * 只放行:
 *  - https://<任意 host>
 *  - http://localhost / 127.0.0.1 / [::1](开发期 wrangler dev)
 * 拒绝 javascript:/data:/file: 这类 scheme,以及 http:// 指向任意远端 host
 * (一旦放行,用户提交的 username/roomId 会被直接 POST 到攻击者那里)。
 *
 * 失败返回 '',调用方负责回退到 BASE_URL.CB_BACKEND。和 guard-room-sync.ts 的
 * `normalizeGuardRoomEndpoint()` 是同一套规则,放在这里独立维护是因为 import 反向
 * 依赖会绕一圈。
 */
export function normalizeCbBackendUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return ''
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return ''
  if (parsed.protocol === 'http:') {
    const host = parsed.hostname
    const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
    const isLoopback = bare === 'localhost' || bare === '127.0.0.1' || bare === '::1'
    if (!isLoopback) return ''
  }
  return trimmed
}

/**
 * 解析当前生效的后端 URL。
 *  - 优先 cbBackendUrlOverride GM-signal(开发期常填 `http://localhost:8787`)
 *  - 但 override 必须先过 `normalizeCbBackendUrl` 校验。失败 → 回退到生产 URL
 *    (而不是把 PII 提交到 attacker 控制的域名)。
 *  - 否则用 BASE_URL.CB_BACKEND(部署后的生产 *.workers.dev / 自定义域)
 *
 * 末尾会保证不带斜杠,方便 `${base}/memes` 拼接。
 */
export function getCbBackendBaseUrl(): string {
  const overrideRaw = cbBackendUrlOverride.value
  const overrideOk = normalizeCbBackendUrl(overrideRaw)
  if (overrideOk) return overrideOk
  return BASE_URL.CB_BACKEND.replace(/\/+$/, '')
}

/**
 * 30 秒。和 memes-list 30s polling 间隔对齐:同一窗口内 panel 反复打开 / 多 tab
 * 同房间不会重复打到 cb,polling 触发的下一轮才真正穿透到上游。fatal 失败的
 * "空"结果**不进缓存**(见下方 fetcher 的 throw 分支),否则后端短暂抖动会被
 * 30s 缓存放大成"30s 内永远走旧逻辑"。
 */
const CB_MERGED_TTL_MS = 30_000

const mergedCache = new FetchCache<CbMergedResult>()

// 失败日志节流
// ----------
// 后端持续抖动时(典型:wrangler dev 没起 / 网络不通)30s polling 会让 6 行
// 相同错误每分钟反复爬上日志面板,把用户真正想看的信息淹没。改成:连续失败
// **3 次内**才打第一条(避免偶发抖动),之后每分钟最多 1 条。
let consecutiveCbFailures = 0
let lastCbFailureLogAt = 0
const CB_FAILURE_LOG_COOLDOWN_MS = 60_000
const CB_FAILURE_LOG_THRESHOLD = 3
function maybeLogCbFailure(message: string): void {
  consecutiveCbFailures++
  const now = Date.now()
  if (consecutiveCbFailures >= CB_FAILURE_LOG_THRESHOLD && now - lastCbFailureLogAt >= CB_FAILURE_LOG_COOLDOWN_MS) {
    lastCbFailureLogAt = now
    appendLog(message)
  }
}
function resetCbFailureStreak(): void {
  consecutiveCbFailures = 0
}
/** @internal 测试用。重置失败计数器,让 log 节流回到初始状态。 */
export function _resetCbFailureLogForTests(): void {
  consecutiveCbFailures = 0
  lastCbFailureLogAt = 0
}

/**
 * 从后端拉取已合并的梗列表(Phase C:聚合 cb+LAPLACE+SBHZM)。
 *
 * 后端响应里每条 meme 已经带 `_source` 标(cb/laplace/sbhzm),客户端不需要再
 * 归一。同时返回 `sources` 告诉客户端哪些源后端拉成功了 —— `false` 的源由客户端
 * 自己直连兜底。
 *
 * 失败:`fatal=true` 表示整个后端不可达,调用方应整体走旧路径(直拉 LAPLACE/SBHZM)。
 * 失败结果**不会被缓存**——抛进 fetch-cache 的 reject 分支,下次调用立刻重试。
 */
export async function fetchCbMergedMemes(opts: FetchCbOptions = {}): Promise<CbMergedResult> {
  // Defense-in-depth: 用户关闭 cb 后端时,即使有 caller 绕过外层 guard 误调到这里,
  // 也立刻返回非-fatal 空结果 —— 上层会把它当"cb 没贡献内容"处理,**不会**走
  // "降级到本地直拉"的 fatal log 分支,从而避免在 disabled 状态下打扰用户。
  if (!cbBackendEnabled.value) {
    return { items: [], sources: { laplace: false, sbhzm: false, cb: false }, fatal: false }
  }

  const base = getCbBackendBaseUrl()
  if (!base) {
    return { items: [], sources: { laplace: false, sbhzm: false, cb: false }, fatal: true }
  }

  const params = new URLSearchParams()
  if (opts.roomId != null) params.set('roomId', String(opts.roomId))
  if (opts.sortBy) params.set('sortBy', opts.sortBy)
  if (opts.perPage) params.set('perPage', String(opts.perPage))
  if (opts.source) params.set('source', opts.source)
  const qs = params.toString()
  const url = `${base}/memes${qs ? `?${qs}` : ''}`
  // key 用完整 URL —— base 切换(本地调试 vs 线上)、roomId、sortBy、perPage、source
  // 任一不同都视作不同视图,各自缓存。
  const key = url

  try {
    return await mergedCache.get({
      key,
      ttlMs: CB_MERGED_TTL_MS,
      fetcher: async () => {
        let resp: GmFetchResponse
        try {
          resp = await gmFetch(url, {
            method: 'GET',
            headers: { Accept: 'application/json' },
            timeoutMs: 10_000,
          })
        } catch (err) {
          maybeLogCbFailure(`⚠️ chatterbox-cloud 网络错误:${err instanceof Error ? err.message : String(err)}`)
          throw err
        }
        if (!resp.ok) {
          maybeLogCbFailure(`⚠️ chatterbox-cloud HTTP ${resp.status}`)
          throw new Error(`HTTP ${resp.status}`)
        }
        let body: CbMemeListResponse
        try {
          body = resp.json<CbMemeListResponse>()
        } catch (err) {
          maybeLogCbFailure(`⚠️ chatterbox-cloud JSON 解析失败:${err instanceof Error ? err.message : String(err)}`)
          throw err
        }
        if (!Array.isArray(body.items)) {
          throw new Error('chatterbox-cloud 响应缺少 items')
        }
        // 一次成功 → 失败计数清零,下次失败重新走"连续 3 次才 log"的判断
        resetCbFailureStreak()

        const items = body.items
          .filter(
            (m): m is LaplaceMemeWithSource => m != null && typeof m.content === 'string' && m.content.trim().length > 0
          )
          .map(m => {
            // 后端通常已经 _source 标好;但万一漏标,fallback 到 'cb'。
            const tag = m._source === 'laplace' || m._source === 'sbhzm' || m._source === 'cb' ? m._source : 'cb'
            return { ...m, _source: tag } as LaplaceMemeWithSource
          })

        return {
          items,
          sources: {
            laplace: Boolean(body.sources?.laplace),
            sbhzm: Boolean(body.sources?.sbhzm),
            cb: Boolean(body.sources?.cb),
          },
          fatal: false,
        }
      },
    })
  } catch {
    // fetcher 抛错 —— 维持原 API 契约,以 fatal=true 形式返回,调用方据此整体降级。
    return { items: [], sources: { laplace: false, sbhzm: false, cb: false }, fatal: true }
  }
}

/** 测试用:清空 cb merged memes 缓存。 */
export function _clearCbMergedCacheForTests(): void {
  mergedCache._clearForTests()
}

export interface CbSubmitResult {
  /** 后端给的 meme id(成功时 > 0)。 */
  id: number
  /** 提交后状态:首次贡献 = pending;dedup = 既有行的当前状态(pending/approved/rejected)。 */
  status: 'pending' | 'approved' | 'rejected'
  /** true = 内容 hash 已存在,后端没新插入。前端可据此提示"这条已经在库里了"。 */
  dedup: boolean
}

interface SubmitOptions {
  /** 可选的 tag 名列表;后端只会附上已存在的 tag,不会创建新 tag(防被刷)。 */
  tagNames?: string[]
  /** 当前直播间号(可选,用于审计)。 */
  roomId?: number
  /** 当前用户的 B 站 uid(可选)。 */
  uid?: number
  /** 显示用户名(可选)。 */
  username?: string
}

/**
 * 把一条候选梗推到 chatterbox-cloud。提交后进 pending 队列,管理员审核通过才会
 * 出现在公开列表。
 *
 * 失败抛错(网络/HTTP/JSON 任何一层都抛),调用方必须 try/catch 给用户提示。
 * 成功(包括 dedup 命中)才返回 CbSubmitResult。
 */
export async function submitCbMeme(content: string, opts: SubmitOptions = {}): Promise<CbSubmitResult> {
  const trimmed = content.trim()
  if (!trimmed) throw new Error('提交内容为空')
  const base = getCbBackendBaseUrl()
  if (!base) throw new Error('chatterbox-cloud 后端 URL 未配置')

  const body: Record<string, unknown> = { content: trimmed }
  if (opts.tagNames?.length) body.tagNames = opts.tagNames
  if (typeof opts.roomId === 'number') body.roomId = opts.roomId
  if (typeof opts.uid === 'number') body.uid = opts.uid
  if (opts.username) body.username = opts.username

  const resp = await gmFetch(`${base}/memes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 15_000,
  })
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${resp.text().slice(0, 200)}`)
  }
  const json = resp.json<{ id?: unknown; status?: unknown; dedup?: unknown }>()
  const id = typeof json.id === 'number' ? json.id : Number(json.id)
  if (!Number.isFinite(id) || id <= 0) throw new Error('提交成功但响应里没有 id')
  const status =
    typeof json.status === 'string' && ['pending', 'approved', 'rejected'].includes(json.status)
      ? (json.status as CbSubmitResult['status'])
      : 'pending'
  return { id, status, dedup: Boolean(json.dedup) }
}

// ---------------------------------------------------------------------------
// Phase D — bulk mirror
//
// 当 userscript 直拉 LAPLACE/SBHZM 时(例如后端 sources.X=false 兜底,或者后端
// 整体不可用,或者用户没启用 cb 后端但仍希望让自己 fetch 的内容回填到自建库),
// 把数据异步推到 POST /memes/bulk-mirror。后端 INSERT OR IGNORE 进 memes 表,
// 同 content_hash 自动跳过。
//
// 客户端会话级去重:同一 tab 同 content 不重复推。GM 重启(刷新页面)时清空,
// 后端 dedup 兜底,所以重复推也只是浪费一次网络 round-trip,无业务问题。
// ---------------------------------------------------------------------------
const SESSION_PUSHED_HASHES = new Set<string>()
const MIRROR_BATCH_SIZE = 200

/**
 * 把一批 LAPLACE 或 SBHZM 数据推到自建后端 mirror。fire-and-forget,失败静默
 * (mirror 是次要副作用,不能影响主流程)。
 */
export async function mirrorToCbBackend(items: LaplaceMemeWithSource[], source: 'laplace' | 'sbhzm'): Promise<void> {
  if (!cbBackendEnabled.value) return
  const base = getCbBackendBaseUrl()
  if (!base) return

  // 会话内去重 —— 30s 轮询期间反复推同 100 条没意义。
  const fresh: LaplaceMemeWithSource[] = []
  for (const m of items) {
    if (!m?.content) continue
    const key = memeContentKey(m.content)
    if (!key || SESSION_PUSHED_HASHES.has(key)) continue
    fresh.push(m)
    SESSION_PUSHED_HASHES.add(key)
  }
  if (fresh.length === 0) return

  // 剥离 _source 字段,只送服务端要的形状。
  const payload = fresh.map(({ _source, ...rest }) => rest)

  // 切批,每批 MIRROR_BATCH_SIZE,顺序推(并行容易触发服务端限流)。
  try {
    for (let i = 0; i < payload.length; i += MIRROR_BATCH_SIZE) {
      const batch = payload.slice(i, i + MIRROR_BATCH_SIZE)
      const resp = await gmFetch(`${base}/memes/bulk-mirror`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ source, items: batch }),
        timeoutMs: 15_000,
      })
      if (resp.status === 429) {
        // 限流时静默退出,会话内已记入 hash set,本次 polling 周期不再重试。
        appendLog('⚠️ chatterbox-cloud mirror 被限流,本会话稍后再推')
        break
      }
      // 其他失败也静默,后端 dedup 会让下次重试是幂等的。
    }
  } catch {
    // 网络层失败 —— 完全静默,不打扰用户。
  }
}

/** 测试用:重置会话级 push 缓存,让 mirror 立即重新生效。 */
export function _resetCbMirrorSessionForTests(): void {
  SESSION_PUSHED_HASHES.clear()
}

// ---------------------------------------------------------------------------
// 复制计数 —— debounce 批处理
//
// 旧行为:每次"复制"按钮一按就 POST /memes/:id/copy。N 次复制 → N 次 round-trip。
// 新行为:把 COPY_DEBOUNCE_MS 窗口里的所有调用攒一起,统一发到 POST /memes/copy/batch。
//   - 同 id 多次调用 = 累加(后端按 delta 一次性 += copy_count)
//   - 每个调用方仍然拿到一个 Promise<number | null>,resolve 时是该 id 的最新 copyCount
//   - 失败 / 后端返回里没找到该 id → resolve(null),callers 沿用旧的 null 处理路径
// ---------------------------------------------------------------------------

const COPY_DEBOUNCE_MS = 800

interface PendingCopy {
  id: number
  resolve: (count: number | null) => void
}

let pendingCopies: PendingCopy[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

async function flushCopies(): Promise<void> {
  flushTimer = null
  const batch = pendingCopies
  pendingCopies = []
  if (batch.length === 0) return

  // 同 id 多次复制 → 一条 UPDATE 加 N(后端聚合);客户端只要把 id 列表平铺即可。
  const items = batch.map(p => p.id)
  const base = getCbBackendBaseUrl()
  if (!base) {
    for (const p of batch) p.resolve(null)
    return
  }
  try {
    const resp = await gmFetch(`${base}/memes/copy/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ items }),
      timeoutMs: 5_000,
    })
    if (!resp.ok) {
      for (const p of batch) p.resolve(null)
      return
    }
    const json = resp.json<{ results?: Array<{ id?: unknown; copyCount?: unknown }> }>()
    const byId = new Map<number, number>()
    if (Array.isArray(json.results)) {
      for (const r of json.results) {
        if (typeof r?.id === 'number' && typeof r.copyCount === 'number') {
          byId.set(r.id, r.copyCount)
        }
      }
    }
    for (const p of batch) p.resolve(byId.get(p.id) ?? null)
  } catch {
    for (const p of batch) p.resolve(null)
  }
}

/**
 * 给 cb 源的梗回报一次复制。debounce 窗口内的多次调用合并成一次 batch 请求。
 * 同 id 重复调用累加(后端 += N)。
 *
 * Promise resolve 的值:该 id 的最新 copyCount;若行不存在 / 网络挂 / 后端返回里
 * 没列出该 id,resolve(null)(同旧 reportCbMemeCopy 风格)。
 */
export async function reportCbMemeCopy(memeId: number): Promise<number | null> {
  if (memeId <= 0) return null
  const base = getCbBackendBaseUrl()
  if (!base) return null
  return new Promise<number | null>(resolve => {
    pendingCopies.push({ id: memeId, resolve })
    if (flushTimer === null) {
      flushTimer = setTimeout(() => void flushCopies(), COPY_DEBOUNCE_MS)
    }
  })
}

/**
 * 测试用:立即 flush 当前 pending batch,绕过 debounce 计时器。返回 flush 的 promise
 * 让测试 `await` 完成。
 */
export async function _flushCbCopyBatchForTests(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  await flushCopies()
}

// ---------------------------------------------------------------------------
// 后端 tag 字典(用于候选梗内嵌提交时的自动推荐)
// ---------------------------------------------------------------------------
export interface CbTagInfo {
  id: number
  name: string
  color: string | null
  emoji: string | null
  description: string | null
  count: number
}

const TAGS_CACHE_TTL_MS = 60 * 60 * 1000 // 1 小时
let tagsCache: { ts: number; data: CbTagInfo[] } | null = null

/** 拉后端全量 tag 字典(自带计数)。1 小时内存缓存,失败抛错。 */
export async function fetchCbTags(): Promise<CbTagInfo[]> {
  if (tagsCache && Date.now() - tagsCache.ts < TAGS_CACHE_TTL_MS) return tagsCache.data
  const base = getCbBackendBaseUrl()
  if (!base) throw new Error('chatterbox-cloud 后端 URL 未配置')
  const resp = await gmFetch(`${base}/tags`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    timeoutMs: 10_000,
  })
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
  const json = resp.json<{ items?: CbTagInfo[] }>()
  const tags = Array.isArray(json.items) ? json.items.filter(t => typeof t?.name === 'string' && t.name.length > 0) : []
  tagsCache = { ts: Date.now(), data: tags }
  return tags
}

/** 测试用:清空 tag 缓存,让下次请求强制重新拉。 */
export function _clearCbTagsCacheForTests(): void {
  tagsCache = null
}

/**
 * 用 source.keywordToTag(若有)+ 后端 tag 字典推测当前内容应该套哪些 tag。
 * 返回 tag 名字数组(已经在字典里存在的;不存在的就忽略,避免凭空创建乱 tag)。
 *
 * - 优先用直播间专属 source(灰泽满有完整的 keywordToTag 正则映射)
 * - 没有 source 时退化:用 tag.name 作为字面子串去匹配 content
 */
export async function suggestCbTagNames(
  content: string,
  source: { keywordToTag?: Record<string, string> } | null | undefined
): Promise<string[]> {
  const matched = new Set<string>()
  if (source?.keywordToTag) {
    for (const [pattern, tagName] of Object.entries(source.keywordToTag)) {
      try {
        if (new RegExp(pattern).test(content)) matched.add(tagName)
      } catch {
        // skip malformed regex
      }
    }
  }
  let tags: CbTagInfo[]
  try {
    tags = await fetchCbTags()
  } catch {
    return []
  }
  const allByName = new Map(tags.map(t => [t.name, t]))
  // keywordToTag 命中过滤:只保留字典里真有的 tag。
  const fromKeywords = [...matched].filter(name => allByName.has(name))
  if (fromKeywords.length > 0) return fromKeywords

  // 退化:扫整个 tag 字典,只要 tag 名字面出现在 content 里就推荐。
  // 限 3 个,避免过多。
  const fromSubstring: string[] = []
  for (const t of tags) {
    if (fromSubstring.length >= 3) break
    if (t.name.length >= 2 && content.includes(t.name)) fromSubstring.push(t.name)
  }
  return fromSubstring
}

/** 探测后端是否可达。Phase A 用于在 UI 上显示连通性提示。 */
export async function checkCbBackendHealth(): Promise<CbHealthResponse | null> {
  const base = getCbBackendBaseUrl()
  if (!base) return null
  try {
    const resp = await gmFetch(`${base}/health`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      timeoutMs: 5_000,
    })
    if (!resp.ok) return null
    return resp.json<CbHealthResponse>()
  } catch {
    return null
  }
}

/**
 * 探测后端并把结果写入 `cbBackendHealthState` / `cbBackendHealthDetail`。
 *
 * 设计动机:`checkCbBackendHealth` 只返回值,不更新全局状态——按钮探测和启动期
 * 自动探测两条路径都需要把状态点常驻在 UI 上,所以在这里统一做 signal 写入,
 * 避免两边各写一份逻辑然后渐渐分裂。
 */
export async function probeAndUpdateCbBackendHealth(): Promise<CbHealthResponse | null> {
  cbBackendHealthState.value = 'probing'
  cbBackendHealthDetail.value = '探测中…'
  const result = await checkCbBackendHealth()
  if (!result) {
    cbBackendHealthState.value = 'fail'
    cbBackendHealthDetail.value = `不通: ${getCbBackendBaseUrl() || '(未配置)'}`
    return null
  }
  cbBackendHealthState.value = 'ok'
  cbBackendHealthDetail.value = `phase=${result.phase} cb=${result.upstreams.cb}`
  return result
}
