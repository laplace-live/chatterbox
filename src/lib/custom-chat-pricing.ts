export function formatMilliyuanAmount(amount: number | undefined, symbol = '¥'): string {
  if (!amount || !Number.isFinite(amount) || amount <= 0) return ''
  const yuan = amount / 1000
  if (yuan < 1) return `${symbol}${(Math.round(yuan * 10) / 10).toFixed(1)}`
  const rounded = Math.round(yuan * 10) / 10
  return Number.isInteger(rounded) ? `${symbol}${rounded}` : `${symbol}${rounded.toFixed(1)}`
}

export function formatMilliyuanBadgeAmount(amount: number | undefined): string {
  const formatted = formatMilliyuanAmount(amount, '')
  return formatted ? `${formatted}元` : ''
}

/**
 * 礼物 / 舰长 卡片的 raw text 末尾通常带 B 站源数据的数量后缀,例如:
 *  - "送出 嘉年华 × 1"
 *  - "投喂 小花花 x66"
 *  - "开通了舰长 x3"
 *
 * 这个 "× N" 跟 chatterbox 自己的 `.lc-chat-merge-count`(近 9 秒同弹幕折叠次数)
 * 是同一个符号但语义完全不同 ——数量 vs 重复次数。同时出现在一张卡片上会
 * 把读者搞糊涂(Jobs 2026-05-18 反馈)。
 *
 * 数量信息已经在 fields 行(数量 / x3 等)单独展示,这里 strip 掉避免冲突。
 *
 * 仅在末尾 strip:中文 / 英文 × 都接受、前后空白允许、不能误删消息中间的 "x3"
 * (例如"喷火x3被房管警告"这种文本里的 x3 不在末尾,应保留)。
 */
export function stripCardCountSuffix(text: string): string {
  return text.replace(/\s*[×x]\s*\d+\s*$/iu, '')
}
