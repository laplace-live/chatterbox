import { useRef } from 'preact/hooks'

import { cn } from '../lib/cn'
import { activeTab, dialogOpen, hzmPanelOpen } from '../lib/store'
import { AboutTab } from './about-tab'
import { AiCandidateSection } from './ai-candidate-section'
import { AutoBlendControls } from './auto-blend-controls'
import { AutoSendControls } from './auto-send-controls'
import { HzmDrivePanelMount } from './hzm-drive-panel'
import { LogPanel } from './log-panel'
import { MedalStatusPanel } from './medal-status-panel'
import { MemesList } from './memes-list'
import { NormalSendTab } from './normal-send-tab'
import { PanelHeader } from './panel-header'
import { SettingsTab } from './settings-tab'
import { SttTab } from './stt-tab'
import { Icon } from './ui/icon'

/**
 * 面板容器。
 *
 * 设计理念（从用户视角，按 Jobs 式减法）：
 *
 * 这个产品本质上只做一件事——"在 B 站直播间替我说话"。三个核心原语对应三张主卡：
 *   1. 独轮车（循环发送）
 *   2. 自动跟车（跟热门）
 *   3. 手动发送（手动一句，原"普通发送/常规发送"）
 *
 * 其它功能都是"为某个核心原语服务的配件"，应该视觉上**归属**于它们各自服务的核心：
 *   - 烂梗库 = 独轮车的"模板素材库"      → 折在独轮车卡下方
 *   - 智驾   = 自动跟车的"LLM 加强版"     → 折在自动跟车卡下方
 *   - 同传   = 手动发送的"语音输入法"     → 折在手动发送卡下方
 *
 * 历史：原本是 4 Tab（发送/同传/设置/关于）顶部切换；用户审计后认定 Tab 是错误隐喻
 *（产品只有一个主上下文，把配件做成同等地位的 Tab 是把心智成本转嫁给用户）。改成
 *「单页瀑布 + 抽屉式设置/关于」：
 *
 *  - 主页（activeTab='fasong'）= 顶部状态条 + 三张归属式主卡 + 日志。
 *  - 设置（activeTab='settings'）= 满铺抽屉，由 PanelHeader 提供"← 返回"。
 *  - 关于（activeTab='about'）= 同上。
 *
 * 仍复用 `activeTab` 信号以保持现有 set-callers 不变（onboarding、yolo-callout、
 * hzm-drive-panel 内部跳转、danmaku-actions 等）。语义不变：'settings' 即"打开设置
 * 视图"，'about' 即"打开关于视图"。
 *
 * 旧值 'tongchuan' 的持久化 activeTab 在这里强制迁移到 'fasong'——同传不再是独立
 * 视图，归到手动发送下方。
 */

const VALID_TABS = new Set<string>(['fasong', 'settings', 'about'])

export function Configurator() {
  if (!VALID_TABS.has(activeTab.value)) {
    activeTab.value = 'fasong'
  }

  const tab = activeTab.value
  const visible = dialogOpen.value
  // 首次访问 settings/about 时挂载，之后保留在 DOM 中以保住组件内部状态。
  const visited = useRef(new Set([tab]))
  visited.current.add(tab)

  // `cb-view` only on the active view — preact reuses the underlying DOM nodes
  // between renders, so adding the animation class only when this view becomes
  // active is what makes the entrance keyframe re-fire on tab switch (a fresh
  // `animation` property on an existing element re-triggers the animation).
  const panelClass = (active: boolean) => cn('cb-scroll', active ? 'lc-block cb-view' : 'lc-hidden')

  return (
    <section
      id='laplace-chatterbox-dialog'
      aria-label='弹幕助手面板'
      aria-hidden={!visible}
      className={cn(
        'lc-fixed lc-right-2 lc-bottom-[46px] lc-z-[2147483647]',
        'lc-w-[320px] lc-max-w-[calc(100vw_-_16px)]',
        'lc-max-h-[70vh] lc-overflow-y-auto',
        !visible && 'lc-hidden'
      )}
    >
      <PanelHeader />

      <div className={panelClass(tab === 'fasong')}>
        {visited.current.has('fasong') && (
          <>
            {/* 核心 1:独轮车(循环发送)。
             *
             * 之前这里折着烂梗库 supporting feature,在产品上是错误归属 ——
             * 烂梗库实际服务于独轮车 + 自动跟车 + 智驾 三者(独轮车填模板、
             * 跟车匹配 trending、智驾的候选池),折在独轮车下面暗示"只为独轮
             * 车准备"。Jobs 审计后把烂梗库升到下面的顶级 cb-library-section,
             * 这个 cb-core-group 只剩独轮车本体。
             */}
            <section className='cb-core-group' aria-label='独轮车'>
              <AutoSendControls />
            </section>

            {/* 核心 2：自动跟车（被动跟热门）+ 智驾（LLM 加强版）
             *
             * Same pattern as 📚 above: outer wrapper now binds to
             * `hzmPanelOpen` (the same signal the inner panel used) so
             * the HzmDrive component can drop its own redundant <details>
             * summary "智能辅助驾驶（{source.name}）".
             */}
            <section className='cb-core-group' aria-label='自动跟车与智驾'>
              <AutoBlendControls />
              <details
                className='cb-supporting-feature'
                open={hzmPanelOpen.value}
                onToggle={e => {
                  hzmPanelOpen.value = e.currentTarget.open
                }}
              >
                <summary>
                  <span className='cb-supporting-feature-icon' aria-hidden='true'>
                    <Icon name='robot' />
                  </span>
                  智能辅助驾驶 · LLM 自动选梗
                </summary>
                <HzmDrivePanelMount />
              </details>
            </section>

            {/* 核心 3：手动发送（主动一句）+ 两个 supporting features：
             * - 同传：语音输入法变体（替你看：听主播）
             * - AI 候选：AI 生成候选弹幕（替你说：review-only，用户点确认才发）
             *
             * AI 候选原本埋在 SttTab 底部（3 层深），Jobs 审计后升到「同传」
             * 兄弟位 —— 它本质是「替你说」功能，不该挂在 STT 子位置。两者
             * 都是「手动发送」的 supporting，正好平级。详见
             * ai-candidate-section.tsx 注释。
             */}
            <section className='cb-core-group' aria-label='手动发送'>
              <NormalSendTab />
              <details className='cb-supporting-feature'>
                <summary>
                  <span className='cb-supporting-feature-icon' aria-hidden='true'>
                    <Icon name='mic' />
                  </span>
                  语音输入弹幕（同传，Soniox）
                </summary>
                <SttTab />
              </details>
              <details className='cb-supporting-feature'>
                <summary>
                  <span className='cb-supporting-feature-icon' aria-hidden='true'>
                    <Icon name='robot' />
                  </span>
                  AI 陪聊（候选 · 你确认才发）
                </summary>
                <AiCandidateSection />
              </details>
            </section>

            {/* 烂梗库 — 顶级"名词区"。
             *
             * 不同于上面三个"动词卡"(独轮车 / 跟车 / 手动发送)。烂梗库是供
             * 三者共享的素材池(LAPLACE + sbhzm + chatterbox-cloud 聚合,见
             * meme-fetch.ts:fetchAllMemes)。Jobs 审计后从独轮车 supporting
             * 升到顶级,标题就写 feature 而不是动作("从烂梗库挑模板"是错误的
             * 单向归因)。**不**用 details 折叠 —— 顶级名词区默认常驻可见,
             * 否则又退化成 Tier 2 supporting 心智。
             */}
            <section className='cb-library-section' aria-label='烂梗库'>
              <div
                className='cb-heading'
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '.5em',
                  flexWrap: 'wrap',
                }}
              >
                <span className='cb-supporting-feature-icon' aria-hidden='true'>
                  <Icon name='book' />
                </span>
                <span>烂梗库</span>
                <span className='cb-soft' style={{ fontSize: '.85em' }}>
                  LAPLACE + sbhzm + 自建后端 聚合
                </span>
              </div>
              <MemesList />
            </section>

            {/*
             * 「我的状态」section — Jobs 式 #8:重度直播观众会被主播拉黑/禁言,
             * 需要每天瞄一眼自己在哪些房间被禁了。原本是设置项,升级为主面板
             * 自带 section。Self-defense visibility,跟"替你说"三件套并列。
             */}
            <MedalStatusPanel />

            {/*
             * 历史：早期把 Chatfilter 观察日志（开发者调试面板）直接挂在首页。
             * 用户审计后判定：首页只放"开车 / 跟车 / 发弹幕"三件核心事，调试
             * 工具属于设置。现在面板搬到了「设置 → 智能识别同义弹幕」开发者
             * 选项下面，跟控制它的开关同处一节，逻辑闭合。
             */}
          </>
        )}
      </div>

      <div className={panelClass(tab === 'settings')}>{visited.current.has('settings') && <SettingsTab />}</div>

      <div className={panelClass(tab === 'about')}>{visited.current.has('about') && <AboutTab />}</div>

      <div className='lc-px-[10px] lc-pb-[10px]'>
        <LogPanel />
      </div>
    </section>
  )
}
