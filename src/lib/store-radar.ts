/**
 * live-meme-radar 客户端的 GM-persisted 设置 signal。
 *
 * radar 是一个独立的只读"传感器"项目（https://github.com/aijc123/live-meme-radar）：
 * 聚类几十个直播间的弹幕成跨房间 meme。当前 release 把雷达数据用作烂梗库的
 * "🔥 跨房间热门"徽章信号——纯被动展示，不影响发送行为，不暴露给用户的
 * 设置面板。三个 signal 保留只为 1) 兼容老用户已存的 GM storage 值不会被
 * 误读为别的类型；2) 给将来的实验性开关留位置。
 */

import { gmSignal } from './gm-signal'

/**
 * 是否允许烂梗库从 live-meme-radar 拉取"今日跨房间热门"列表来给烂梗库面板
 * 加 🔥 徽章。默认 OFF——Jobs 式审计后改为 opt-in:即便只是 GET 公开 JSON,
 * 也会在 HTTP 层透露"这位用户装了 chatterbox userscript",用户应该能拒绝。
 *
 * 关闭后:
 *   - memes-list 不再调用 refreshTrendingMemes(),网络请求 0
 *   - meme-trending.ts 的 effect 把 trendingMemeKeys 清空,已显示的 🔥 徽章立刻消失
 *
 * 历史:这个 signal 在 2.11.0–2.11.1 期间叫"radar 软门 / boost"开关,
 * 2.11.2 改为只走被动徽章后被从 UI 移除(默认 false 但代码层不读)。
 * Jobs 审计后被重新激活,用作 lookup 路径的 opt-in 闸门。
 */
export const radarConsultEnabled = gmSignal('radarConsultEnabled', false)

/**
 * Future-reserved (not exposed, not called).
 *
 * Was meant to gate `POST /radar/report` (sample upload). The endpoint
 * never landed in production and the UI never shipped a stable toggle.
 * Kept declared for the same forward-compat reason as radarConsultEnabled.
 *
 * Privacy contract (if it ever gets wired up):
 *  - aggregated short-text counts only, never single ws-message + uid pairs
 *  - if uid is ever sent, it is SHA-256(salt + uid)
 */
export const radarReportEnabled = gmSignal('radarReportEnabled', false)

/**
 * 开发用:覆盖 BASE_URL.RADAR_BACKEND。留空走默认。仅放行:
 *  - https://<任意 host>
 *  - http://localhost / 127.0.0.1 / [::1]
 * 与 cb-backend 同一套 normalize 规则。
 */
export const radarBackendUrlOverride = gmSignal('radarBackendUrlOverride', '')
