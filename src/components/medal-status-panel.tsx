import { useComputed, useSignal } from '@preact/signals'
import { useEffect } from 'preact/hooks'

import { getDedeUid } from '../lib/api'
import {
  formatMedalCheckSummaryLine,
  getRestrictedRooms,
  medalCheckResultsByUid,
  medalCheckStatusByUid,
} from '../lib/medal-check-state'
import { activeTab, medalStatusPanelOpen } from '../lib/store'

/**
 * 主面板「我的状态」section ——粉丝牌禁言巡检的"被限制房间"清单。
 *
 * 设计意图 (Jobs 式 #8 + 2026-05-18 简化): 重度直播观众每天会被主播拉黑/禁言/
 * 风控,这是 self-defense 信息,不是设置项。这个 section 只回答**一个**问题:
 * **"我现在在哪些房间被限制(禁言/拉黑)?"** 不显示"未知"、不显示"主播注销"、
 * 不显示"正常",也不做摘要计数 ——这些都是设置页详细巡检报告的事。
 *
 * 主面板上把"我的状态"做窄做硬:**有限制 → 列出全部受限主播;无限制 → 一句话
 * 报平安**。用户瞄一眼就懂,不再需要展开/折叠/三档计数那种心智。
 *
 * 职责分工:
 *  - 本组件:**只读受限房间 + 跳设置**。
 *  - `settings/medal-check-section.tsx`(现有):完整 UI,负责发起巡检、配置
 *    Guard Room 同步、显示完整列表 + filter + 复制/下载报告。
 *
 * 两个消费者读同一份 `medal-check-state.ts` 里的 GM 持久 signal,无重复存储。
 */
export function MedalStatusPanel() {
  // 跟踪 cookie 的 DedeUserID — 用户切账号(另开 tab 登录别的号)后,主面板
  // 立刻显示新账号的缓存。pattern 同 settings/medal-check-section 里的
  // `currentUid` (5 秒轮询 + visibility 唤醒)。
  const currentUid = useSignal<string | null>(getDedeUid() ?? null)
  useEffect(() => {
    const tick = () => {
      const next = getDedeUid() ?? null
      if (currentUid.value !== next) currentUid.value = next
    }
    tick()
    const id = setInterval(tick, 5000)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  const results = useComputed(() => {
    const uid = currentUid.value
    if (!uid) return []
    return medalCheckResultsByUid.value[uid] ?? []
  })

  const statusLine = useComputed(() => {
    const uid = currentUid.value
    if (!uid) return ''
    return medalCheckStatusByUid.value[uid] ?? ''
  })

  // 只关心 restricted ——主面板回答的"我在哪被禁言"就只看这一个状态。
  // unknown / deactivated / ok 都不在此处呈现,留给设置页详细巡检报告。
  // 排序 / 过滤逻辑抽到 lib/medal-check-state.ts 便于单测。
  const restrictedRooms = useComputed(() => getRestrictedRooms(results.value))

  // Summary 文本:窄、硬、只回答一个问题——"被限制的主播数量"。
  //  - 未登录 / 尚未巡检:提示先去做巡检
  //  - 有限制:`被 N 个主播限制`
  //  - 无限制:`✓ 没有主播限制你`
  const summaryText = useComputed(() => {
    if (!currentUid.value) return '请先登录 Bilibili'
    const list = results.value
    if (list.length === 0) return '尚未巡检'
    const n = restrictedRooms.value.length
    if (n === 0) return '✓ 没有主播限制你'
    return `被 ${n} 个主播限制`
  })

  // Summary 颜色:有限制 → 警告橙;其它(未登录/未巡检/全正常)→ 中性。
  // 不再为"未知/注销"亮警告色 —— 这里只关心"主播是否屏蔽你",注销/暂时拉
  // 不到状态都不是这个面板要管的事。
  const summaryColor = useComputed(() => {
    if (!currentUid.value) return '#888'
    const list = results.value
    if (list.length === 0) return '#888'
    if (restrictedRooms.value.length > 0) return 'var(--cb-warning-text)'
    return 'var(--cb-success-text)'
  })

  // 上次巡检时间 ——从 results 里取最新 checkedAt,渲染成 human-readable
  // "5 分钟前 / 2 小时前 / 昨天 / 3 天前 巡检了 N 个房间"(Jobs P1-9)。
  // 渲染逻辑抽到 lib/medal-check-state.formatMedalCheckSummaryLine 便于单测。
  const checkSummaryLine = useComputed(() => {
    const list = results.value
    if (list.length === 0) return ''
    const latest = list.reduce((max, r) => (r.checkedAt > max ? r.checkedAt : max), 0)
    return formatMedalCheckSummaryLine(latest, list.length, Date.now())
  })

  // 跳设置:复用 `activeTab` signal(`onboarding.tsx` 等都这么干),并把搜索
  // 框预填上"粉丝牌"让那个 section 直接展开 + 高亮。settings-tab.tsx 自己会
  // 处理 search query。
  const openSettingsToMedalCheck = () => {
    activeTab.value = 'settings'
    // 设置页的 search 是 settings-tab 自己 useSignal 的本地状态,这里没法直接
    // 写。用户进去后看到的就是默认视图——粉丝牌巡检在"高级"组里,默认折叠。
    // 但点击 "▸ 显示高级设置" 后就能看到。后续 #10 砍设置项时可以考虑把巡检
    // 提到"常用"区,这里就不用专门处理跳转高亮了。
  }

  return (
    <details
      className='cb-core-group'
      open={medalStatusPanelOpen.value}
      onToggle={e => {
        medalStatusPanelOpen.value = e.currentTarget.open
      }}
      style={{ marginTop: '8px' }}
    >
      <summary
        style={{
          cursor: 'pointer',
          userSelect: 'none',
          fontWeight: 'bold',
          padding: '6px 10px',
          display: 'flex',
          // `center` 而非 `baseline`：右侧浏览器默认的 `▸` chevron 是图形元素，
          // 按几何中线放，跟 baseline 对齐的文本会差一截。把文本块也居中，
          // 整行就在一条横线上了。
          alignItems: 'center',
          gap: '.4em',
          flexWrap: 'wrap',
        }}
      >
        <span>我的状态</span>
        <span className='cb-soft' style={{ fontWeight: 'normal', fontSize: '0.85em', color: summaryColor.value }}>
          · {summaryText.value}
        </span>
      </summary>
      <div className='cb-body cb-stack' style={{ padding: '6px 10px 10px', gap: '6px' }}>
        {!currentUid.value && (
          <div className='cb-note' style={{ color: '#666', fontSize: '0.85em' }}>
            登录 Bilibili 后才能巡检自己的粉丝牌房间状态。
          </div>
        )}

        {currentUid.value && results.value.length === 0 && (
          <div className='cb-note' style={{ color: '#666', fontSize: '0.85em' }}>
            还没巡检过。
            {statusLine.value ? `上次状态: ${statusLine.value}` : '点下面的按钮在设置页发起一次巡检。'}
          </div>
        )}

        {currentUid.value && results.value.length > 0 && (
          <>
            {restrictedRooms.value.length === 0 ? (
              <div className='cb-note' style={{ color: 'var(--cb-success-text)', fontSize: '0.85em' }}>
                ✓ 上次巡检没有主播限制你（共 {results.value.length} 个房间）。
              </div>
            ) : (
              // 被限制的房间 ——主播名一行一个,全部列出,不再 slice。
              // 不显示粉丝牌名 / "发现限制" 状态文字 ——summary 已经说了"被 N 个
              // 主播限制",这里直接列名字即可。
              // 主播名一行一个,不加 bullet ——行已经垂直堆叠,bullet 是噪音
              // (Jobs P1-7)。每行轻微缩进 + 警告色让"被限制"语义自洽。
              <div className='cb-stack' style={{ gap: '2px', maxHeight: '40vh', overflowY: 'auto' }}>
                {restrictedRooms.value.map(result => (
                  <div
                    key={result.room.roomId}
                    style={{
                      fontSize: '0.9em',
                      color: 'var(--cb-warning-text)',
                      wordBreak: 'break-all',
                      lineHeight: '1.5',
                      paddingLeft: '2px',
                    }}
                  >
                    {result.room.anchorName}
                  </div>
                ))}
              </div>
            )}
            {checkSummaryLine.value && (
              <div className='cb-note' style={{ color: '#888', fontSize: '0.8em' }}>
                {checkSummaryLine.value}
              </div>
            )}
          </>
        )}

        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          <button type='button' className='cb-btn' onClick={openSettingsToMedalCheck} style={{ fontSize: '0.85em' }}>
            {results.value.length > 0 ? '在设置里看完整列表 / 重新巡检 →' : '去设置发起巡检 →'}
          </button>
        </div>
      </div>
    </details>
  )
}
