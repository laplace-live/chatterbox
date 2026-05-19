import { sanitizeCustomChatCss } from './custom-chat-css-sanitize'

const ROOT_ID = 'laplace-custom-chat'

export const CUSTOM_CHAT_STYLE = `
#${ROOT_ID}, #${ROOT_ID} * {
  box-sizing: border-box;
  font-family: var(--lc-chat-font, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif);
  letter-spacing: 0;
}
#${ROOT_ID} {
  --lc-chat-bg: #f5f5f7;
  --lc-chat-panel: rgba(255, 255, 255, .84);
  --lc-chat-border: rgba(60, 60, 67, .12);
  --lc-chat-text: #111;
  --lc-chat-muted: #6e6e73;
  --lc-chat-name: #007aff;
  --lc-chat-bubble: #ffffff;
  --lc-chat-bubble-text: #111;
  --lc-chat-own: #007aff;
  --lc-chat-own-text: #fff;
  --lc-chat-chip: rgba(118, 118, 128, .14);
  --lc-chat-chip-text: #1d1d1f;
  --lc-chat-accent: #34c759;
  --lc-chat-shadow: rgba(0, 0, 0, .10);
  /* Bubble shadow: inset top-edge highlight (white in light themes) + faint
     drop + soft outer. The inset is what makes bubbles read as "raised
     cards" rather than colored rectangles — same iOS 18 trick that makes
     Messages, Wallet, and Notes feel three-dimensional even at 12-13px text. */
  --lc-chat-bubble-shadow: 0 1px 0 rgba(255, 255, 255, .9) inset, 0 1px 2px rgba(0, 0, 0, .04), 0 8px 20px rgba(0, 0, 0, .08);
  --lc-chat-lite: rgba(118, 118, 128, .12);
  --lc-chat-lite-text: #5f6368;
  --lc-chat-medal-bg: #fff0b8;
  --lc-chat-medal-text: #5c4210;
  --lc-chat-guard-bg: #dceaff;
  --lc-chat-guard-text: #184a8b;
  --lc-chat-admin-bg: #d7ecff;
  --lc-chat-admin-text: #0057a8;
  --lc-chat-rank-bg: #ffe6a8;
  --lc-chat-rank-text: #6a4300;
  --lc-chat-ul-bg: #e8e5ff;
  --lc-chat-ul-text: #473a8d;
  --lc-chat-honor-bg: #e8f8ef;
  --lc-chat-honor-text: #19643a;
  --lc-chat-price-bg: #ffe2cf;
  --lc-chat-price-text: #7f3516;
  /* SC outer glow — exposed as a variable so presets can re-tint the "hero
     card" halo to match their SC bubble color (e.g. milk-green's mint glow,
     midnight-indigo's electric blue) without re-stating the whole rule.
     The baseline value is the iOS-orange→hot-red used by the default SC
     gradient. */
  --lc-superchat-glow:
    0 1px 0 rgba(255, 255, 255, .25) inset,
    0 0 0 1px rgba(255, 122, 89, .3),
    0 12px 32px rgba(255, 69, 58, .35);
  height: 100%;
  width: 100%;
  min-width: 0;
  min-height: 340px;
  flex: 1 1 auto;
  display: grid;
  grid-template-rows: auto auto auto minmax(0, 1fr) auto;
  color: var(--lc-chat-text);
  background: var(--lc-chat-bg);
  border-left: 1px solid var(--lc-chat-border);
  overflow: hidden;
  contain: layout style;
  transition:
    color .18s ease,
    background-color .18s ease,
    border-color .18s ease;
}
html.lc-custom-chat-mounted #${ROOT_ID} {
  display: grid !important;
  /* 6 rows: toolbar / pin strip (collapses to 0 when empty) / menu /
     debug / list / composer. The pin strip is inserted between toolbar
     and menu by custom-chat-dom.ts; when there are no active SCs it
     carries .lc-chat-sc-pinstrip-empty which sets display:none, removing
     it from the grid entirely so empty chats pay no layout cost. */
  grid-template-rows: auto auto auto auto minmax(0, 1fr) auto;
}
html.lc-custom-chat-root-outside-history #${ROOT_ID} {
  flex: 1 1 auto;
  min-height: 0;
}
#${ROOT_ID}[data-theme="laplace"],
#${ROOT_ID}[data-theme="compact"] {
  --lc-chat-bg: #050608;
  --lc-chat-panel: rgba(22, 24, 29, .86);
  --lc-chat-border: rgba(255, 255, 255, .075);
  --lc-chat-text: #f5f5f7;
  --lc-chat-muted: #98989f;
  --lc-chat-name: #64d2ff;
  --lc-chat-bubble: #1c1c1e;
  --lc-chat-bubble-text: #f5f5f7;
  --lc-chat-own: #0a84ff;
  --lc-chat-own-text: #fff;
  --lc-chat-chip: rgba(255, 255, 255, .1);
  --lc-chat-chip-text: #e6edf7;
  --lc-chat-accent: #30d158;
  --lc-chat-shadow: rgba(0, 0, 0, .34);
  /* Dark variant: inset highlight is much weaker (.06 alpha white) — just
     enough to suggest the bubble's top edge catches light, without it looking
     like a fake glow. Outer drop is deeper to compensate for the near-black
     background that swallows soft shadows. */
  --lc-chat-bubble-shadow: 0 1px 0 rgba(255, 255, 255, .06) inset, 0 1px 2px rgba(0, 0, 0, .35), 0 8px 20px rgba(0, 0, 0, .4);
  --lc-chat-lite: rgba(255, 255, 255, .08);
  --lc-chat-lite-text: #b8bac4;
  --lc-chat-medal-bg: rgba(255, 214, 10, .18);
  --lc-chat-medal-text: #ffe8a3;
  --lc-chat-guard-bg: rgba(100, 210, 255, .18);
  --lc-chat-guard-text: #b8e6ff;
  --lc-chat-admin-bg: rgba(10, 132, 255, .2);
  --lc-chat-admin-text: #c4e2ff;
  --lc-chat-rank-bg: rgba(255, 204, 0, .2);
  --lc-chat-rank-text: #ffe08a;
  --lc-chat-ul-bg: rgba(191, 90, 242, .2);
  --lc-chat-ul-text: #e7c6ff;
  --lc-chat-honor-bg: rgba(48, 209, 88, .18);
  --lc-chat-honor-text: #b9f6c8;
  --lc-chat-price-bg: rgba(255, 159, 10, .2);
  --lc-chat-price-text: #ffd49a;
}
#${ROOT_ID}[data-theme="light"] {
  color: var(--lc-chat-text);
}
#${ROOT_ID}[data-theme="compact"] .lc-chat-avatar {
  display: none;
}
#${ROOT_ID}[data-theme="compact"] .lc-chat-message {
  grid-template-columns: minmax(0, 1fr);
  padding: 4px 6px;
  gap: 3px 5px;
}
#${ROOT_ID}[data-theme="compact"] .lc-chat-body {
  grid-column: 1 / 2;
}
#${ROOT_ID}[data-theme="compact"] .lc-chat-bubble {
  font-size: 12px;
}
/* ─────────────── SC pin strip ───────────────
   Horizontal carousel of active Superchats. See custom-chat-sc-pinstrip.ts
   for behavior; this block is style-only. The strip uses the panel's own
   --lc-chat-panel translucent background + the SC accent glow var, so it
   automatically retints when the user switches preset (奶绿 / 午夜深蓝). */
#${ROOT_ID} .lc-chat-sc-pinstrip {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  min-height: 64px;
  /* 下方 12px padding + border 给下一条消息一个明确的"分界" ——之前 4px 太挤,
     pin strip 的 ¥500 金额 chip 会跟下一条消息用户名重叠(Jobs P0-1)。 */
  padding: 8px 12px 12px;
  margin-bottom: 8px;
  background: color-mix(in srgb, var(--lc-chat-panel) 88%, transparent);
  border-bottom: 1px solid var(--lc-chat-border);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  overflow: hidden;
  /* Slide in from the top when an SC first arrives — same iOS Smooth-Spring
     curve as the message entrance animation, so the chat feels coherent. */
  animation: lc-sc-pinstrip-in .35s cubic-bezier(.34, 1.56, .64, 1);
}
#${ROOT_ID} .lc-chat-sc-pinstrip.lc-chat-sc-pinstrip-empty {
  /* Zero layout cost when no SC is active. */
  display: none;
}
@keyframes lc-sc-pinstrip-in {
  0%   { opacity: 0; transform: translateY(-12px); max-height: 0; }
  100% { opacity: 1; transform: translateY(0);     max-height: 80px; }
}
@media (prefers-reduced-motion: reduce) {
  #${ROOT_ID} .lc-chat-sc-pinstrip { animation: none; }
}

#${ROOT_ID} .lc-chat-sc-card {
  display: grid;
  grid-template-columns: auto 24px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
#${ROOT_ID} .lc-chat-sc-card-stuck::before {
  /* Subtle 📌 indicator on the left edge when user has long-pressed to stick. */
  content: '📌';
  position: absolute;
  top: 4px;
  left: 4px;
  font-size: 10px;
  opacity: .8;
}

#${ROOT_ID} .lc-chat-sc-amount {
  flex: 0 0 auto;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--lc-superchat-bg, linear-gradient(135deg, #ff9f0a, #ff453a));
  color: #fff;
  font-size: 12px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  /* Drop a small piece of the SC's hero glow on the badge so the badge
     itself reads as "this is a paid event", not just "a price label". */
  box-shadow: var(--lc-superchat-glow);
}

#${ROOT_ID} .lc-chat-sc-avatar {
  position: relative;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--lc-chat-chip);
  flex: 0 0 auto;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, .4);
}
#${ROOT_ID} .lc-chat-sc-avatar-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

#${ROOT_ID} .lc-chat-sc-body {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
  overflow: hidden;
}
#${ROOT_ID} .lc-chat-sc-name {
  flex: 0 0 auto;
  max-width: 8em;
  color: var(--lc-chat-name);
  font-size: 12px;
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#${ROOT_ID} .lc-chat-sc-text {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--lc-chat-text);
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#${ROOT_ID} .lc-chat-sc-time {
  flex: 0 0 auto;
  color: var(--lc-chat-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  padding-left: 4px;
}

/* Navigation arrows — desktop-only affordance for prev/next. Touch users
   swipe; keyboard users use arrow keys. Buttons appear on strip hover so
   they don't compete with SC content when the user isn't seeking. */
#${ROOT_ID} .lc-chat-sc-nav {
  position: absolute;
  top: 50%;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--lc-chat-panel) 70%, transparent);
  color: var(--lc-chat-text);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
  transform: translateY(-50%);
  transition: opacity .14s ease;
}
#${ROOT_ID} .lc-chat-sc-nav-prev { left: 4px; }
#${ROOT_ID} .lc-chat-sc-nav-next { right: 4px; }
#${ROOT_ID} .lc-chat-sc-pinstrip:hover .lc-chat-sc-nav,
#${ROOT_ID} .lc-chat-sc-pinstrip:focus-within .lc-chat-sc-nav {
  opacity: .85;
}
#${ROOT_ID} .lc-chat-sc-nav:hover {
  opacity: 1;
  background: var(--lc-chat-chip);
}

/* Dots indicator — one tab per active SC, centered under the card.
   Overflow counter shows when > 5 SCs are queued. */
#${ROOT_ID} .lc-chat-sc-dots {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 6px;
  min-height: 8px;
}
#${ROOT_ID} .lc-chat-sc-dot {
  width: 5px;
  height: 5px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: color-mix(in srgb, var(--lc-chat-muted) 50%, transparent);
  cursor: pointer;
  transition: background .14s ease, transform .14s ease;
}
#${ROOT_ID} .lc-chat-sc-dot:hover {
  transform: scale(1.4);
}
#${ROOT_ID} .lc-chat-sc-dot-active {
  background: var(--lc-chat-name);
  transform: scale(1.6);
}
#${ROOT_ID} .lc-chat-sc-dot-overflow {
  margin-left: 4px;
  color: var(--lc-chat-muted);
  font-size: 10px;
  font-weight: 600;
}

/* Progress bar — 1px hairline at the very bottom of the strip, scales
   from 1.0 → 0 as the current SC's lifetime runs down. iOS Battery /
   Now-Playing style. */
#${ROOT_ID} .lc-chat-sc-progress {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  background: var(--lc-chat-name);
  transform-origin: left;
  transform: scaleX(0);
  transition: transform .25s linear;
  opacity: .85;
  pointer-events: none;
}

/* Copy-feedback flash. Triggered by dblclick handler; clears after 600ms. */
#${ROOT_ID} .lc-chat-sc-pinstrip-copied .lc-chat-sc-card {
  animation: lc-sc-copied-flash .6s ease;
}
@keyframes lc-sc-copied-flash {
  0%   { background: transparent; }
  20%  { background: color-mix(in srgb, var(--lc-chat-accent) 30%, transparent); }
  100% { background: transparent; }
}

/* Compact theme: shrink the strip to a single 36px row, drop the avatar,
   tighten the body. Compact users explicitly opted into density. */
#${ROOT_ID}[data-theme="compact"] .lc-chat-sc-pinstrip {
  min-height: 36px;
  padding: 4px 8px;
}
#${ROOT_ID}[data-theme="compact"] .lc-chat-sc-card {
  grid-template-columns: auto minmax(0, 1fr) auto;
}
#${ROOT_ID}[data-theme="compact"] .lc-chat-sc-avatar {
  display: none;
}
#${ROOT_ID}[data-theme="compact"] .lc-chat-sc-dots {
  display: none;
}
#${ROOT_ID}[data-theme="compact"] .lc-chat-sc-name {
  max-width: 6em;
  font-size: 11px;
}
#${ROOT_ID}[data-theme="compact"] .lc-chat-sc-text {
  font-size: 12px;
}

#${ROOT_ID} .lc-chat-toolbar {
  position: relative;
  min-height: 42px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 9px;
  background: var(--lc-chat-panel);
  border-bottom: 1px solid var(--lc-chat-border);
  backdrop-filter: blur(16px);
  min-width: 0;
  overflow: hidden;
}
#${ROOT_ID} .lc-chat-title {
  flex: 1 1 auto;
  min-width: 0;
  text-align: center;
  font-size: 13px;
  line-height: 1.1;
  font-weight: 700;
  color: var(--lc-chat-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#${ROOT_ID} .lc-chat-pill {
  min-width: 0;
  border: 1px solid transparent;
  border-radius: 999px;
  background: var(--lc-chat-chip);
  color: var(--lc-chat-chip-text);
  height: 24px;
  padding: 0 8px;
  font-size: 11px;
  cursor: pointer;
}
#${ROOT_ID} .lc-chat-icon {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 999px;
  background: var(--lc-chat-chip);
  color: var(--lc-chat-own);
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}
#${ROOT_ID} .lc-chat-menu {
  display: none;
  min-width: 0;
  margin: 0 8px 8px;
  grid-template-columns: 1fr;
  gap: 10px;
  max-height: min(280px, 38vh);
  overflow-y: auto;
  padding: 10px;
  border: 1px solid var(--lc-chat-border);
  border-radius: 18px;
  background: color-mix(in srgb, var(--lc-chat-bg) 92%, #fff);
  box-shadow: 0 16px 42px rgba(0, 0, 0, .28);
  backdrop-filter: blur(24px) saturate(1.35);
  -webkit-backdrop-filter: blur(24px) saturate(1.35);
}
#${ROOT_ID}.lc-chat-menu-open .lc-chat-menu {
  display: grid;
}
#${ROOT_ID} .lc-chat-menu-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}
#${ROOT_ID} .lc-chat-menu-row + .lc-chat-menu-row {
  padding-top: 8px;
  border-top: 1px solid var(--lc-chat-border);
}
#${ROOT_ID} .lc-chat-menu-label {
  flex: 0 0 34px;
  color: var(--lc-chat-muted);
  font-size: 11px;
}
#${ROOT_ID} .lc-chat-pill[aria-pressed="true"] {
  color: var(--lc-chat-own-text);
  background: var(--lc-chat-own);
  border-color: var(--lc-chat-own);
}
#${ROOT_ID} .lc-chat-filterbar {
  display: grid;
  flex: 1 1 auto;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 4px;
  padding: 0;
  min-width: 0;
  overflow: hidden;
  background: transparent;
  border-bottom: 0;
  backdrop-filter: none;
}
#${ROOT_ID} .lc-chat-filter {
  width: 100%;
  flex: 1 1 0;
  min-width: 0;
  height: 21px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: var(--lc-chat-chip);
  color: var(--lc-chat-chip-text);
  padding: 0 3px;
  font-size: 10px;
  cursor: pointer;
  white-space: nowrap;
}
#${ROOT_ID} .lc-chat-filter[aria-pressed="true"] {
  background: var(--lc-chat-own);
  color: var(--lc-chat-own-text);
  border-color: var(--lc-chat-own);
}
/* search input 现在常驻 toolbar(2026-05-18 Jobs 重构) ——它是 toolbar 的主要
   控件,占据原 "直播聊天" 居中标题的位置。带左侧 🔍 SVG icon 当 leading
   affordance,告诉用户"这是搜索",不需要单独的按钮。type=search 在 modern
   browser 自带 × 清除按钮。 */
#${ROOT_ID} .lc-chat-search {
  flex: 1 1 auto;
  min-width: 0;
  width: 0;
  max-width: 100%;
  height: 28px;
  border: 1px solid var(--lc-chat-border);
  border-radius: 999px;
  background: var(--lc-chat-chip);
  color: var(--lc-chat-text);
  padding: 0 10px 0 28px;
  font-size: 12px;
  outline: none;
  background-image: url("data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23999' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='11' cy='11' r='8'/%3E%3Cpath d='m21 21-4.3-4.3'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: 8px center;
  background-size: 14px 14px;
}
#${ROOT_ID} .lc-chat-search:focus {
  border-color: var(--lc-chat-own);
  background-color: var(--lc-chat-bubble);
}
#${ROOT_ID} .lc-chat-search::placeholder {
  color: var(--lc-chat-muted);
}
#${ROOT_ID} .lc-chat-list {
  position: relative;
  min-height: 0;
  min-width: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  overflow-anchor: none;
  padding: 6px 10px 14px;
  scrollbar-width: thin;
  scroll-behavior: auto;
  /* 顶端 6px 软渐变——之前是 18px，把第一行的人名/牌子吃掉了大半。
     6px 够给新消息一点淡入感，但不会再剪掉第一行的元数据。 */
  -webkit-mask-image: linear-gradient(to bottom, transparent, #000 6px, #000 100%);
  mask-image: linear-gradient(to bottom, transparent, #000 6px, #000 100%);
}
#${ROOT_ID} .lc-chat-virtual-items {
  min-width: 0;
  overflow-anchor: none;
}
#${ROOT_ID} .lc-chat-virtual-spacer {
  min-width: 1px;
  pointer-events: none;
  overflow-anchor: none;
}
#${ROOT_ID} .lc-chat-empty {
  min-height: 100%;
  display: grid;
  place-items: center;
  padding: 32px 18px;
  color: var(--lc-chat-muted);
  font-size: 12px;
  line-height: 1.55;
  text-align: center;
  pointer-events: none;
}
#${ROOT_ID} .lc-chat-message {
  position: relative;
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr);
  /* Row gap (between meta and bubble) + column gap (between avatar and
     body) both on the 4px grid; was 3px / 9px which broke the rhythm with
     surrounding 4-grid padding. Vertical row padding also normalized to 4/4
     instead of 4/2/6 (asymmetric without reason). */
  gap: 4px 8px;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  padding: 4px 4px;
  border-radius: 0;
  border: 1px solid transparent;
  background: transparent;
  overflow: visible;
}
/* Entrance animation — wired from custom-chat-dom.ts where new messages get
   the .lc-chat-peek class IFF (a) user is following the bottom and (b)
   batch size leq 12. Both gates prevent the animation from firing during
   scroll-up history reads or large catch-up batches. The .35s spring
   cubic-bezier(.34, 1.56, .64, 1) is the iOS Smooth-Spring curve — it
   overshoots 1px then snaps back, giving messages a "popping in" feel
   without yanking the reader's attention away from older content.
   prefers-reduced-motion users get the position immediately. NOTE: do not
   use backticks anywhere in this CSS — this entire string is a JS template
   literal, and an unescaped backtick will silently terminate it. */
@keyframes lc-msg-in {
  0%   { opacity: 0; transform: translateY(8px) scale(.96); }
  100% { opacity: 1; transform: translateY(0)   scale(1);   }
}
#${ROOT_ID} .lc-chat-message.lc-chat-peek {
  animation: lc-msg-in .35s cubic-bezier(.34, 1.56, .64, 1);
}
@media (prefers-reduced-motion: reduce) {
  #${ROOT_ID} .lc-chat-message.lc-chat-peek {
    animation: none;
  }
}
#${ROOT_ID} .lc-chat-message:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--lc-chat-own) 64%, transparent);
  outline-offset: -2px;
}
#${ROOT_ID} .lc-chat-message:hover {
  background: transparent;
  border-color: transparent;
}
#${ROOT_ID} .lc-chat-message[data-kind="gift"] {
  background: transparent;
}
#${ROOT_ID} .lc-chat-message[data-kind="superchat"] {
  background: transparent;
  border-color: transparent;
}
#${ROOT_ID} .lc-chat-card-event {
  grid-template-columns: 38px minmax(0, 1fr);
  gap: 4px 10px;
  padding: 7px 2px;
}
#${ROOT_ID} .lc-chat-card-event .lc-chat-avatar {
  width: 38px;
  height: 38px;
  margin-bottom: 9px;
}
#${ROOT_ID} .lc-chat-card-event .lc-chat-meta {
  padding-left: 6px;
}
#${ROOT_ID} .lc-chat-card-event .lc-chat-bubble {
  width: 100%;
  max-width: 100%;
  /* min-height 砍掉 ——之前固定 64px,信息密度低的礼物(例如"嘉年华 × 1")会
     在卡片中间留 100+px 真空,看着像 layout bug(Jobs P0-2)。让 content + padding
     自己决定卡片高度,信息密度跟尺寸成正比。SC 长文本依然撑得开,小礼物自己
     收缩。 */
  /* Card bubbles (gift / SC / guard / redpacket / lottery) get the iOS
     "important card" treatment: padding 12/16, border-radius 20/8 (iOS Lock
     Screen card radius), font-weight 800 (Extra Bold everywhere). */
  padding: 12px 16px;
  border-radius: 20px;
  border-bottom-left-radius: 8px;
  font-size: 14px;
  font-weight: 800;
  box-shadow: var(--lc-chat-bubble-shadow);
}
#${ROOT_ID} .lc-chat-card-compact .lc-chat-bubble {
  min-height: 0;
  padding: 8px 12px;
  border-radius: 20px;
  border-bottom-left-radius: 8px;
  font-size: 13px;
  font-weight: 700;
}
#${ROOT_ID} .lc-chat-card-event .lc-chat-bubble::before {
  top: auto;
  bottom: 0;
  left: -4px;
  width: 13px;
  height: 15px;
  background: var(--lc-chat-bubble);
}
#${ROOT_ID} .lc-chat-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  margin-bottom: 6px;
  font-size: 12px;
  line-height: 1.2;
  opacity: .92;
}
#${ROOT_ID} .lc-chat-card-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#${ROOT_ID} .lc-chat-card-mark {
  flex: 0 0 auto;
  display: inline-grid;
  place-items: center;
  min-width: 28px;
  height: 22px;
  padding: 0 7px;
  border-radius: 999px;
  background: rgba(255, 255, 255, .28);
  color: currentColor;
  font-size: 11px;
  font-weight: 800;
}
#${ROOT_ID} .lc-chat-card-text {
  display: block;
  line-height: 1.35;
}
#${ROOT_ID} .lc-chat-card-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 6px;
}
#${ROOT_ID} .lc-chat-card-field {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
  max-width: 100%;
  padding: 2px 7px;
  border-radius: 999px;
  background: rgba(255, 255, 255, .24);
  color: currentColor;
  font-size: 11px;
  line-height: 1.35;
}
#${ROOT_ID} .lc-chat-card-field-label {
  opacity: .72;
}
#${ROOT_ID} .lc-chat-card-field-value {
  font-weight: 800;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#${ROOT_ID} .lc-chat-card-event[data-card="gift"] .lc-chat-bubble {
  background: linear-gradient(135deg, #ffd8bf, #fff2c7);
  color: #4a2a10;
  border-color: rgba(191, 92, 0, .2);
}
#${ROOT_ID} .lc-chat-card-event[data-card="superchat"] .lc-chat-bubble {
  background: linear-gradient(135deg, #ff9f0a, #ff453a);
  color: #fff;
  border-color: rgba(255, 69, 58, .32);
  /* SC is the only "hero" event in the chat list — user paid for it,
     they want it seen. Extra outer glow + bright inset highlight set it
     apart from every other card (which all share --lc-chat-bubble-shadow).
     The glow lives in --lc-superchat-glow so presets with a non-red SC
     gradient (milk-green, midnight-indigo) can re-tint it without copy-
     pasting the whole shadow stack. */
  box-shadow: var(--lc-superchat-glow);
}
#${ROOT_ID} .lc-chat-card-event[data-card="guard"] .lc-chat-bubble {
  background: linear-gradient(135deg, #2f80ed, #7c5cff);
  color: #fff;
  border-color: rgba(47, 128, 237, .32);
}
#${ROOT_ID} .lc-chat-card-event[data-card="redpacket"] .lc-chat-bubble {
  background: linear-gradient(135deg, #ff375f, #ffcc00);
  color: #fff;
  border-color: rgba(255, 55, 95, .32);
}
#${ROOT_ID} .lc-chat-card-event[data-card="lottery"] .lc-chat-bubble {
  background: linear-gradient(135deg, #34c759, #64d2ff);
  color: #063320;
  border-color: rgba(52, 199, 89, .28);
}
#${ROOT_ID} .lc-chat-card-event[data-guard="2"] .lc-chat-bubble {
  background: linear-gradient(135deg, #af52de, #ff7ad9);
}
#${ROOT_ID} .lc-chat-card-event[data-guard="1"] .lc-chat-bubble {
  background: linear-gradient(135deg, #ff2d55, #ff9f0a);
}
#${ROOT_ID} .lc-chat-message[data-kind="guard"],
#${ROOT_ID} .lc-chat-message[data-kind="follow"],
#${ROOT_ID} .lc-chat-message[data-kind="like"],
#${ROOT_ID} .lc-chat-message[data-kind="share"],
#${ROOT_ID} .lc-chat-message[data-kind="redpacket"],
#${ROOT_ID} .lc-chat-message[data-kind="lottery"],
#${ROOT_ID} .lc-chat-message[data-kind="notice"],
#${ROOT_ID} .lc-chat-message[data-kind="system"] {
  opacity: .86;
}
#${ROOT_ID} .lc-chat-message[data-priority="lite"] {
  grid-template-columns: minmax(0, 1fr);
  padding: 2px 8px;
  opacity: .78;
}
#${ROOT_ID} .lc-chat-message[data-priority="lite"] .lc-chat-avatar,
#${ROOT_ID} .lc-chat-message[data-priority="lite"] .lc-chat-meta,
#${ROOT_ID} .lc-chat-message[data-priority="lite"] .lc-chat-actions {
  display: none;
}
#${ROOT_ID} .lc-chat-message[data-priority="lite"] .lc-chat-body {
  grid-column: 1 / 2;
  justify-items: center;
}
#${ROOT_ID} .lc-chat-message[data-priority="lite"] .lc-chat-bubble {
  max-width: 92%;
  min-width: 0;
  padding: 4px 12px;
  border-radius: 999px;
  color: var(--lc-chat-lite-text);
  background: var(--lc-chat-lite);
  border-color: transparent;
  box-shadow: none;
  font-size: 11px;
  font-weight: 500;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#${ROOT_ID} .lc-chat-message[data-priority="lite"] .lc-chat-bubble::before {
  display: none;
}
#${ROOT_ID} .lc-chat-message[data-priority="identity"] .lc-chat-avatar {
  box-shadow: 0 0 0 1px var(--lc-chat-guard-bg), 0 2px 7px var(--lc-chat-shadow);
}
#${ROOT_ID} .lc-chat-message[data-guard="1"] .lc-chat-avatar {
  box-shadow: 0 0 0 2px var(--lc-chat-price-bg), 0 2px 8px var(--lc-chat-shadow);
}
#${ROOT_ID} .lc-chat-message[data-guard="2"] .lc-chat-avatar {
  box-shadow: 0 0 0 2px var(--lc-chat-ul-bg), 0 2px 8px var(--lc-chat-shadow);
}
#${ROOT_ID} .lc-chat-message[data-guard="3"] .lc-chat-avatar {
  box-shadow: 0 0 0 2px var(--lc-chat-guard-bg), 0 2px 8px var(--lc-chat-shadow);
}
#${ROOT_ID} .lc-chat-meta {
  max-width: 100%;
  min-width: 0;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  color: var(--lc-chat-muted);
  font-size: 11px;
  line-height: 1.2;
  padding-left: 10px;
  overflow: hidden;
}
#${ROOT_ID} .lc-chat-name {
  min-width: 0;
  max-width: min(15em, 64%);
  color: var(--lc-chat-name);
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#${ROOT_ID} .lc-chat-time {
  flex: 0 0 auto;
  color: var(--lc-chat-muted);
}
#${ROOT_ID} .lc-chat-avatar {
  position: relative;
  grid-row: 1 / 3;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--lc-chat-chip);
  align-self: end;
  margin-bottom: 3px;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, .5), 0 2px 7px var(--lc-chat-shadow);
}
#${ROOT_ID} .lc-chat-avatar-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  border-radius: inherit;
  object-fit: cover;
  opacity: 0;
  filter: blur(4px);
  /* Slow, gentle ease-out so a late-arriving avatar fades into focus rather
     than popping in. >250ms keeps the change below the eye's "motion" gate
     so it doesn't draw attention. Cache hits set data-loaded=1 BEFORE the
     element is mounted, so the transition never fires for them — they
     paint at opacity:1 from the first frame. */
  transition: opacity .32s cubic-bezier(.4, 0, .2, 1), filter .32s cubic-bezier(.4, 0, .2, 1);
}
#${ROOT_ID} .lc-chat-avatar-img[data-loaded="1"] {
  opacity: 1;
  filter: none;
}
/* Neutral placeholder while the avatar image is in flight. Gray chip
   background (inherited from .lc-chat-avatar) plus a muted person silhouette
   centered on top — visually it reads as "an empty avatar slot", not a
   loading widget. The eye does not fixate on it, and the swap to the real
   photo is a "fill" rather than a "color flip". No text content here, so
   the displayed name has no visual echo in the placeholder either. */
/* Use Bilibili's own default "noface" avatar as the placeholder. Users
   already see this exact image throughout the live site whenever an avatar
   isn't set or hasn't loaded, so it is the quietest possible cache-miss
   state — the brain treats it as "a normal default avatar", not "this chat
   is loading something". The URL is on i0.hdslb.com which we already
   preconnect; the file itself is also prewarmed on chat start (see
   custom-chat-dom.ts) so it sits in HTTP cache before any message renders. */
#${ROOT_ID} .lc-chat-avatar-fallback {
  background-image: url("https://i0.hdslb.com/bfs/face/member/noface.jpg");
  background-repeat: no-repeat;
  background-position: center;
  background-size: cover;
}
#${ROOT_ID} .lc-chat-reply {
  color: var(--lc-chat-accent);
}
/* ×N 折叠徽章 ——挂在气泡的右上角作为"角标"(custom-chat-dom.ts:text.append(mergeBadge))。
   先前曾尝试 inline-block 跟在文本后面,长文本换行后 chip 单独占一行变成视觉孤儿
   (Jobs 批评 P0-4)。改成 iOS notification-badge 模式:absolute 浮在气泡右上角,
   带 panel-color "cutout" 边框,让它跟任何气泡背景都有明显分隔,无论文本多长都
   贴在右上,语义"这是消息的一个属性"自然成立。
   注意:CSS 注释里不要写反引号 —— 整个 style 字符串是 JS template literal,
   反引号会提前终止它。 */
#${ROOT_ID} .lc-chat-merge-count {
  position: absolute;
  top: -7px;
  right: -6px;
  z-index: 2;
  min-width: 18px;
  padding: 1px 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: var(--lc-chat-chip);
  color: var(--lc-chat-chip-text);
  /* panel-color border 在任何气泡颜色上都形成"切口"对比,徽章自然浮起 */
  border: 1.5px solid var(--lc-chat-panel);
  font-size: 11px;
  font-weight: 700;
  line-height: 1.35;
  white-space: nowrap;
  user-select: none;
  box-shadow: 0 1px 3px rgba(0, 0, 0, .14);
}
/* card-event 上 ×N 用更不透明的深色芯片 + 更宽的白色边框,让它在 SC 红橙、
   礼物黄、舰长紫等饱和气泡上都明确浮起。原先试过"白底白字"想跟卡片配色家族,
   但白底在浅黄礼物卡上几乎隐形 ——visibility 比纯度重要。这里走"高对比 chip"
   方案:深色芯,亮白halo,任何气泡都炸出来。 */
#${ROOT_ID} .lc-chat-card-event .lc-chat-merge-count {
  background: rgba(0, 0, 0, .55);
  color: #fff;
  border-color: rgba(255, 255, 255, .92);
  border-width: 2px;
  text-shadow: 0 1px 2px rgba(0, 0, 0, .4);
  box-shadow: 0 2px 6px rgba(0, 0, 0, .22);
}
#${ROOT_ID} .lc-chat-badge {
  flex: 0 1 auto;
  border-radius: 999px;
  padding: 1px 6px;
  background: var(--lc-chat-chip);
  color: var(--lc-chat-chip-text);
  font-size: 10px;
  line-height: 1.25;
  max-width: min(11em, 58%);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#${ROOT_ID} .lc-chat-medal {
  max-width: min(12em, 72%);
}
#${ROOT_ID} .lc-chat-badge[data-badge-type="medal"] {
  color: var(--lc-chat-medal-text);
  background: var(--lc-chat-medal-bg);
  text-shadow: none;
}
#${ROOT_ID} .lc-chat-badge[data-badge-type="guard"] {
  color: var(--lc-chat-guard-text);
  background: var(--lc-chat-guard-bg);
  font-weight: 800;
  text-shadow: none;
}
#${ROOT_ID} .lc-chat-badge[data-badge-type="admin"] {
  color: var(--lc-chat-admin-text);
  background: var(--lc-chat-admin-bg);
}
#${ROOT_ID} .lc-chat-badge[data-badge-type="rank"] {
  color: var(--lc-chat-rank-text);
  background: var(--lc-chat-rank-bg);
  font-weight: 800;
}
#${ROOT_ID} .lc-chat-badge[data-badge-type="ul"] {
  color: var(--lc-chat-ul-text);
  background: var(--lc-chat-ul-bg);
}
#${ROOT_ID} .lc-chat-badge[data-badge-type="honor"] {
  color: var(--lc-chat-honor-text);
  background: var(--lc-chat-honor-bg);
}
#${ROOT_ID} .lc-chat-badge[data-badge-type="price"] {
  color: var(--lc-chat-price-text);
  background: var(--lc-chat-price-bg);
  font-weight: 800;
}
#${ROOT_ID} .lc-chat-kind {
  color: var(--lc-chat-own-text);
  background: var(--lc-chat-own);
}
#${ROOT_ID} .lc-chat-message[data-kind="danmaku"] .lc-chat-kind {
  display: none;
}
#${ROOT_ID} .lc-chat-kind[data-kind="gift"] {
  background: #ffd166;
}
#${ROOT_ID} .lc-chat-kind[data-kind="superchat"] {
  background: #ff7a59;
  color: #fff;
}
#${ROOT_ID} .lc-chat-kind[data-kind="enter"] {
  background: #9cb8ff;
}
#${ROOT_ID} .lc-chat-body {
  grid-column: 2 / 3;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  display: grid;
  justify-items: start;
  gap: 4px;
  overflow: visible;
}
#${ROOT_ID} .lc-chat-bubble {
  position: relative;
  display: block;
  width: fit-content;
  min-width: 2.6em;
  max-width: calc(100% - 12px);
  color: var(--lc-chat-bubble-text);
  background: var(--lc-chat-bubble);
  border: 1px solid color-mix(in srgb, var(--lc-chat-border) 74%, transparent);
  border-radius: 20px;
  border-bottom-left-radius: 8px;
  /* Padding + font-weight + font-size all snap to the 4px / iOS Text grid:
     padding 8/12 (was 8/13/9 with asymmetric bottom — drops 13 and 9 which
     broke the rhythm), font-size 13px (was 13.5 — half-pixel anti-aliasing
     is noisy at this size), font-weight 500 (was unset → 400, which the
     design-direction doc flags as too light to read on dark backgrounds at
     small sizes). The cumulative effect is bubbles that look "tighter"
     without changing apparent size. */
  padding: 8px 12px;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.4;
  word-break: break-word;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  box-shadow: var(--lc-chat-bubble-shadow);
  isolation: isolate;
}
#${ROOT_ID} .lc-chat-emote {
  display: inline-block;
  width: 1.35em;
  height: 1.35em;
  margin: -.15em .06em;
  vertical-align: middle;
  object-fit: contain;
}
#${ROOT_ID} .lc-chat-emote-big {
  display: inline-block;
  max-width: 96px;
  max-height: 96px;
  vertical-align: middle;
  object-fit: contain;
}
#${ROOT_ID} .lc-chat-bubble::before {
  content: "";
  position: absolute;
  left: -4px;
  bottom: 0;
  width: 12px;
  height: 15px;
  background: inherit;
  border-left: 1px solid color-mix(in srgb, var(--lc-chat-border) 74%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--lc-chat-border) 74%, transparent);
  border-bottom-left-radius: 12px;
  transform: skew(-22deg);
  z-index: -1;
}
#${ROOT_ID} .lc-chat-message[data-kind="gift"] .lc-chat-bubble {
  background: #fff4c2;
  color: #4a3400;
  border-color: rgba(191, 134, 0, .22);
}
#${ROOT_ID} .lc-chat-message[data-kind="superchat"] .lc-chat-bubble {
  background: linear-gradient(180deg, #ff9f0a, #ff7a59);
  color: #fff;
  border-color: rgba(255, 122, 89, .28);
}
#${ROOT_ID}[data-theme="laplace"] .lc-chat-message[data-kind="gift"] .lc-chat-bubble,
#${ROOT_ID}[data-theme="compact"] .lc-chat-message[data-kind="gift"] .lc-chat-bubble {
  background: rgba(255, 214, 10, .22);
  color: #fff4bf;
}
#${ROOT_ID}[data-theme="laplace"] .lc-chat-message[data-kind="superchat"] .lc-chat-bubble,
#${ROOT_ID}[data-theme="compact"] .lc-chat-message[data-kind="superchat"] .lc-chat-bubble {
  background: linear-gradient(180deg, rgba(255, 159, 10, .92), rgba(255, 69, 58, .86));
  color: #fff;
}
/* 之前 .lc-chat-actions 在 grid 里占第 2 列一整行，opacity:0 仅隐藏不脱布局，
   每条消息因此白白多出 ~20px 高度。改成 absolute 浮在气泡右下角，
   只在 hover/selected 时显形，每条消息直接省 20px。 */
#${ROOT_ID} .lc-chat-actions {
  position: absolute;
  bottom: 2px;
  right: 4px;
  z-index: 2;
  display: flex;
  gap: 4px;
  padding: 2px 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--lc-chat-panel) 86%, transparent);
  backdrop-filter: blur(6px);
  box-shadow: 0 2px 8px color-mix(in srgb, var(--lc-chat-bg) 36%, transparent);
  opacity: 0;
  transform: translateY(2px);
  transition: opacity .12s, transform .12s;
  pointer-events: none;
  max-width: 70%;
  overflow: hidden;
}
#${ROOT_ID} .lc-chat-message:hover .lc-chat-actions,
#${ROOT_ID} .lc-chat-message.lc-chat-selected .lc-chat-actions,
#${ROOT_ID} .lc-chat-message:focus-within .lc-chat-actions {
  opacity: 1;
  transform: translateY(0);
  pointer-events: auto;
}
#${ROOT_ID} .lc-chat-message.lc-chat-selected .lc-chat-bubble {
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--lc-chat-own) 18%, transparent), var(--lc-chat-bubble-shadow);
}
#${ROOT_ID} .lc-chat-action {
  min-width: 22px;
  height: 20px;
  border: 0;
  border-radius: 999px;
  background: var(--lc-chat-chip);
  color: var(--lc-chat-chip-text);
  font-size: 10px;
  cursor: pointer;
  white-space: nowrap;
}
#${ROOT_ID} .lc-chat-action:hover {
  background: var(--lc-chat-own);
  color: var(--lc-chat-own-text);
}
#${ROOT_ID} .lc-chat-composer {
  position: sticky;
  bottom: 0;
  z-index: 4;
  display: grid;
  grid-template-rows: auto auto;
  flex: 0 0 auto;
  min-width: 0;
  min-height: 88px;
  gap: 6px;
  padding: 9px 8px 8px;
  border-top: 1px solid var(--lc-chat-border);
  background: color-mix(in srgb, var(--lc-chat-panel) 94%, transparent);
  box-shadow: 0 -10px 24px color-mix(in srgb, var(--lc-chat-bg) 86%, transparent);
  backdrop-filter: blur(16px);
}
#${ROOT_ID} .lc-chat-jump-bottom {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  z-index: 6;
  max-width: calc(100% - 24px);
  height: 28px;
  padding: 0 14px;
  border: 1px solid color-mix(in srgb, var(--lc-chat-own) 32%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--lc-chat-panel) 92%, var(--lc-chat-own) 8%);
  color: var(--lc-chat-text);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  box-shadow: 0 6px 18px color-mix(in srgb, var(--lc-chat-bg) 40%, transparent);
  backdrop-filter: blur(12px);
  transition: background-color .14s ease, transform .14s ease, box-shadow .14s ease;
}
#${ROOT_ID} .lc-chat-jump-bottom[data-unread="true"] {
  background: var(--lc-chat-own);
  color: var(--lc-chat-own-text);
  border-color: transparent;
}
#${ROOT_ID} .lc-chat-jump-bottom:hover {
  transform: translateX(-50%) translateY(-1px);
  box-shadow: 0 8px 22px color-mix(in srgb, var(--lc-chat-bg) 50%, transparent);
}
#${ROOT_ID} .lc-chat-input-wrap {
  position: relative;
}
#${ROOT_ID} textarea {
  width: 100%;
  min-width: 0;
  height: 46px;
  resize: vertical;
  min-height: 42px;
  max-height: 120px;
  border: 1px solid var(--lc-chat-border);
  border-radius: 22px;
  background: color-mix(in srgb, var(--lc-chat-bubble) 92%, var(--lc-chat-panel));
  color: var(--lc-chat-bubble-text);
  padding: 9px 38px 9px 13px;
  outline: none;
  font-size: 13px;
  line-height: 1.34;
  overflow-x: hidden;
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, .035);
}
#${ROOT_ID} textarea:focus {
  border-color: var(--lc-chat-own);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--lc-chat-own) 18%, transparent);
}
#${ROOT_ID} .lc-chat-count {
  position: absolute;
  right: 8px;
  bottom: 6px;
  color: var(--lc-chat-muted);
  font-size: 11px;
  pointer-events: none;
}
#${ROOT_ID} .lc-chat-send-row {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  overflow: hidden;
}
#${ROOT_ID} .lc-chat-send {
  min-height: 27px;
  padding: 0 13px;
  border: 0;
  border-radius: 999px;
  background: var(--lc-chat-own);
  color: var(--lc-chat-own-text);
  font-weight: 700;
  cursor: pointer;
}
#${ROOT_ID} .lc-chat-send:disabled {
  opacity: .5;
  cursor: wait;
}
#${ROOT_ID} .lc-chat-hint {
  color: var(--lc-chat-muted);
  font-size: 11px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#${ROOT_ID} .lc-chat-unread {
  max-width: min(100%, 220px);
  border-color: color-mix(in srgb, var(--lc-chat-own) 28%, transparent);
}
#${ROOT_ID} .lc-chat-unread[data-frozen="true"] {
  background: color-mix(in srgb, var(--lc-chat-chip) 74%, var(--lc-chat-own) 26%);
}
@keyframes lc-status-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
#${ROOT_ID} .lc-chat-ws-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 22px;
  max-width: 100%;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 11px;
  color: var(--lc-chat-muted);
  min-width: 38px;
  background: color-mix(in srgb, var(--lc-chat-chip) 70%, transparent);
  overflow-wrap: anywhere;
}
#${ROOT_ID} .lc-chat-ws-status::before {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--lc-chat-muted);
  opacity: 0.5;
}
#${ROOT_ID} .lc-chat-ws-status[data-status="live"] {
  color: var(--lc-chat-accent);
}
#${ROOT_ID} .lc-chat-ws-status[data-status="live"]::before {
  background: var(--lc-chat-accent);
  opacity: 1;
}
#${ROOT_ID} .lc-chat-ws-status[data-status="connecting"]::before {
  background: #ff9500;
  opacity: 1;
  animation: lc-status-pulse 1.2s ease-in-out infinite;
}
#${ROOT_ID} .lc-chat-ws-status[data-status="fallback"] {
  color: #8a4b00;
  background: rgba(255, 159, 10, .18);
  border: 1px solid rgba(255, 159, 10, .34);
}
#${ROOT_ID} .lc-chat-ws-status[data-status="fallback"]::before {
  background: #ff9500;
  opacity: 1;
}
#${ROOT_ID} .lc-chat-ws-status[data-status="dom-warning"] {
  color: #9a3412;
  background: rgba(255, 204, 0, .20);
  border: 1px solid rgba(255, 204, 0, .42);
}
#${ROOT_ID} .lc-chat-ws-status[data-status="dom-warning"]::before {
  background: #ff9500;
  opacity: 1;
}
#${ROOT_ID}[data-theme="laplace"] .lc-chat-ws-status[data-status="fallback"],
#${ROOT_ID}[data-theme="compact"] .lc-chat-ws-status[data-status="fallback"],
#${ROOT_ID}[data-theme="laplace"] .lc-chat-ws-status[data-status="dom-warning"],
#${ROOT_ID}[data-theme="compact"] .lc-chat-ws-status[data-status="dom-warning"] {
  color: #ffd60a;
  background: rgba(255, 159, 10, .20);
  border-color: rgba(255, 214, 10, .36);
}
#${ROOT_ID}[data-theme="laplace"] .lc-chat-ws-status[data-status="fallback"]::before,
#${ROOT_ID}[data-theme="compact"] .lc-chat-ws-status[data-status="fallback"]::before,
#${ROOT_ID}[data-theme="laplace"] .lc-chat-ws-status[data-status="dom-warning"]::before,
#${ROOT_ID}[data-theme="compact"] .lc-chat-ws-status[data-status="dom-warning"]::before {
  background: #ff9f0a;
  opacity: 1;
}
#${ROOT_ID} .lc-chat-perf {
  display: none;
  width: 100%;
  padding: 6px 8px;
  border-radius: 12px;
  color: var(--lc-chat-muted);
  background: color-mix(in srgb, var(--lc-chat-chip) 72%, transparent);
  font: 11px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
  overflow-wrap: anywhere;
}
#${ROOT_ID}[data-debug="true"] .lc-chat-perf {
  display: block;
}
#${ROOT_ID} .lc-chat-event-debug {
  display: none;
  min-width: 0;
  margin: 0 8px 6px;
  padding: 8px 10px;
  border: 1px solid var(--lc-chat-border);
  border-radius: 14px;
  background: color-mix(in srgb, var(--lc-chat-panel) 88%, var(--lc-chat-bg));
  color: var(--lc-chat-muted);
  font: 11px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
  overflow-wrap: anywhere;
}
#${ROOT_ID}[data-inspecting="true"] .lc-chat-event-debug {
  display: grid;
  gap: 5px;
}
#${ROOT_ID} .lc-chat-debug-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
#${ROOT_ID} .lc-chat-debug-title {
  color: var(--lc-chat-text);
  font-weight: 800;
}
#${ROOT_ID} .lc-chat-debug-close {
  border: 0;
  border-radius: 999px;
  background: var(--lc-chat-chip);
  color: var(--lc-chat-chip-text);
  cursor: pointer;
  font-size: 11px;
}
#${ROOT_ID} .lc-chat-debug-row {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 6px;
}
#${ROOT_ID} .lc-chat-debug-key {
  color: var(--lc-chat-muted);
}
#${ROOT_ID} .lc-chat-debug-value {
  color: var(--lc-chat-text);
}
html.lc-custom-chat-hide-native.lc-custom-chat-mounted .chat-items,
html.lc-custom-chat-hide-native.lc-custom-chat-mounted .super-chat-card,
html.lc-custom-chat-hide-native.lc-custom-chat-mounted .chat-control-panel,
html.lc-custom-chat-hide-native.lc-custom-chat-mounted .chat-input-panel,
html.lc-custom-chat-hide-native.lc-custom-chat-mounted .control-panel-ctnr,
html.lc-custom-chat-hide-native.lc-custom-chat-mounted .chat-input-ctnr,
html.lc-custom-chat-hide-native.lc-custom-chat-mounted [class*="input-panel"],
html.lc-custom-chat-hide-native.lc-custom-chat-mounted [class*="input-ctnr"],
html.lc-custom-chat-hide-native.lc-custom-chat-mounted [class*="send-bar"],
html.lc-custom-chat-hide-native.lc-custom-chat-mounted [class*="bottom-send"],
html.lc-custom-chat-hide-native.lc-custom-chat-mounted [class*="chat-send"],
html.lc-custom-chat-hide-native.lc-custom-chat-mounted .live-input-panel {
  display: none !important;
}
html.lc-custom-chat-hide-native.lc-custom-chat-mounted.lc-custom-chat-root-outside-history .chat-history-panel {
  display: none !important;
}
html.lc-custom-chat-hide-native.lc-custom-chat-mounted .chat-history-panel:has(#${ROOT_ID}) > :not(#${ROOT_ID}) {
  display: none !important;
}
`

export function ensureCustomChatStyles({
  styleId,
  userStyleId,
  customCss,
  styleEl,
  userStyleEl,
}: {
  styleId: string
  userStyleId: string
  customCss: string
  styleEl: HTMLStyleElement | null
  userStyleEl: HTMLStyleElement | null
}): { styleEl: HTMLStyleElement; userStyleEl: HTMLStyleElement } {
  let nextStyleEl = styleEl
  if (!nextStyleEl) {
    nextStyleEl = document.createElement('style')
    nextStyleEl.id = styleId
    nextStyleEl.textContent = CUSTOM_CHAT_STYLE
    document.head.appendChild(nextStyleEl)
  }

  let nextUserStyleEl = userStyleEl
  if (!nextUserStyleEl) {
    nextUserStyleEl = document.createElement('style')
    nextUserStyleEl.id = userStyleId
    document.head.appendChild(nextUserStyleEl)
  }
  // Sanitize before injection — strips `@import` (which can fetch arbitrary
  // remote URLs and bypass the script's @connect allowlist), neutralizes
  // hostile `url(javascript:…)` schemes, removes legacy IE `expression(…)`
  // hooks, and caps the total length. A corrupted backup or a malicious
  // theme preset cannot turn this user-supplied string into a network /
  // execution channel.
  const safeCss = sanitizeCustomChatCss(customCss).css
  // Avoid clobbering textContent unless the CSS string actually changed —
  // reassigning forces a full stylesheet recompute even when the value is
  // identical, and this runs from a Preact `effect` that fires whenever any
  // of its tracked signals tick.
  if (nextUserStyleEl.textContent !== safeCss) {
    nextUserStyleEl.textContent = safeCss
  }

  return { styleEl: nextStyleEl, userStyleEl: nextUserStyleEl }
}
