import { effect, signal } from '@preact/signals'

import type { LaplaceMemeWithSource } from './sbhzm-client'

import { gmSignal } from './gm-signal'
import { clearUserMemeSources, registerMemeSource } from './meme-sources'

// Meme Contributor (社区烂梗贡献者)
export const enableMemeContribution = gmSignal('enableMemeContribution', false)

// roomId(String) → 候选梗列表
export const memeContributorCandidatesByRoom = gmSignal<Record<string, string[]>>('memeContributorCandidatesByRoom', {})

// roomId(String) → 已见(被忽略或已贡献)梗列表
export const memeContributorSeenTextsByRoom = gmSignal<Record<string, string[]>>('memeContributorSeenTextsByRoom', {})

// chatterbox-cloud 自建后端
// 默认 false——未启用前 userscript 的行为完全等同于旧版,不影响现有用户。
export const cbBackendEnabled = gmSignal('cbBackendEnabled', false)

// 开发用:覆盖 BASE_URL.CB_BACKEND。Phase A 必须填 'http://localhost:8787' 才能验收。
// 留空 = 用 BASE_URL.CB_BACKEND(指向待部署的生产 *.workers.dev)。
export const cbBackendUrlOverride = gmSignal('cbBackendUrlOverride', '')

/**
 * 后端连通性的常驻状态（运行时，不持久化）。
 *  - 'idle'     启用开关关闭，未探测
 *  - 'probing'  正在探测
 *  - 'ok'       最近一次探测成功
 *  - 'fail'     最近一次探测失败（5xx / 网络错 / JSON 错）
 *
 * 由 `app-lifecycle.ts` 在启用开关打开（或 URL 改变）时自动 ping 一次写入；
 * 设置区块的「测试连通性」按钮也写入这个 signal，避免按钮状态和常驻状态分裂。
 */
export type CbBackendHealthState = 'idle' | 'probing' | 'ok' | 'fail'
export const cbBackendHealthState = signal<CbBackendHealthState>('idle')
export const cbBackendHealthDetail = signal<string>('')

/**
 * 当前直播间的合并梗列表（运行时共享 signal）。
 *
 * 由 `MemesList` 组件每次成功 loadMemes 时写入；其它需要"按当前梗集做事"
 * 的兄弟组件（如智能辅助驾驶）通过订阅这个 signal 拿到最新数据，避免再发起
 * 重复的网络请求。MemesList 默认 30s 轮询保证数据新鲜。
 */
export const currentMemesList = signal<LaplaceMemeWithSource[]>([])

/**
 * `currentMemesList` 对应的 roomId —— 用来识别"列表是哪个房间的"。
 *
 * 为什么需要:B 站 live 支持在同一 tab 内 SPA 切房间(`ensureRoomId()` 注释 line 161-162
 * 有说明)。切房间到新房间 `loadMemes()` 完成是个 1–10s 的异步窗口,期间 `currentMemesList`
 * 里仍然是**前一个房间**的梗。任何按这个 list 做决策的兄弟组件(智能辅助驾驶的
 * 挂载 gate 是典型受害者:用旧梗 count ≥10 通过 gate,新房间数据空了又显示
 * "有 N 条梗,开车")必须先校验 roomId 匹配,否则就会跨房间使用陈旧素材。
 *
 * 写入方:`MemesList.loadMemes()` —— 永远和 `currentMemesList` 一起更新(同步 tick,
 * 利用 signal 同步语义保持原子)。
 *
 * 读取方:智驾 `decideHzmMount` 的 `memesRoomId` 参数(见 hzm-drive-panel.tsx)。
 *
 * 初始 `null` = 还从来没成功 load 过任何房间(MemesList 还没挂载完 / 第一次 load 还没回)。
 */
export const currentMemesListRoomId = signal<number | null>(null)

// ---------------------------------------------------------------------------
// 用户自配梗源(GM-persisted)
//
// 用户可以在 Tampermonkey 的 storage 编辑器里直接改 GM key `userMemeSources`,
// 写一个 MemeSource 数组 —— 每条会在加载 / 改动时被注册到 meme-sources.ts 的
// 注册表里;格式不对的条静默丢弃(由 registerMemeSource 内部 validate)。
//
// 验证策略:gmSignal 的 validate 只做 shape 粗筛(必须是数组),细粒度校验在
// `registerMemeSource` 里逐条做。这避免一条坏数据让整个数组被回退到默认值。
// ---------------------------------------------------------------------------
function isUnknownArray(val: unknown): val is unknown[] {
  return Array.isArray(val)
}

const userMemeSources = gmSignal<unknown[]>('userMemeSources', [], { validate: isUnknownArray })

// 把 signal → registry 的同步绑成一个 effect:首次 read 时立刻 sync,后续每次
// 用户改写 signal(从 settings UI 或 storage 编辑器)都自动重放。
effect(() => {
  const list = userMemeSources.value
  clearUserMemeSources()
  if (!Array.isArray(list)) return
  for (const item of list) {
    // registerMemeSource 内部会 validate;非法条目静默丢。
    registerMemeSource(item)
  }
})
