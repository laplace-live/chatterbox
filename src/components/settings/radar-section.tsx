import { radarConsultEnabled, radarReportEnabled } from '../../lib/store-radar'
import { matchesSearchQuery } from './search'

const SECTION_KEYWORDS = 'radar 雷达 跨房间 meme 上报 report 观察 trending 隐私 热门 徽章 🔥 ai 润色'

/**
 * "live-meme-radar 集成" 设置区块——两个独立开关:
 *
 * 1. **跨房间热门徽章 (radarConsultEnabled, 默认 OFF, READ 路径)**
 *    打开烂梗库面板时拉一次 `/radar/clusters/today` 给本地烂梗库匹配 🔥 徽章。
 *    Jobs 审计前是无开关默认开;改为默认 OFF——即便是只读 GET 也会在 HTTP
 *    层透露"该用户装了 chatterbox userscript",用户应该能拒绝。
 *
 * 2. **观察上报 (radarReportEnabled, 默认 OFF, UPLOAD 路径)**
 *    本房间命中已知 trending 簇的弹幕文本按 60s 窗口聚合后批量上报。
 *    只发 dedupe 后的短文本 + 房间 id + 主播 uid;不发观众 uid、不发逐条
 *    timestamp、失败静默。
 *
 * 两路独立——可以只开徽章(完全无上传)、只开上报(没有徽章但贡献数据)、
 * 两个都开,或者两个都关(零网络往来 radar)。
 */
export function RadarSection({ query = '' }: { query?: string }) {
  if (!matchesSearchQuery(SECTION_KEYWORDS, query)) return null

  return (
    <details className='cb-settings-accordion'>
      <summary>
        <span className='cb-accordion-title'>live-meme-radar(跨房间热门)</span>
      </summary>
      <div className='cb-section cb-stack' style={{ margin: '.5em 0', paddingBottom: '1em', gap: '.75em' }}>
        <div className='cb-heading' style={{ fontWeight: 'bold' }}>
          跨房间热门徽章（READ）
        </div>
        <div className='cb-note' style={{ color: '#666', fontSize: '0.85em' }}>
          打开烂梗库时后台拉一次 today trending list 给本地烂梗库标 🔥 徽章。**默认关闭** ——即便是只读 GET 也会让
          live-meme-radar 后端看到一个匿名请求,你应该能拒绝。 关闭后不发请求、已显示的徽章立刻消失。
        </div>
        <label className='cb-row' style={{ display: 'flex', gap: '.5em', alignItems: 'center' }}>
          <input
            type='checkbox'
            checked={radarConsultEnabled.value}
            onChange={e => {
              radarConsultEnabled.value = e.currentTarget.checked
            }}
          />
          <span>参与梗热度统计 — 帮所有人发现热梗（关闭后你看不到 🔥 徽章）</span>
        </label>

        <div className='cb-heading' style={{ fontWeight: 'bold', marginTop: '.5em' }}>
          观察上报（UPLOAD）
        </div>
        <div className='cb-note' style={{ color: '#666', fontSize: '0.85em' }}>
          帮助 radar 识别跨房间 meme:开启后,本房间命中已知 trending 簇的弹幕文本会按 60s 窗口聚合后批量上报。 只送
          dedupe 后的短文本 + 房间 id + 主播 uid;不送观众 uid、不送逐条时间戳、失败静默。
        </div>
        <label className='cb-row' style={{ display: 'flex', gap: '.5em', alignItems: 'center' }}>
          <input
            type='checkbox'
            checked={radarReportEnabled.value}
            onChange={e => {
              radarReportEnabled.value = e.currentTarget.checked
            }}
          />
          <span>启用观察上报(/radar/report)</span>
        </label>
      </div>
    </details>
  )
}
