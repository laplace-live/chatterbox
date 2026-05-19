import { effect } from '@preact/signals'

import { GM_addStyle } from '$'
import { probeAndUpdateCbBackendHealth } from './cb-backend-client'
import { customChatEnabled, customChatHideNative, customChatUseWs, optimizeLayout } from './store'
import { cbBackendEnabled, cbBackendHealthState, cbBackendUrlOverride } from './store-meme'
import { extractRoomNumber } from './utils'

const CUSTOM_CHAT_REARM_OFF_DELAY_MS = 80
const CUSTOM_CHAT_REARM_ON_DELAY_MS = 160
const PANEL_STYLE = `
      #laplace-chatterbox-toggle,
      #laplace-chatterbox-dialog,
      #laplace-chatterbox-dialog * {
        box-sizing: border-box;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
        font-size: 12px;
        letter-spacing: 0;
      }

      #laplace-chatterbox-toggle {
        appearance: none !important;
        border: 1px solid rgba(255, 255, 255, .42) !important;
        border-radius: 999px !important;
        min-height: 30px !important;
        padding: 0 12px !important;
        background: rgba(30, 30, 30, .78) !important;
        color: #fff !important;
        box-shadow: 0 10px 28px rgba(0, 0, 0, .22), inset 0 1px rgba(255, 255, 255, .22) !important;
        backdrop-filter: blur(18px) saturate(1.4);
        -webkit-backdrop-filter: blur(18px) saturate(1.4);
        transition: transform .2s ease, background .2s ease;
      }

      #laplace-chatterbox-toggle[data-sending="true"] {
        background: rgba(0, 186, 143, .88) !important;
      }

      #laplace-chatterbox-toggle[data-open="true"] {
        transform: scale(1.06);
      }

      #laplace-chatterbox-toggle:active {
        transform: scale(0.96);
      }

      #laplace-chatterbox-toggle:focus-visible {
        outline: 2px solid #0a84ff !important;
        outline-offset: 2px !important;
      }

      /*
       * Canonical design tokens — the product's chromatic constitution.
       *
       * Two-color semantic system:
       *  - --cb-accent (iOS blue) — product brand identity. Used for
       *    primary buttons, links, focus rings, toggle ON state, active
       *    chips. This is "what action will happen" / "what is the product".
       *  - --cb-success (iOS green) — system feedback for healthy state.
       *    Used for success toasts and "已配置/运行中" badges. Distinct
       *    from accent so it doesn't compete; this is "this is working".
       *
       * The pre-tokens codebase shipped 60+ inline hex codes across 4 blues
       * (#0a84ff / #007aff / #3b82f6 / #1677ff), 6 greens (#34c759 /
       * #30d158 / #0a7f55 / #10b981 / #36a185 / #168a45), 4 reds, and 3
       * oranges — subliminal chromatic chaos that signals "amateur" to
       * anyone with a designer's eye. Components now read these tokens
       * instead of hardcoding values, so dark mode flips automatically.
       *
       * Each token has a -text variant where needed: WCAG AA contrast on
       * white needs darker greens / reds than the fill colors. E.g. #34c759
       * passes for fills but fails as text on white; #0a7f55 passes for
       * text but reads muddy as a fill.
       *
       * Scoped to the dialog so they don't leak into Bilibili's page CSS.
       * The portaled emoji picker (rendered to body, outside this scope)
       * uses hardcoded mirrors of these values — keep them in sync.
       */
      #laplace-chatterbox-dialog {
        --cb-accent: #007aff;
        --cb-accent-soft: rgba(0, 122, 255, .12);
        --cb-success: #34c759;
        --cb-success-text: #0a7f55;
        --cb-warning: #ff9500;
        --cb-warning-text: #a15c00;
        --cb-danger: #ff3b30;
        --cb-danger-text: #b00020;
        --cb-text: #1d1d1f;
        --cb-text-2: #6e6e73;
        --cb-text-3: #98989d;
        --cb-border: rgba(0, 0, 0, .08);
        --cb-border-soft: rgba(0, 0, 0, .06);
        --cb-surface: rgba(255, 255, 255, .9);
        --cb-surface-soft: rgba(252, 252, 253, .78);

        color: #1d1d1f !important;
        background: rgba(248, 248, 250, .86) !important;
        border: 1px solid rgba(0, 0, 0, .08) !important;
        border-radius: 8px !important;
        box-shadow: 0 22px 60px rgba(0, 0, 0, .24), 0 1px 0 rgba(255,255,255,.72) inset !important;
        backdrop-filter: blur(26px) saturate(1.5);
        -webkit-backdrop-filter: blur(26px) saturate(1.5);
        scrollbar-width: thin;
      }

      #laplace-chatterbox-dialog .cb-scroll {
        padding: 8px !important;
      }

      #laplace-chatterbox-dialog details {
        margin: 0 0 5px !important;
        padding: 0 !important;
        border: 1px solid rgba(0, 0, 0, .08) !important;
        border-radius: 8px !important;
        background: rgba(252, 252, 253, .78) !important;
        box-shadow: 0 1px 0 rgba(255, 255, 255, .7) inset !important;
        overflow: hidden;
      }

      /*
       * Details expand/collapse animation — Apple-iOS-disclosure tier.
       *
       * The right way to animate details: target the ::details-content
       * pseudo-element (Chrome 131+, Nov 2024). This pseudo is the layout
       * container the UA stylesheet uses to hide non-summary children when
       * [open] is removed.
       *
       * Previous attempt (details > :not(summary)) only animated the FIRST
       * open — close failed because the UA stylesheet sets content-visibility:
       * hidden on ::details-content IMMEDIATELY when [open] flips off,
       * yanking inner children out of layout before any child-level height
       * transition could play. Targeting the pseudo itself is the only way
       * to coordinate with the UA's hide mechanism.
       *
       * Enablers:
       *   1. ::details-content pseudo (Chrome 131+) — the actual animatable
       *      container.
       *   2. interpolate-size: allow-keywords (Chrome 129+) — enables
       *      transitioning numeric values to intrinsic keywords like auto.
       *   3. transition-behavior: allow-discrete — lets content-visibility
       *      participate in the transition so the native hide waits for our
       *      block-size transition to finish before flipping.
       *
       * Design choices (Jobs-style critique already applied — 240/200ms,
       * height-only, no opacity, chevron synced at 240ms above):
       *
       *   - 240ms open / 200ms close (close-faster-than-open convention)
       *   - block-size (logical height) for vertical-writing-mode correctness
       *   - overflow: clip not hidden — clip is stricter, can't scroll,
       *     better fit for animated containers
       *
       * @supports double-check: requires BOTH selector(::details-content)
       * AND interpolate-size. Older browsers fall through to native instant-
       * snap (chevron still rotates, content snaps — not worse than today).
       * Honors prefers-reduced-motion.
       */
      @supports selector(::details-content) and (interpolate-size: allow-keywords) {
        #laplace-chatterbox-dialog {
          interpolate-size: allow-keywords;
        }

        #laplace-chatterbox-dialog details::details-content {
          block-size: 0;
          overflow: clip;
          transition:
            block-size 240ms cubic-bezier(.32, .72, 0, 1),
            content-visibility 240ms allow-discrete;
          transition-behavior: allow-discrete;
        }

        #laplace-chatterbox-dialog details[open]::details-content {
          block-size: auto;
        }

        #laplace-chatterbox-dialog details:not([open])::details-content {
          /* Close faster than open — Apple convention. */
          transition-duration: 200ms;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        #laplace-chatterbox-dialog details::details-content {
          transition: none !important;
        }
        #laplace-chatterbox-dialog summary::after {
          transition: none !important;
        }
      }

      #laplace-chatterbox-dialog details[open] {
        background: rgba(255, 255, 255, .9) !important;
      }

      #laplace-chatterbox-dialog .cb-settings-accordion > .cb-section {
        margin: 0 !important;
        padding: 0 7px 7px !important;
        border: 0 !important;
        border-radius: 0 !important;
        background: transparent !important;
        box-shadow: none !important;
      }

      #laplace-chatterbox-dialog .cb-settings-accordion[open] > .cb-section > .cb-heading,
      #laplace-chatterbox-dialog .cb-settings-accordion[open] > .cb-section > .cb-row:first-child > .cb-heading {
        display: none;
      }

      #laplace-chatterbox-dialog details > :not(summary):not(.cb-body) {
        margin-left: 10px;
        margin-right: 10px;
      }

      #laplace-chatterbox-dialog details > :last-child:not(summary) {
        margin-bottom: 10px;
      }

      #laplace-chatterbox-dialog summary {
        min-height: 30px;
        display: flex !important;
        align-items: center;
        gap: 6px;
        padding: 0 8px !important;
        color: #1d1d1f !important;
        list-style: none;
        font-weight: 650 !important;
        cursor: pointer;
        user-select: none;
      }

      /* Hide the default disclosure triangle on every engine.
       * Webkit/Blink expose it via the legacy ::-webkit-details-marker
       * pseudo, while Firefox treats <summary> as a list-item with a
       * ::marker -- list-style: none is the only cross-engine kill switch.
       */
      #laplace-chatterbox-dialog summary {
        list-style: none;
      }
      #laplace-chatterbox-dialog summary::-webkit-details-marker {
        display: none;
      }
      #laplace-chatterbox-dialog summary::marker {
        display: none;
      }

      /*
       * Disclosure chevron — Apple-iOS-Settings tier.
       *
       * History of the visibility bug: an earlier pass shipped 7x7 with 1.8px
       * stroke in #c7c7cc (iOS *tertiary* text). On the panel's light-glass
       * surface (rgba(252,252,253,.78)), that color has ~1.4:1 contrast — well
       * below the "I can see it" threshold, so the chevron read as blank space
       * and the rotation animation was technically running but invisible.
       *
       * Current spec — picks Apple's *secondary* gray (#8e8e93, ~3.5:1 on the
       * panel surface) and bumps size to 9x9 with 2px stroke so the rotation
       * arc has enough pixel area to be perceived. Hover darkens further to
       * #1d1d1f for click-affordance. Animation: 280ms on Apple's signature
       * cubic-bezier(.32,.72,0,1) — closed = 45deg (points right ">"), open =
       * 135deg (points down "v"). The 90deg rotation is now visibly tracked
       * by the eye rather than instant-jumping past perception.
       *
       * Built from top+right borders rotated 45deg — no translate needed if
       * sized square; center anchoring keeps it aligned with the title baseline.
       *
       * will-change: transform hints the compositor to promote this to its own
       * GPU layer so the rotation doesn't paint-jank when the details element
       * simultaneously reflows its children on open/close.
       */
      #laplace-chatterbox-dialog summary::after {
        content: "";
        margin-left: auto;
        width: 9px;
        height: 9px;
        border-top: 2px solid #8e8e93;
        border-right: 2px solid #8e8e93;
        transform: rotate(45deg);
        transform-origin: center;
        /* 240ms: synchronized with details content height transition below.
         * Apple disclosure rotations are fully synced — not offset by 40ms
         * like Material stagger. The whole row moves as one motion. */
        transition: transform 240ms cubic-bezier(.32, .72, 0, 1),
                    border-color 160ms ease;
        will-change: transform;
        flex-shrink: 0;
      }

      #laplace-chatterbox-dialog details[open] > summary::after {
        transform: rotate(135deg);
      }

      #laplace-chatterbox-dialog summary:hover::after {
        border-top-color: #1d1d1f;
        border-right-color: #1d1d1f;
      }

      @media (prefers-reduced-motion: reduce) {
        #laplace-chatterbox-dialog summary::after {
          transition: none;
        }
      }

      #laplace-chatterbox-dialog button,
      #laplace-chatterbox-dialog select,
      #laplace-chatterbox-dialog input,
      #laplace-chatterbox-dialog textarea {
        outline: none !important;
        font: inherit;
      }

      #laplace-chatterbox-dialog button {
        appearance: none !important;
        min-height: 26px !important;
        border: 1px solid rgba(0, 0, 0, .08) !important;
        border-radius: 8px !important;
        background: rgba(255, 255, 255, .9) !important;
        color: #1d1d1f !important;
        padding: 3px 9px !important;
        cursor: pointer !important;
        font-weight: 560 !important;
        line-height: 1.3 !important;
        box-shadow: 0 1px 2px rgba(0, 0, 0, .05) !important;
      }

      #laplace-chatterbox-dialog button:hover {
        background: #fff !important;
        border-color: rgba(0, 0, 0, .14) !important;
      }

      #laplace-chatterbox-dialog button:active {
        transform: translateY(1px);
      }

      #laplace-chatterbox-dialog button:disabled,
      #laplace-chatterbox-dialog input:disabled,
      #laplace-chatterbox-dialog select:disabled {
        opacity: .46;
        cursor: not-allowed !important;
      }

      #laplace-chatterbox-dialog input[type="text"],
      #laplace-chatterbox-dialog input[type="password"],
      #laplace-chatterbox-dialog input[type="number"],
      #laplace-chatterbox-dialog select,
      #laplace-chatterbox-dialog textarea {
        border: 1px solid rgba(0, 0, 0, .08) !important;
        border-radius: 8px !important;
        background: rgba(255, 255, 255, .86) !important;
        color: #1d1d1f !important;
        padding: 5px 8px !important;
        box-shadow: inset 0 1px 2px rgba(0, 0, 0, .035) !important;
      }

      #laplace-chatterbox-dialog input[type="number"] {
        text-align: center;
        width: 64px !important;
        min-width: 64px !important;
      }

      #laplace-chatterbox-dialog textarea {
        line-height: 1.45 !important;
      }

      #laplace-chatterbox-dialog input:focus,
      #laplace-chatterbox-dialog select:focus,
      #laplace-chatterbox-dialog textarea:focus {
        border-color: var(--cb-accent) !important;
        box-shadow: 0 0 0 3px var(--cb-accent-soft), inset 0 1px 2px rgba(0, 0, 0, .03) !important;
      }

      /*
       * iOS-style pill toggle. Calibrated against Apple's UISwitch (51x31pt
       * thumb 27pt) scaled to ~78% so it fits the panel's compact density
       * without looking like a cheap clone. Previous spec was 30x18 — too
       * tight, thumb felt cramped against the track edges and the single-
       * stop shadow read flat. Improvements:
       *   - 40x24 track (was 30x18) gives breathing room
       *   - 20x20 thumb with 2px inset = 16px travel (matches translateX)
       *   - Off track: #e9e9eb (Apple's actual off color) — was #d1d1d6,
       *     too dark, fought with surrounding gray text
       *   - Two-stop thumb shadow (tight inner ambient + wider drop) gives
       *     a real "floating physical knob" feel
       *   - Apple's signature cubic-bezier(.32, .72, 0, 1) 240ms — snappier
       *     start, gentler settle than the default ease
       *   - Hover lifts background slightly (off) for clickable affordance
       */
      #laplace-chatterbox-dialog input[type="checkbox"] {
        appearance: none !important;
        width: 40px !important;
        height: 24px !important;
        flex: 0 0 40px;
        border: none !important;
        border-radius: 999px !important;
        background: #e9e9eb !important;
        padding: 0 !important;
        position: relative;
        cursor: pointer;
        box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .04) !important;
        transition: background 280ms cubic-bezier(.32, .72, 0, 1);
      }

      #laplace-chatterbox-dialog input[type="checkbox"]:hover:not(:checked):not(:disabled) {
        background: #dcdce0 !important;
      }

      #laplace-chatterbox-dialog input[type="checkbox"]::after {
        content: "";
        position: absolute;
        top: 2px;
        left: 2px;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        background: #fff;
        box-shadow:
          0 3px 1px rgba(0, 0, 0, .04),
          0 3px 8px rgba(0, 0, 0, .14),
          0 0 0 .5px rgba(0, 0, 0, .04);
        /*
         * Animate BOTH transform (slide) AND width (press-squish) on the same
         * Apple curve. Old version only transitioned transform — the :active
         * width:24px hop was instant and never read as a press response.
         * 200ms for the press is slightly shorter than the 240ms slide so the
         * squish feels snappier than the travel (matches iOS).
         */
        transition: transform 300ms cubic-bezier(.32, .72, 0, 1),
                    width 180ms cubic-bezier(.32, .72, 0, 1);
      }

      #laplace-chatterbox-dialog input[type="checkbox"]:active::after {
        /* Apple-style press: thumb stretches slightly toward the travel direction. */
        width: 24px;
      }

      #laplace-chatterbox-dialog input[type="checkbox"]:disabled {
        opacity: .45;
        cursor: not-allowed;
      }

      /*
       * Toggle ON-state uses the product brand color (--cb-accent), NOT iOS
       * system green.
       *
       * Why this matters: iOS uses green for system switches because the OS
       * has no single brand color — green is the universal "on" affordance.
       * Single-product UIs (Stripe, Linear, Vercel) use their accent for
       * switches instead, so the toggle reads as a piece of THE PRODUCT,
       * not as a borrowed Apple component. Our pre-token state had a blue
       * primary button + green toggle + 3 different greens for "active"
       * status text — chromatic chaos that telegraphed "I don't have a
       * brand." This commit picks one: iOS blue is everywhere a user takes
       * action or sees an active state.
       *
       * Green is preserved (--cb-success / --cb-success-text) for *system
       * feedback* — success toasts, "已配置/运行中" badges. Clear semantic
       * split: blue = "I am the product / this is an action"; green = "this
       * is healthy / this succeeded".
       */
      #laplace-chatterbox-dialog input[type="checkbox"]:checked {
        background: var(--cb-accent) !important;
      }

      #laplace-chatterbox-dialog input[type="checkbox"]:checked::after {
        /* Travel = trackWidth - thumbWidth - 2 * inset = 40 - 20 - 4 = 16px. */
        transform: translateX(16px);
      }

      #laplace-chatterbox-dialog input[type="checkbox"]:checked:active::after {
        /* When pressed in on-state, stretch leftward (toward travel-back direction). */
        transform: translateX(12px);
        width: 24px;
      }

      #laplace-chatterbox-dialog a {
        color: var(--cb-accent) !important;
        text-decoration: none !important;
      }

      /*
       * Panel header — the sticky top strip that replaces the old 4-Tab bar.
       * Holds room ID + WS dot + activity chips + ⚙ ⓘ icon buttons.
       * On settings/about sub-views the same surface holds a "← 返回" button.
       *
       * Sticks to the top of the scrolling dialog so status stays visible
       * regardless of scroll position. backdrop-filter mirrors the dialog's
       * own blur so it blends rather than introducing a hard surface seam.
       */
      #laplace-chatterbox-dialog .cb-panel-header {
        position: sticky;
        top: 0;
        z-index: 2;
        padding: 8px 10px;
        background: rgba(248, 248, 250, .92);
        backdrop-filter: blur(18px) saturate(1.4);
        -webkit-backdrop-filter: blur(18px) saturate(1.4);
        border-bottom: 1px solid rgba(0, 0, 0, .06);
      }

      #laplace-chatterbox-dialog .cb-panel-header--sub {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      #laplace-chatterbox-dialog .cb-panel-header-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }

      #laplace-chatterbox-dialog .cb-panel-header-status {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        min-width: 0;
      }

      #laplace-chatterbox-dialog .cb-panel-header-title {
        font-size: 13px;
        font-weight: 700;
        color: #1d1d1f;
      }

      #laplace-chatterbox-dialog .cb-panel-header-roomid {
        color: #6e6e73;
        font-size: 12px;
      }

      #laplace-chatterbox-dialog .cb-panel-header-ws {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        font-size: 11px;
      }

      #laplace-chatterbox-dialog .cb-panel-header-ws-dot {
        display: inline-block;
        width: 7px;
        height: 7px;
        border-radius: 50%;
      }

      #laplace-chatterbox-dialog .cb-panel-header-ws--ok { color: var(--cb-success-text); }
      #laplace-chatterbox-dialog .cb-panel-header-ws--ok .cb-panel-header-ws-dot { background: var(--cb-success-text); }
      #laplace-chatterbox-dialog .cb-panel-header-ws--bad { color: var(--cb-danger); }
      #laplace-chatterbox-dialog .cb-panel-header-ws--bad .cb-panel-header-ws-dot { background: var(--cb-danger); }
      #laplace-chatterbox-dialog .cb-panel-header-ws--idle { color: var(--cb-text-3); }
      #laplace-chatterbox-dialog .cb-panel-header-ws--idle .cb-panel-header-ws-dot { background: var(--cb-text-3); }
      /*
       * Connecting state: warning-orange dot that softly pulses so the user
       * sees "actively working, hold on". Pulse animates opacity (cheap,
       * GPU-friendly) — no layout cost. Respects prefers-reduced-motion via
       * the dialog-level @media block below by short-circuiting the keyframe.
       */
      #laplace-chatterbox-dialog .cb-panel-header-ws--connecting { color: var(--cb-warning-text); }
      #laplace-chatterbox-dialog .cb-panel-header-ws--connecting .cb-panel-header-ws-dot {
        background: var(--cb-warning);
        animation: cb-ws-dot-pulse 1.2s ease-in-out infinite;
      }
      @keyframes cb-ws-dot-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: .35; }
      }
      @media (prefers-reduced-motion: reduce) {
        #laplace-chatterbox-dialog .cb-panel-header-ws--connecting .cb-panel-header-ws-dot {
          animation: none;
        }
      }

      /*
       * Inline reconnect button shown next to "WS 断开". Status without an
       * action is sterile — Jobs's rule is: if you tell the user something
       * is wrong, give them the next click. Styled subtler than primary
       * buttons (transparent bg, brand-blue text) so it doesn't compete with
       * the section CTAs further down, but obvious enough to be clickable.
       */
      #laplace-chatterbox-dialog .cb-panel-header-reconnect {
        appearance: none;
        background: transparent !important;
        border: 1px solid var(--cb-accent) !important;
        color: var(--cb-accent) !important;
        font-size: 11px !important;
        padding: 1px 8px !important;
        min-height: 20px !important;
        border-radius: 999px !important;
        cursor: pointer;
        font-weight: 600;
        transition: background 160ms ease, color 160ms ease;
      }

      #laplace-chatterbox-dialog .cb-panel-header-reconnect:hover {
        background: var(--cb-accent-soft) !important;
      }

      #laplace-chatterbox-dialog .cb-panel-header-reconnect:active {
        background: var(--cb-accent) !important;
        color: #fff !important;
      }

      #laplace-chatterbox-dialog .cb-panel-header-actions {
        display: flex;
        gap: 4px;
        flex-shrink: 0;
      }

      #laplace-chatterbox-dialog .cb-panel-header-icon {
        padding: 2px 8px !important;
        font-size: 14px !important;
      }

      #laplace-chatterbox-dialog .cb-panel-header-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        margin-top: 6px;
      }

      #laplace-chatterbox-dialog .cb-panel-header-chip {
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 8px;
        color: #fff;
        line-height: 1.5;
      }

      #laplace-chatterbox-dialog .cb-panel-header-chip--on { background: #0a7f55; }
      #laplace-chatterbox-dialog .cb-panel-header-chip--dry { background: #a15c00; }

      #laplace-chatterbox-dialog .cb-panel-header .cb-ws-degraded-banner {
        margin-top: 6px;
        padding: 4px 6px;
        border-radius: 4px;
        background: rgba(255, 59, 48, .08);
        color: #a15c00;
        font-size: 11px;
        line-height: 1.4;
      }

      /*
       * Core feature group: a section that holds one core primitive card
       * (e.g. AutoSendControls) plus its visually-subordinate supporting
       * widget (e.g. MemesList as "pick template"). Tiny gap between siblings
       * inside the group communicates "they belong together".
       */
      #laplace-chatterbox-dialog .cb-core-group {
        margin: 0;
        padding: 0;
      }

      #laplace-chatterbox-dialog .cb-core-group + .cb-core-group {
        margin-top: 4px;
      }

      /*
       * Supporting feature: a <details>/<summary> below a core card, indented
       * to look hierarchically subordinate. Smaller font, dimmer surface so
       * it doesn't compete with the main card visually.
       */
      #laplace-chatterbox-dialog .cb-supporting-feature {
        margin: -3px 12px 8px !important;
        background: rgba(118, 118, 128, .06) !important;
        border: 1px solid rgba(0, 0, 0, .04) !important;
        border-top: 0 !important;
        border-radius: 0 0 8px 8px !important;
        box-shadow: none !important;
        font-size: 12px;
      }

      #laplace-chatterbox-dialog .cb-supporting-feature[open] {
        background: rgba(248, 248, 250, .85) !important;
      }

      #laplace-chatterbox-dialog .cb-supporting-feature > summary {
        min-height: 24px !important;
        padding: 4px 8px !important;
        font-size: 11px !important;
        font-weight: 500 !important;
        color: #6e6e73 !important;
        gap: 4px;
      }

      #laplace-chatterbox-dialog .cb-supporting-feature > summary:hover {
        color: #1d1d1f !important;
      }

      #laplace-chatterbox-dialog .cb-supporting-feature-icon {
        font-size: 11px;
        line-height: 1;
      }

      /* When opened, content padding inherits from details rules above. */

      /*
       * View transition animation. When the user clicks ⚙ / ⓘ to enter
       * settings/about (or ← to leave), the active view runs this entrance
       * keyframe. No exit animation — tab switches are fast enough that the
       * outgoing view disappearing instantly while the incoming one slides in
       * reads as a single smooth motion.
       *
       * Honor prefers-reduced-motion: users who set OS-level reduce-motion get
       * an instant cut.
       */
      #laplace-chatterbox-dialog .cb-view {
        animation: cb-view-enter 180ms cubic-bezier(0.2, 0.7, 0.2, 1);
      }

      @keyframes cb-view-enter {
        from {
          opacity: 0;
          transform: translateX(6px);
        }
        to {
          opacity: 1;
          transform: none;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        #laplace-chatterbox-dialog .cb-view {
          animation: none;
        }
      }

      /*
       * Disclosure-style link button. Used for "show advanced settings" toggle
       * and similar in-flow navigation elements that should NOT compete with
       * primary CTAs (开车 / 停车 / 发送 / 启用…) visually. Borderless, soft
       * gray, hover darkens.
       */
      #laplace-chatterbox-dialog button.cb-disclosure-link {
        appearance: none !important;
        background: transparent !important;
        border: 0 !important;
        box-shadow: none !important;
        padding: 4px 0 !important;
        min-height: 22px !important;
        font-size: 12px !important;
        font-weight: 500 !important;
        color: #6e6e73 !important;
        cursor: pointer;
        text-align: left;
      }

      #laplace-chatterbox-dialog button.cb-disclosure-link:hover {
        color: #1d1d1f !important;
        background: transparent !important;
      }

      #laplace-chatterbox-dialog button.cb-disclosure-link:active {
        transform: none;
      }

      /*
       * Emote picker popup (portaled to document.body — selectors are NOT
       * scoped under #laplace-chatterbox-dialog because the picker lives
       * outside the dialog's DOM subtree).
       *
       * Surface mirrors the dialog's iOS-style frosted look: white-ish bg in
       * light mode, dark gray in dark mode, soft border + shadow. z-index is
       * pinned to the same max int as the dialog so DOM order decides
       * stacking — picker is mounted AFTER the dialog so it wins. Combined
       * with the new flank-panel positioning, the picker never overlaps the
       * dialog visually in the first place; the z-index is just a safety net
       * for narrow viewports where flanking can't fit.
       */
      .cb-emote-picker {
        position: fixed;
        z-index: 2147483647;
        background: rgba(248, 248, 250, .96);
        border: 1px solid rgba(0, 0, 0, .08);
        border-radius: 8px;
        box-shadow: 0 22px 60px rgba(0, 0, 0, .24), 0 1px 0 rgba(255, 255, 255, .72) inset;
        backdrop-filter: blur(26px) saturate(1.5);
        -webkit-backdrop-filter: blur(26px) saturate(1.5);
        color: #1d1d1f;
        font-size: 12px;
        line-height: 1.4;
        display: flex;
        flex-direction: column;
        overflow: hidden;
        animation: cb-view-enter 160ms cubic-bezier(0.2, 0.7, 0.2, 1);
      }

      .cb-emote-picker--empty {
        min-height: 64px;
        padding: 12px;
        align-items: center;
        justify-content: center;
        gap: 6px;
        text-align: center;
        color: #6e6e73;
      }

      .cb-emote-picker--error {
        color: #a15c00;
      }

      .cb-emote-picker-retry {
        font-size: 11px;
        padding: 2px 8px;
        cursor: pointer;
        background: rgba(118, 118, 128, .12);
        border: 1px solid rgba(0, 0, 0, .1);
        border-radius: 6px;
        color: inherit;
      }

      .cb-emote-picker-retry:hover {
        background: rgba(118, 118, 128, .2);
      }

      .cb-emote-picker-tabs {
        display: flex;
        gap: 4px;
        padding: 6px 8px;
        border-bottom: 1px solid rgba(0, 0, 0, .06);
        overflow-x: auto;
        flex: 0 0 auto;
      }

      .cb-emote-picker-tab {
        padding: 3px 8px;
        font-size: 11px;
        line-height: 1.4;
        border: 1px solid rgba(0, 0, 0, .08);
        border-radius: 4px;
        background: rgba(118, 118, 128, .08);
        color: #555;
        cursor: pointer;
        white-space: nowrap;
        flex: 0 0 auto;
      }

      .cb-emote-picker-tab:hover {
        background: rgba(118, 118, 128, .16);
      }

      .cb-emote-picker-tab--active {
        background: #34c759;
        color: #fff;
        border-color: #2e8c73;
      }

      .cb-emote-picker-tab--active:hover {
        background: #34c759;
      }

      .cb-emote-picker-grid {
        flex: 1 1 auto;
        overflow-y: auto;
        padding: 8px;
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
        align-content: flex-start;
      }

      .cb-emote-picker-tile {
        position: relative;
        width: 52px;
        height: 52px;
        padding: 2px;
        border: 1px solid rgba(0, 0, 0, .06);
        border-radius: 6px;
        background: rgba(118, 118, 128, .06);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 120ms ease-out, transform 80ms ease-out;
      }

      .cb-emote-picker-tile:hover {
        background: rgba(118, 118, 128, .16);
      }

      .cb-emote-picker-tile:active {
        transform: scale(0.96);
      }

      .cb-emote-picker-tile img {
        max-width: 44px;
        max-height: 44px;
        object-fit: contain;
      }

      .cb-emote-picker-lock-badge {
        position: absolute;
        top: 1px;
        right: 1px;
        padding: 0 4px;
        font-size: 9px;
        line-height: 12px;
        color: #fff;
        border-radius: 2px;
        pointer-events: none;
        white-space: nowrap;
      }

      /*
       * Focus ring uses --cb-accent so it auto-flips between #007aff (light)
       * and #0a84ff (dark) — pre-token state hardcoded #0a84ff for both,
       * which read as too pale on light backgrounds and slightly violated
       * the contrast standard.
       */
      #laplace-chatterbox-dialog button:focus-visible,
      #laplace-chatterbox-dialog input[type="checkbox"]:focus-visible {
        outline: 2px solid var(--cb-accent) !important;
        outline-offset: 2px !important;
      }

      #laplace-chatterbox-dialog .cb-primary {
        background: var(--cb-accent) !important;
        color: #fff !important;
        border-color: var(--cb-accent) !important;
      }

      #laplace-chatterbox-dialog .cb-danger {
        background: var(--cb-danger) !important;
        color: #fff !important;
        border-color: var(--cb-danger) !important;
      }

      #laplace-chatterbox-dialog .cb-soft {
        color: var(--cb-text-2) !important;
      }

      #laplace-chatterbox-dialog .cb-row {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
      }

      #laplace-chatterbox-dialog .cb-stack {
        display: grid;
        /* minmax(0, 1fr) 而不是默认 auto——后者会用 max-content 撑大列，
           当 cb-stack 的子元素是 PromptManager / textarea / 长 select 时，
           整个 stack 会被撑出 cb-section 边界（实测 347 vs 291 px），
           导致面板水平滚动 / 内容被截。 */
        grid-template-columns: minmax(0, 1fr);
        gap: 6px;
      }

      #laplace-chatterbox-dialog .cb-body {
        padding: 0 9px 8px;
      }

      #laplace-chatterbox-dialog .cb-note {
        color: #6e6e73;
        font-size: 11px !important;
        line-height: 1.45;
      }

      #laplace-chatterbox-dialog .cb-label {
        color: #6e6e73;
        font-size: 11px !important;
        font-weight: 560;
      }

      #laplace-chatterbox-dialog .cb-panel {
        border: 1px solid rgba(0,0,0,.06);
        border-radius: 8px;
        background: rgba(248, 248, 250, .8);
        padding: 7px;
      }

      #laplace-chatterbox-dialog .cb-section {
        margin: 0 0 6px !important;
        padding: 7px !important;
        border: 1px solid rgba(0, 0, 0, .06) !important;
        border-radius: 8px !important;
        background: rgba(255, 255, 255, .72) !important;
        box-shadow: 0 1px 2px rgba(0, 0, 0, .04) !important;
      }

      #laplace-chatterbox-dialog .cb-heading {
        margin: 0 0 6px !important;
        color: #1d1d1f !important;
        font-weight: 650 !important;
      }

      #laplace-chatterbox-dialog .cb-empty {
        color: #8e8e93 !important;
        background: rgba(118, 118, 128, .08);
        border-radius: 8px;
        padding: 7px;
      }

      #laplace-chatterbox-dialog .cb-result {
        border: 1px solid rgba(0, 0, 0, .06) !important;
        border-radius: 8px !important;
        background: rgba(255, 255, 255, .82) !important;
        padding: 7px !important;
      }

      #laplace-chatterbox-dialog .cb-switch-row {
        display: flex !important;
        align-items: center !important;
        gap: 6px !important;
        min-height: 22px;
        line-height: 1.32;
      }

      #laplace-chatterbox-dialog .cb-setting-block {
        display: grid;
        gap: 5px;
        padding: 6px 0;
      }

      #laplace-chatterbox-dialog .cb-setting-block + .cb-setting-block {
        border-top: 1px solid rgba(0, 0, 0, .06);
      }

      #laplace-chatterbox-dialog .cb-setting-primary {
        padding: 6px 7px;
        border: 1px solid rgba(0, 0, 0, .055);
        border-left: 3px solid #007aff;
        border-radius: 8px;
        background: rgba(255, 255, 255, .68);
      }

      #laplace-chatterbox-dialog .cb-setting-row {
        justify-content: space-between;
        gap: 8px;
        min-height: 26px;
      }

      #laplace-chatterbox-dialog .cb-setting-row select {
        max-width: 178px;
        margin-left: auto;
      }

      #laplace-chatterbox-dialog .cb-setting-child[data-enabled="false"] {
        color: #8e8e93;
      }

      #laplace-chatterbox-dialog .cb-dependent-group {
        position: relative;
        margin-top: 1px;
        padding: 7px;
        border: 1px solid rgba(0, 0, 0, .055);
        border-left: 3px solid #34c759;
        border-radius: 8px;
        background: rgba(248, 248, 250, .7);
        transition: background .18s ease, border-color .18s ease, opacity .18s ease;
      }

      #laplace-chatterbox-dialog .cb-dependent-group[data-enabled="false"] {
        border-left-color: #c7c7cc;
        background: repeating-linear-gradient(
          -45deg,
          rgba(118, 118, 128, .06),
          rgba(118, 118, 128, .06) 6px,
          rgba(255, 255, 255, .52) 6px,
          rgba(255, 255, 255, .52) 12px
        );
      }

      #laplace-chatterbox-dialog .cb-dependent-group[data-enabled="false"]::before {
        content: attr(data-reason);
        justify-self: start;
        width: max-content;
        max-width: 100%;
        padding: 2px 6px;
        border-radius: 999px;
        background: rgba(118, 118, 128, .13);
        color: #6e6e73;
        font-size: 11px;
        font-weight: 620;
        line-height: 1.35;
      }

      #laplace-chatterbox-dialog .cb-accordion-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        margin-right: auto;
      }

      #laplace-chatterbox-dialog .cb-module-summary::after {
        margin-left: 2px;
      }

      #laplace-chatterbox-dialog .cb-module-state {
        flex: 0 0 auto;
        min-width: 32px;
        padding: 1px 6px;
        border-radius: 999px;
        border: 1px solid rgba(0, 0, 0, .06);
        background: rgba(118, 118, 128, .1);
        color: #6e6e73;
        font-size: 10px !important;
        font-weight: 720;
        line-height: 1.45;
        text-align: center;
      }

      #laplace-chatterbox-dialog .cb-module-state[data-active="true"] {
        border-color: rgba(52, 199, 89, .28);
        background: rgba(52, 199, 89, .14);
        color: #0a7f55;
      }

      #laplace-chatterbox-dialog .cb-subdetails {
        margin: 0 !important;
        border-color: rgba(0, 0, 0, .05) !important;
        background: rgba(248, 248, 250, .56) !important;
        box-shadow: none !important;
      }

      #laplace-chatterbox-dialog .cb-segment {
        display: grid;
        grid-auto-flow: column;
        grid-auto-columns: 1fr;
        gap: 4px;
        padding: 3px;
        border-radius: 8px;
        background: rgba(118, 118, 128, .12);
      }

      #laplace-chatterbox-dialog .cb-segment button {
        box-shadow: none !important;
        border-color: transparent !important;
        background: transparent !important;
        min-width: 0;
      }

      #laplace-chatterbox-dialog .cb-segment button[aria-pressed="true"] {
        background: #fff !important;
        color: #1d1d1f !important;
        box-shadow: 0 1px 3px rgba(0, 0, 0, .12) !important;
      }

      #laplace-chatterbox-dialog .cb-status-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        display: inline-block;
        background: currentColor;
      }

      #laplace-chatterbox-dialog .cb-list {
        display: grid;
        gap: 6px;
      }

      #laplace-chatterbox-dialog .cb-list-item {
        border-radius: 8px;
        background: rgba(255,255,255,.74);
        border: 1px solid rgba(0,0,0,.06);
        padding: 8px;
      }

      #laplace-chatterbox-dialog .cb-rule-list {
        display: grid;
        gap: 6px;
        max-height: 190px;
        overflow-y: auto;
      }

      #laplace-chatterbox-dialog .cb-rule-item {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 7px;
        align-items: center;
        border: 1px solid rgba(0,0,0,.06);
        border-radius: 8px;
        background: rgba(255,255,255,.7);
        padding: 7px;
      }

      #laplace-chatterbox-dialog .cb-rule-pair {
        min-width: 0;
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 7px;
      }

      #laplace-chatterbox-dialog .cb-rule-pair code {
        display: block;
        min-height: 24px;
        padding: 4px 6px;
        border-radius: 6px;
        background: rgba(118, 118, 128, .08);
        color: #1d1d1f;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        white-space: normal;
        word-break: break-all;
      }

      #laplace-chatterbox-dialog .cb-rule-form,
      #laplace-chatterbox-dialog .cb-rule-room-form {
        display: grid;
        grid-template-columns: 1fr 1fr auto;
        gap: 7px;
        align-items: end;
      }

      #laplace-chatterbox-dialog .cb-rule-form label,
      #laplace-chatterbox-dialog .cb-rule-room-form label {
        min-width: 0;
        display: grid;
        gap: 3px;
      }

      #laplace-chatterbox-dialog .cb-rule-form input,
      #laplace-chatterbox-dialog .cb-rule-room-form input,
      #laplace-chatterbox-dialog .cb-rule-room-form select {
        width: 100%;
        min-width: 0;
      }

      #laplace-chatterbox-dialog .cb-rule-room-actions {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }

      #laplace-chatterbox-dialog .cb-rule-remove {
        color: #ff3b30 !important;
      }

      #laplace-chatterbox-dialog .cb-icon-button {
        width: 28px !important;
        min-width: 28px !important;
        padding: 0 !important;
      }

      #laplace-chatterbox-dialog .cb-tag {
        background: var(--cb-tag-bg, #8e8e93) !important;
        color: #fff !important;
        border: none !important;
        box-shadow: none !important;
        min-height: 20px !important;
        border-radius: 5px !important;
        padding: 0 6px !important;
      }

      #laplace-chatterbox-dialog .cb-emote[data-copied="true"] {
        background: #34c759 !important;
        color: #fff !important;
      }

      @media (max-width: 420px) {
        #laplace-chatterbox-dialog .cb-rule-item,
        #laplace-chatterbox-dialog .cb-rule-form,
        #laplace-chatterbox-dialog .cb-rule-room-form {
          grid-template-columns: 1fr;
        }
      }

      /*
       * Dark mode override. Bilibili Live rooms are typically very dark
       * (the player background is near-black), so the default white-glass
       * panel is jarring at night. Honor the OS preference and darken the
       * surface, text, and component backgrounds. Color semantics (primary
       * #007aff → #0a84ff, danger #ff3b30 → #ff453a, success #34c759 →
       * #30d158) match Apple's iOS dark variant so accents read correctly.
       */
      @media (prefers-color-scheme: dark) {
        #laplace-chatterbox-toggle {
          background: rgba(20, 20, 22, .82) !important;
          color: #f5f5f7 !important;
          border-color: rgba(255, 255, 255, .14) !important;
          box-shadow: 0 10px 28px rgba(0, 0, 0, .6), inset 0 1px rgba(255, 255, 255, .12) !important;
        }

        #laplace-chatterbox-dialog {
          /* Dark-mode design token overrides — same semantic names as the
             light defaults, switched to iOS dark palette values. */
          --cb-accent: #0a84ff;
          --cb-success: #30d158;
          --cb-warning: #ff9f0a;
          --cb-danger: #ff453a;
          --cb-text: #f5f5f7;
          --cb-text-2: #98989d;
          --cb-text-3: #6e6e73;
          --cb-border: rgba(255, 255, 255, .12);
          --cb-border-soft: rgba(255, 255, 255, .08);
          --cb-surface: rgba(46, 46, 50, .82);
          --cb-surface-soft: rgba(40, 40, 44, .68);

          color: #f5f5f7 !important;
          background: rgba(28, 28, 30, .9) !important;
          border-color: rgba(255, 255, 255, .12) !important;
          box-shadow: 0 22px 60px rgba(0, 0, 0, .72), 0 1px 0 rgba(255, 255, 255, .08) inset !important;
        }

        #laplace-chatterbox-dialog details {
          border-color: rgba(255, 255, 255, .08) !important;
          background: rgba(40, 40, 44, .68) !important;
          box-shadow: 0 1px 0 rgba(255, 255, 255, .04) inset !important;
        }

        #laplace-chatterbox-dialog details[open] {
          background: rgba(46, 46, 50, .82) !important;
        }

        #laplace-chatterbox-dialog summary {
          color: #f5f5f7 !important;
        }

        /*
         * Dark mode: panel surface is rgba(28,28,30,.9). #98989d on that
         * yields ~3.8:1 — readable. Hover bumps to #f5f5f7 for click cue.
         * (Light-mode default #8e8e93 reads too dark here and disappears
         * into the dark glass; we need a *lighter* gray on dark.)
         */
        #laplace-chatterbox-dialog summary::after {
          border-top-color: #98989d;
          border-right-color: #98989d;
        }

        #laplace-chatterbox-dialog summary:hover::after {
          border-top-color: #f5f5f7;
          border-right-color: #f5f5f7;
        }

        #laplace-chatterbox-dialog button {
          background: rgba(58, 58, 62, .9) !important;
          color: #f5f5f7 !important;
          border-color: rgba(255, 255, 255, .1) !important;
          box-shadow: 0 1px 2px rgba(0, 0, 0, .3) !important;
        }

        #laplace-chatterbox-dialog button:hover {
          background: rgba(72, 72, 76, .95) !important;
          border-color: rgba(255, 255, 255, .18) !important;
        }

        #laplace-chatterbox-dialog input[type="text"],
        #laplace-chatterbox-dialog input[type="password"],
        #laplace-chatterbox-dialog input[type="number"],
        #laplace-chatterbox-dialog input[type="search"],
        #laplace-chatterbox-dialog select,
        #laplace-chatterbox-dialog textarea {
          background: rgba(46, 46, 50, .9) !important;
          color: #f5f5f7 !important;
          border-color: rgba(255, 255, 255, .12) !important;
          box-shadow: inset 0 1px 2px rgba(0, 0, 0, .25) !important;
        }

        #laplace-chatterbox-dialog input:focus,
        #laplace-chatterbox-dialog select:focus,
        #laplace-chatterbox-dialog textarea:focus {
          border-color: #0a84ff !important;
          box-shadow: 0 0 0 3px rgba(10, 132, 255, .26), inset 0 1px 2px rgba(0, 0, 0, .25) !important;
        }

        #laplace-chatterbox-dialog input[type="checkbox"] {
          background: #48484a !important;
          box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .06) !important;
        }

        #laplace-chatterbox-dialog input[type="checkbox"]:hover:not(:checked):not(:disabled) {
          background: #5a5a5e !important;
        }

        /*
         * Checked state inherits var(--cb-accent) from the dark-mode token
         * override above (#0a84ff). Same rationale as light mode: brand
         * accent rather than iOS system green so toggles read as part of
         * THIS product. No explicit override needed here.
         */

        #laplace-chatterbox-dialog .cb-panel-header {
          background: rgba(28, 28, 30, .92) !important;
          border-bottom-color: rgba(255, 255, 255, .08) !important;
        }

        #laplace-chatterbox-dialog .cb-panel-header-title {
          color: #f5f5f7 !important;
        }

        #laplace-chatterbox-dialog .cb-panel-header-roomid {
          color: #98989d !important;
        }

        #laplace-chatterbox-dialog .cb-panel-header-ws--ok { color: #30d158 !important; }
        #laplace-chatterbox-dialog .cb-panel-header-ws--ok .cb-panel-header-ws-dot { background: #30d158 !important; }
        #laplace-chatterbox-dialog .cb-panel-header-ws--bad { color: #ff453a !important; }
        #laplace-chatterbox-dialog .cb-panel-header-ws--bad .cb-panel-header-ws-dot { background: #ff453a !important; }
        #laplace-chatterbox-dialog .cb-panel-header-ws--idle { color: #98989d !important; }
        #laplace-chatterbox-dialog .cb-panel-header-ws--idle .cb-panel-header-ws-dot { background: #98989d !important; }

        #laplace-chatterbox-dialog .cb-panel-header-chip--on { background: #30d158 !important; color: #1d1d1f !important; }
        #laplace-chatterbox-dialog .cb-panel-header-chip--dry { background: #ff9f0a !important; color: #1d1d1f !important; }

        #laplace-chatterbox-dialog .cb-panel-header .cb-ws-degraded-banner {
          background: rgba(255, 69, 58, .14) !important;
          color: #ff9f0a !important;
        }

        #laplace-chatterbox-dialog .cb-supporting-feature {
          background: rgba(60, 60, 64, .35) !important;
          border-color: rgba(255, 255, 255, .04) !important;
        }

        #laplace-chatterbox-dialog .cb-supporting-feature[open] {
          background: rgba(46, 46, 50, .82) !important;
        }

        #laplace-chatterbox-dialog .cb-supporting-feature > summary {
          color: #98989d !important;
        }

        #laplace-chatterbox-dialog .cb-supporting-feature > summary:hover {
          color: #f5f5f7 !important;
        }

        #laplace-chatterbox-dialog button.cb-disclosure-link {
          color: #98989d !important;
        }

        #laplace-chatterbox-dialog button.cb-disclosure-link:hover {
          color: #f5f5f7 !important;
        }

        /*
         * Dark mode for the emote picker. Mirrors the dialog's dark palette
         * so the whole插件 reads as one product whether the user has light or
         * dark OS theme. Selectors are top-level (not scoped under
         * #laplace-chatterbox-dialog) because the picker is portaled to body.
         */
        .cb-emote-picker {
          background: rgba(28, 28, 30, .92) !important;
          border-color: rgba(255, 255, 255, .12) !important;
          color: #f5f5f7 !important;
          box-shadow: 0 22px 60px rgba(0, 0, 0, .72), 0 1px 0 rgba(255, 255, 255, .08) inset !important;
        }

        .cb-emote-picker--empty {
          color: #98989d !important;
        }

        .cb-emote-picker--error {
          color: #ff9f0a !important;
        }

        .cb-emote-picker-retry {
          background: rgba(72, 72, 76, .9) !important;
          border-color: rgba(255, 255, 255, .12) !important;
          color: #f5f5f7 !important;
        }

        .cb-emote-picker-retry:hover {
          background: rgba(90, 90, 94, .95) !important;
        }

        .cb-emote-picker-tabs {
          border-bottom-color: rgba(255, 255, 255, .08) !important;
        }

        .cb-emote-picker-tab {
          background: rgba(72, 72, 76, .5) !important;
          color: #98989d !important;
          border-color: rgba(255, 255, 255, .08) !important;
        }

        .cb-emote-picker-tab:hover {
          background: rgba(90, 90, 94, .7) !important;
        }

        .cb-emote-picker-tab--active {
          background: #30d158 !important;
          color: #1d1d1f !important;
          border-color: #30d158 !important;
        }

        .cb-emote-picker-tab--active:hover {
          background: #30d158 !important;
        }

        .cb-emote-picker-tile {
          background: rgba(60, 60, 64, .5) !important;
          border-color: rgba(255, 255, 255, .06) !important;
        }

        .cb-emote-picker-tile:hover {
          background: rgba(80, 80, 84, .7) !important;
        }

        /*
         * Dark mode .cb-primary / .cb-danger inherit from the light-mode
         * rules, which already read --cb-accent and --cb-danger. The dark
         * mode token block above redefines those values to #0a84ff /
         * #ff453a, so no explicit override is needed. Removing them
         * collapses the dark-mode branch to "tokens only" — fewer places
         * to drift out of sync.
         */

        #laplace-chatterbox-dialog .cb-soft,
        #laplace-chatterbox-dialog .cb-note,
        #laplace-chatterbox-dialog .cb-label {
          color: #98989d !important;
        }

        #laplace-chatterbox-dialog .cb-panel {
          background: rgba(40, 40, 44, .72) !important;
          border-color: rgba(255, 255, 255, .08) !important;
        }

        #laplace-chatterbox-dialog .cb-section {
          background: rgba(40, 40, 44, .58) !important;
          border-color: rgba(255, 255, 255, .08) !important;
          box-shadow: 0 1px 2px rgba(0, 0, 0, .25) !important;
        }

        #laplace-chatterbox-dialog .cb-heading {
          color: #f5f5f7 !important;
        }

        #laplace-chatterbox-dialog .cb-empty {
          color: #98989d !important;
          background: rgba(118, 118, 128, .18);
        }

        #laplace-chatterbox-dialog .cb-result {
          background: rgba(40, 40, 44, .72) !important;
          border-color: rgba(255, 255, 255, .08) !important;
        }

        #laplace-chatterbox-dialog .cb-segment {
          background: rgba(118, 118, 128, .26);
        }

        #laplace-chatterbox-dialog .cb-segment button[aria-pressed="true"] {
          background: rgba(72, 72, 76, .95) !important;
          color: #f5f5f7 !important;
          box-shadow: 0 1px 3px rgba(0, 0, 0, .4) !important;
        }

        #laplace-chatterbox-dialog .cb-rule-pair code {
          background: rgba(118, 118, 128, .22);
          color: #f5f5f7;
        }

        #laplace-chatterbox-dialog .cb-list-item {
          background: rgba(40, 40, 44, .72);
          border-color: rgba(255, 255, 255, .08);
        }

        #laplace-chatterbox-dialog .cb-setting-primary {
          background: rgba(40, 40, 44, .58);
          border-left-color: #0a84ff;
          border-color: rgba(255, 255, 255, .08);
        }

        #laplace-chatterbox-dialog .cb-dependent-group {
          background: rgba(40, 40, 44, .56);
          border-color: rgba(255, 255, 255, .08);
        }

        #laplace-chatterbox-dialog .cb-module-state {
          background: rgba(118, 118, 128, .22);
          color: #98989d;
          border-color: rgba(255, 255, 255, .06);
        }

        #laplace-chatterbox-dialog .cb-module-state[data-active="true"] {
          background: rgba(48, 209, 88, .22);
          color: #30d158;
          border-color: rgba(48, 209, 88, .32);
        }

        #laplace-chatterbox-dialog a {
          color: #0a84ff !important;
        }
      }

      /*
       * Floating surfaces that live OUTSIDE #laplace-chatterbox-dialog:
       * error boundary, onboarding, user notices, shadow-bypass chip.
       * They share the same light-glass / dark-glass treatment so they
       * stay legible against B站's near-black player background.
       */
      .cb-floating-surface {
        color: #1d1d1f;
        background: rgba(255, 255, 255, .96);
        border: 1px solid rgba(60, 60, 67, .18);
        border-radius: 8px;
        box-shadow: 0 18px 48px rgba(0, 0, 0, .22);
        backdrop-filter: blur(22px) saturate(1.4);
        -webkit-backdrop-filter: blur(22px) saturate(1.4);
      }
      .cb-floating-soft {
        color: #555;
      }
      .cb-floating-softer {
        color: #666;
      }
      .cb-floating-chip-meta {
        color: #888;
      }
      .cb-floating-code {
        background: #f5f5f5;
        color: #1d1d1f;
      }
      .cb-floating-divider {
        color: #666;
      }
      .cb-floating-notice-btn {
        background: #fff;
      }
      .cb-error-surface {
        background: #fff7f7;
        color: #7f1d1d;
        border-color: #f3b7b7;
      }
      .cb-ws-degraded-banner {
        grid-column: 1 / -1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        margin: 4px 0 0;
        padding: 2px 6px;
        border-radius: 999px;
        background: rgba(255, 149, 0, .14);
        color: #a15c00;
        font-size: 11px;
        font-weight: 620;
        line-height: 1.4;
      }

      @media (prefers-color-scheme: dark) {
        .cb-floating-surface {
          color: #f5f5f7;
          background: rgba(28, 28, 30, .92);
          border-color: rgba(255, 255, 255, .12);
          box-shadow: 0 22px 60px rgba(0, 0, 0, .72), 0 1px 0 rgba(255, 255, 255, .08) inset;
        }
        .cb-floating-soft {
          color: #c7c7cc;
        }
        .cb-floating-softer {
          color: #98989d;
        }
        .cb-floating-chip-meta {
          color: #98989d;
        }
        .cb-floating-code {
          background: rgba(118, 118, 128, .26);
          color: #f5f5f7;
        }
        .cb-floating-divider {
          color: #98989d;
        }
        .cb-floating-notice-btn {
          background: rgba(58, 58, 62, .9);
          color: #f5f5f7;
        }
        .cb-error-surface {
          background: rgba(60, 24, 24, .92);
          color: #ff6b6b;
          border-color: rgba(255, 107, 107, .35);
        }
        .cb-ws-degraded-banner {
          background: rgba(255, 159, 10, .22);
          color: #ffb454;
        }
      }
    `
function currentLiveRoomSlug(): string | null {
  try {
    return extractRoomNumber(window.location.href) ?? null
  } catch {
    return null
  }
}
/**
 * Inject PANEL_STYLE into the document.
 *
 * Idempotent: tags injected by this function carry `data-cb-panel-style`.
 * On every call we remove any existing tags with that marker before adding
 * a fresh one. Without this, Vite HMR reloads of `app-lifecycle.ts` re-run
 * the module init, each call appends another `<style>`, and after a few
 * edits the document has 4+ overlapping copies of PANEL_STYLE — CSS
 * cascading then picks the "last matching rule" from a different copy
 * than expected, breaking interactive states (e.g. `:checked::after`
 * transform fights between old and new rules → toggle thumbs don't slide
 * on click because the same translateX(16px) is applied in both states).
 *
 * Production (Tampermonkey via GM_addStyle): same idempotency — we wrap
 * GM_addStyle so the marker convention applies to both paths. GM_addStyle
 * returns a `<style>` element in most engines; we tag it after the fact.
 */
const PANEL_STYLE_MARKER = 'data-cb-panel-style'
export function installPanelStyles(): () => void {
  // Always remove existing marked tags first.
  for (const existing of document.querySelectorAll(`style[${PANEL_STYLE_MARKER}]`)) {
    existing.remove()
  }
  if (typeof GM_addStyle === 'function') {
    // Snapshot pre-existing <style> tags so we can robustly identify the new
    // one GM_addStyle just appended — even on engines whose GM_addStyle
    // returns void (older GreaseMonkey) or where another module's <style>
    // happened to be appended concurrently between this call and the next
    // microtask. Previous "grab the last <style> in document" heuristic
    // would mis-tag the wrong element on HMR + concurrent injections, so
    // the marker would end up on Bilibili's or Vite's stylesheet and the
    // *next* call's wipe loop would leave our stale copy stacked.
    const before = new Set(document.querySelectorAll('style'))
    const injected = GM_addStyle(PANEL_STYLE) as unknown
    let styleEl: HTMLStyleElement | undefined
    if (injected instanceof HTMLStyleElement) {
      styleEl = injected
    } else {
      for (const candidate of document.querySelectorAll('style')) {
        if (!before.has(candidate)) {
          styleEl = candidate as HTMLStyleElement
          break
        }
      }
    }
    if (styleEl) styleEl.setAttribute(PANEL_STYLE_MARKER, '')
    return () => {
      styleEl?.remove()
    }
  }
  const style = document.createElement('style')
  style.setAttribute(PANEL_STYLE_MARKER, '')
  style.textContent = PANEL_STYLE
  ;(document.head || document.documentElement).appendChild(style)
  return () => style.remove()
}
export function startCustomChatRoomRearm(): () => void {
  let disposed = false
  let offTimer: ReturnType<typeof setTimeout> | null = null
  let onTimer: ReturnType<typeof setTimeout> | null = null
  let serial = 0
  let lastRoomSlug: string | null = null
  const clearTimers = () => {
    if (offTimer) {
      clearTimeout(offTimer)
      offTimer = null
    }
    if (onTimer) {
      clearTimeout(onTimer)
      onTimer = null
    }
  }
  const applyDesiredCustomChatDefaults = () => {
    customChatHideNative.value = false
    customChatUseWs.value = true
  }
  let rearming = false
  const rearmCustomChat = () => {
    serial += 1
    const runId = serial
    clearTimers()
    rearming = true
    applyDesiredCustomChatDefaults()
    customChatEnabled.value = true
    offTimer = setTimeout(() => {
      if (disposed || runId !== serial) return
      customChatEnabled.value = false
    }, CUSTOM_CHAT_REARM_OFF_DELAY_MS)
    onTimer = setTimeout(() => {
      if (disposed || runId !== serial) return
      applyDesiredCustomChatDefaults()
      customChatEnabled.value = true
      rearming = false
    }, CUSTOM_CHAT_REARM_ON_DELAY_MS)
  }
  const handleLocationMaybeChanged = (force = false) => {
    const roomSlug = currentLiveRoomSlug()
    if (!roomSlug) {
      lastRoomSlug = null
      return
    }
    if (!force && roomSlug === lastRoomSlug) return
    lastRoomSlug = roomSlug
    if (!customChatEnabled.value) return
    rearmCustomChat()
  }
  let prevEnabled = customChatEnabled.peek()
  const stopEnabledWatcher = effect(() => {
    const next = customChatEnabled.value
    const wasEnabled = prevEnabled
    prevEnabled = next
    if (!wasEnabled && next && !rearming) {
      rearmCustomChat()
    }
  })
  const scheduleLocationCheck = () => {
    window.setTimeout(handleLocationMaybeChanged, 0)
  }
  const originalPushState = window.history.pushState.bind(window.history)
  const originalReplaceState = window.history.replaceState.bind(window.history)
  window.history.pushState = ((...args: Parameters<History['pushState']>) => {
    originalPushState(...args)
    scheduleLocationCheck()
  }) as History['pushState']
  window.history.replaceState = ((...args: Parameters<History['replaceState']>) => {
    originalReplaceState(...args)
    scheduleLocationCheck()
  }) as History['replaceState']
  window.addEventListener('popstate', handleLocationMaybeChanged)
  window.addEventListener('hashchange', handleLocationMaybeChanged)
  const roomWatcher = window.setInterval(handleLocationMaybeChanged, 1000)
  handleLocationMaybeChanged(true)
  return () => {
    disposed = true
    clearTimers()
    stopEnabledWatcher()
    window.history.pushState = originalPushState
    window.history.replaceState = originalReplaceState
    window.removeEventListener('popstate', handleLocationMaybeChanged)
    window.removeEventListener('hashchange', handleLocationMaybeChanged)
    clearInterval(roomWatcher)
  }
}
export function installOptimizedLayoutStyle(): () => void {
  const stale = document.querySelector<HTMLElement>('.app-body')
  if (stale?.style.marginLeft === '1rem') stale.style.marginLeft = ''
  if (!optimizeLayout.value) return () => {}
  const style = document.createElement('style')
  style.textContent = '.app-body { margin-left: 1rem !important; }'
  document.head.appendChild(style)
  return () => style.remove()
}

/**
 * 启动期 + 启用切换时自动探测 chatterbox-cloud 的 /health,把结果写入
 * `cbBackendHealthState` 让设置区块的状态点能常驻显示。
 *
 * 触发时机:
 *  - `cbBackendEnabled` 由 false→true(用户刚打开开关)
 *  - `cbBackendUrlOverride` 在启用状态下变化(开发期切换 prod ↔ localhost)
 *  - 关闭开关后状态回到 'idle',下一次打开重新探测
 *
 * 不轮询,不在用户没启用时发任何请求。
 */
export function startCbBackendHealthProbe(): () => void {
  let lastBaseProbed = ''
  return effect(() => {
    if (!cbBackendEnabled.value) {
      cbBackendHealthState.value = 'idle'
      lastBaseProbed = ''
      return
    }
    const currentBase = cbBackendUrlOverride.value.trim()
    if (currentBase === lastBaseProbed && cbBackendHealthState.peek() !== 'idle') return
    lastBaseProbed = currentBase
    void probeAndUpdateCbBackendHealth()
  })
}
