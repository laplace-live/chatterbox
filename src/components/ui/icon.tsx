/**
 * 共享 SVG 图标组件。Jobs 式 #17——替核心 emoji。
 *
 * 为什么 SVG 替 emoji:emoji 在 Windows / Mac / Linux / 各浏览器渲染差异大,
 * 高 DPI 上经常糊或颜色失真;⚙ 这种符号字符在某些字体里直接缺。SVG inline
 * 渲染稳定,继承 `currentColor`,尺寸跟随 font-size,占用零外部资源。
 *
 * 当前覆盖的 8 个核心(对应审计 #17):
 *   - settings   (⚙)  panel header settings button
 *   - info       (ⓘ)  panel header about button
 *   - arrow-left (←)  panel header back button on sub-pages
 *   - book       (📚) 烂梗库 supporting-feature summary
 *   - robot      (🤖) 智驾 + AI 润色 toggle labels
 *   - mic        (🎤) 同传 supporting-feature summary
 *   - warning    (⚠) 浮窗 chrome 警告(WS 断开 banner、风险确认 banner)
 *   - status-ok  (🟢) 在线状态(目前 WS 状态用 CSS 圆点;留接口给未来用)
 *
 * **故意保留的 emoji**:contextual inline emoji(日志行 "🤖 自动跟车 AI 润色"、
 * appendLog 错误的 "⚠️"、dialog body 里的 ⚠️ 警告)是 prose,不是 UI 元素 —
 * 它们走的是日志/弹窗文本流,不是 chrome,所以仍用 emoji。
 *
 * 设计:统一 16x16 viewBox + `currentColor` stroke/fill + 1.6 stroke-width
 * (在 12-14px 渲染时看起来均衡)。`size` prop 默认 1em(继承父字号),传 number
 * 后会被解释为像素。
 */

export type IconName =
  | 'settings'
  | 'info'
  | 'arrow-left'
  | 'book'
  | 'robot'
  | 'mic'
  | 'warning'
  | 'status-ok'
  | 'volume'

interface IconProps {
  name: IconName
  /** 像素或 CSS 长度。默认 '1em'(跟随父字号)。 */
  size?: number | string
  /** Additional className for layout/positioning。 */
  className?: string
  /** title attr for accessibility hover-text; ignored if aria-hidden=true。 */
  title?: string
  /** Use when 图标只是装饰,不传达信息(常见于按钮旁边)。 */
  'aria-hidden'?: boolean
  /** ARIA label for stand-alone icons that DO convey info。 */
  'aria-label'?: string
}

/**
 * Render the SVG path(s) for a given icon name. Centralized so adding a new
 * icon is a single switch arm. All paths assume a 16x16 viewBox; if you add
 * one with a different viewBox you must override `viewBox` in renderSvg().
 */
function renderIconPaths(name: IconName) {
  switch (name) {
    case 'settings':
      // ⚙ — 8-tooth gear with inner ring. Stroke-based so currentColor works
      // for both light + dark mode without dual definitions.
      return (
        <>
          <circle cx='8' cy='8' r='2.4' fill='none' stroke='currentColor' strokeWidth='1.4' />
          <path
            d='M8 1.2v2.2M8 12.6v2.2M14.8 8h-2.2M3.4 8H1.2M12.8 3.2l-1.5 1.5M4.7 11.3l-1.5 1.5M12.8 12.8l-1.5-1.5M4.7 4.7L3.2 3.2'
            fill='none'
            stroke='currentColor'
            strokeWidth='1.4'
            strokeLinecap='round'
          />
        </>
      )
    case 'info':
      // ⓘ — circled i. Filled dot + tall rectangle reads cleaner than
      // serif-i at 14px than a font glyph would.
      return (
        <>
          <circle cx='8' cy='8' r='7' fill='none' stroke='currentColor' strokeWidth='1.4' />
          <circle cx='8' cy='4.5' r='0.9' fill='currentColor' />
          <path d='M8 7v5.2' fill='none' stroke='currentColor' strokeWidth='1.6' strokeLinecap='round' />
        </>
      )
    case 'arrow-left':
      // ← — chevron-left + tail. Used in panel header back button.
      return (
        <path
          d='M9.5 3.2L4.7 8l4.8 4.8M4.7 8h9'
          fill='none'
          stroke='currentColor'
          strokeWidth='1.6'
          strokeLinecap='round'
          strokeLinejoin='round'
        />
      )
    case 'book':
      // 📚 — stacked books. Two stacked rounded rectangles with thin spines.
      return (
        <>
          <path
            d='M2.2 3.6h7.4a2 2 0 0 1 2 2v7.4H4.2a2 2 0 0 1-2-2V3.6z'
            fill='none'
            stroke='currentColor'
            strokeWidth='1.3'
            strokeLinejoin='round'
          />
          <path d='M4.5 6.4h4.8M4.5 9h4.8' fill='none' stroke='currentColor' strokeWidth='1.1' strokeLinecap='round' />
          <path
            d='M11.6 5.2l2.2.6-2 7.4-2.2-.6'
            fill='none'
            stroke='currentColor'
            strokeWidth='1.3'
            strokeLinejoin='round'
          />
        </>
      )
    case 'robot':
      // 🤖 — robot head: rounded rectangle face + two eye dots + small antenna.
      return (
        <>
          <path d='M8 1.5v1.6' fill='none' stroke='currentColor' strokeWidth='1.4' strokeLinecap='round' />
          <circle cx='8' cy='1.6' r='0.7' fill='currentColor' />
          <rect x='2.6' y='4' width='10.8' height='9.6' rx='1.8' fill='none' stroke='currentColor' strokeWidth='1.4' />
          <circle cx='6' cy='8.2' r='1' fill='currentColor' />
          <circle cx='10' cy='8.2' r='1' fill='currentColor' />
          <path d='M6 11.2h4' fill='none' stroke='currentColor' strokeWidth='1.3' strokeLinecap='round' />
        </>
      )
    case 'mic':
      // 🎤 — mic capsule + stand. Pill-shape body + arc + vertical line + base.
      return (
        <>
          <rect x='5.6' y='1.8' width='4.8' height='8' rx='2.4' fill='none' stroke='currentColor' strokeWidth='1.4' />
          <path
            d='M3.4 7.6c0 2.6 2 4.6 4.6 4.6s4.6-2 4.6-4.6'
            fill='none'
            stroke='currentColor'
            strokeWidth='1.4'
            strokeLinecap='round'
          />
          <path
            d='M8 12.4v2.2M5.4 14.6h5.2'
            fill='none'
            stroke='currentColor'
            strokeWidth='1.4'
            strokeLinecap='round'
          />
        </>
      )
    case 'warning':
      // ⚠ — equilateral triangle with exclamation. Used for WS-degraded
      // banner and AI-evasion safety strip. Rounded corners so it doesn't
      // feel adversarial.
      return (
        <>
          <path
            d='M8 2.2L14.4 13.4H1.6L8 2.2z'
            fill='none'
            stroke='currentColor'
            strokeWidth='1.4'
            strokeLinejoin='round'
          />
          <path d='M8 6.6v3.4' fill='none' stroke='currentColor' strokeWidth='1.6' strokeLinecap='round' />
          <circle cx='8' cy='11.6' r='0.9' fill='currentColor' />
        </>
      )
    case 'status-ok':
      // 🟢 — solid filled circle. Currently unused (WS dot is a styled span)
      // but the registry includes it so future "online" affordances are
      // visually consistent.
      return <circle cx='8' cy='8' r='5.6' fill='currentColor' />
    case 'volume':
      // 🔊 — speaker with two arcs of "sound waves". Used by the仅音频
      // header chip; color flip (gray → pink) carries the on/off state,
      // the icon itself stays the same so the affordance reads as "audio
      // is the thing being toggled" rather than "speaker on vs muted".
      return (
        <>
          <path
            d='M2.6 6h2.4l3.4-2.8v9.6L5 10H2.6V6z'
            fill='currentColor'
            stroke='currentColor'
            strokeWidth='1'
            strokeLinejoin='round'
          />
          <path
            d='M10.4 5.6c.9 1 1.4 1.9 1.4 2.4s-.5 1.4-1.4 2.4'
            fill='none'
            stroke='currentColor'
            strokeWidth='1.3'
            strokeLinecap='round'
          />
          <path
            d='M12.4 3.6c1.6 1.4 2.4 2.9 2.4 4.4s-.8 3-2.4 4.4'
            fill='none'
            stroke='currentColor'
            strokeWidth='1.3'
            strokeLinecap='round'
          />
        </>
      )
  }
}

/**
 * Inline SVG icon. Inherits color from `currentColor`. By default `aria-hidden`
 * is true — most callers use icons next to text labels that already convey the
 * meaning, so the icon is decorative. Set `aria-label` (and aria-hidden=false)
 * for stand-alone icon buttons whose meaning isn't already in adjacent text.
 */
export function Icon({
  name,
  size = '1em',
  className,
  title,
  'aria-hidden': ariaHidden = true,
  'aria-label': ariaLabel,
}: IconProps) {
  const dim = typeof size === 'number' ? `${size}px` : size
  // role logic: if aria-label is given, treat as img; otherwise decorative.
  const role = ariaLabel && !ariaHidden ? 'img' : undefined
  return (
    <svg
      width={dim}
      height={dim}
      viewBox='0 0 16 16'
      fill='none'
      xmlns='http://www.w3.org/2000/svg'
      className={className}
      aria-hidden={ariaHidden && !ariaLabel}
      aria-label={!ariaHidden ? ariaLabel : undefined}
      role={role}
      style={{ display: 'inline-block', verticalAlign: '-0.15em', flexShrink: 0 }}
    >
      {title ? <title>{title}</title> : null}
      {renderIconPaths(name)}
    </svg>
  )
}
