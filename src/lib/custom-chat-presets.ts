/**
 * Custom-CSS 预设集合(Jobs 式 #1+#20 视觉 polish 的一部分)。
 *
 * 设计原则:每个 preset 是一份完整的 CSS 字符串,用户可以一键 apply 到设置里的
 * "自定义 CSS"文本框,再自由微调。preset 之间走截然不同的方向(奶绿低饱和
 * vs 午夜深蓝高对比),展示视觉系统的弹性,但都遵循统一的 css 变量协议
 * (`--lc-chat-*` / `--lc-gift-*` / `--lc-guard-*-*` 等)。
 *
 * 详细 design direction(色彩、层级、间距哲学)见
 * [docs/chatterbox-chat-design-direction.md](../../docs/chatterbox-chat-design-direction.md)。
 */

// IMPORTANT — Cascade Layer & Specificity Notes
// ───────────────────────────────────────────────
// 1) **No `@layer` wrapper.** Per CSS Cascading Level 5, ANY unlayered author
//    style beats ALL layered author styles regardless of specificity / source
//    order. Baseline `custom-chat-style.ts` is unlayered, so wrapping presets
//    in `@layer chatterbox-custom-css { … }` makes them lose every variable
//    fight against baseline. We learned this the hard way when both presets
//    silently fell back to baseline colors in production
//    (`tmp/chat-preview/` audit, 2026-05-17). Keep these presets unlayered.
// 2) **Selectors use `#laplace-custom-chat[data-theme]`** instead of bare
//    `#laplace-custom-chat` so they tie with the baseline laplace/compact
//    variant `#laplace-custom-chat[data-theme="laplace"]` on specificity.
//    Source order (preset `<style>` is appended after baseline `<style>`)
//    then breaks the tie in the preset's favor. With bare `#laplace-custom-chat`
//    (0,1,0,0) the preset loses to baseline's `[data-theme]` selector (0,1,1,0)
//    even when unlayered — so the dark-theme path stays broken.
// 3) **`@import` is fine** but the sanitizer strips it when this CSS comes
//    from the user-CSS textarea (defense-in-depth against arbitrary remote
//    fetches). The button injection path (preset → textarea) keeps the
//    @import line for users who want the Google font; sanitization removes
//    it for safety. Without the font, the preset still renders fine using
//    the system-ui fallback in `--lc-chat-font`.
//
// Concretely: changing the selector prefix or re-adding `@layer` here will
// silently break every color variable in this preset. Run
// `bun tmp/chat-preview/gen-preview.mjs` and open `chat-milk.html` /
// `chat-midnight.html` to verify with `getComputedStyle` if you touch this.

export const MILK_GREEN_IMESSAGE_CSS = `/* Chatterbox 奶绿 iMessage × Laplace 气泡 */
@import url('https://fonts.googleapis.com/css2?family=Jost:wght@400;600;700;800&display=swap');

#laplace-custom-chat[data-theme] {
    --lc-chat-font: 'Jost', -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
    --lc-chat-bg: #eef7f1;
    --lc-chat-panel: rgba(248, 253, 249, .86);
    --lc-chat-border: rgba(63, 103, 79, .15);
    --lc-chat-text: #1e3427;
    --lc-chat-muted: #6d8273;
    --lc-chat-name: #248a61;
    --lc-chat-bubble: #f7fff9;
    --lc-chat-bubble-text: #213d2b;
    --lc-chat-own: #2f9b70;
    --lc-chat-own-text: #fff;
    --lc-chat-chip: rgba(78, 141, 104, .14);
    --lc-chat-chip-text: #21422f;
    --lc-chat-accent: #34c759;
    --lc-chat-shadow: rgba(36, 74, 48, .16);
    --lc-chat-bubble-shadow: 0 1px 1px rgba(36, 74, 48, .05), 0 8px 22px rgba(36, 74, 48, .12);
    --lc-chat-lite: rgba(116, 159, 131, .16);
    --lc-chat-lite-text: #58715f;
    --lc-chat-medal-bg: #f7e7a8;
    --lc-chat-medal-text: #5c4210;
    --lc-chat-guard-bg: #c8ddfc;
    --lc-chat-guard-text: #1d4b86;
    --lc-chat-admin-bg: #d7ebff;
    --lc-chat-admin-text: #075d9a;
    --lc-chat-rank-bg: #ffe4a1;
    --lc-chat-rank-text: #704400;
    --lc-chat-ul-bg: #e6dcfa;
    --lc-chat-ul-text: #543579;
    --lc-chat-honor-bg: #d8f1df;
    --lc-chat-honor-text: #1d633c;
    --lc-chat-price-bg: #ffe0cc;
    --lc-chat-price-text: #7f3516;
    --lc-event-text: #213d2b;
    --lc-event-bg: #f1fbf5;
    --lc-gift-bg: linear-gradient(135deg, #ffe0cc, #fff3cd);
    --lc-gift-text: #4a2618;
    --lc-superchat-bg: linear-gradient(135deg, #2f80ed, #47d18c);
    --lc-superchat-text: #fff;
    /* Match the SC gradient: blue hairline at the cooler endpoint, mint
       outer halo at the warmer endpoint. Replaces baseline's red glow,
       which clashed with the green/mint SC bubble. */
    --lc-superchat-glow:
      0 1px 0 rgba(255, 255, 255, .28) inset,
      0 0 0 1px rgba(47, 128, 237, .28),
      0 12px 32px rgba(71, 209, 140, .36);
    --lc-guard-3-bg: linear-gradient(135deg, #c8ddfc, #d8f1df);
    --lc-guard-2-bg: linear-gradient(135deg, #e9ccf0, #d8f1df);
    --lc-guard-1-bg: linear-gradient(135deg, #ffd7c2, #f5e19e);
    --lc-redpacket-bg: linear-gradient(135deg, #ffb3bd, #ffe6a7);
    --lc-lottery-bg: linear-gradient(135deg, #bde5d1, #c8ddfc);
  }

  #laplace-custom-chat[data-theme],
  #laplace-custom-chat[data-theme] * {
    font-family: var(--lc-chat-font);
  }

  #laplace-custom-chat[data-theme] .lc-chat-list {
    background-image:
      linear-gradient(45deg, rgba(255,255,255,.46) 25%, transparent 25%),
      linear-gradient(-45deg, rgba(255,255,255,.46) 25%, transparent 25%),
      linear-gradient(45deg, transparent 75%, rgba(255,255,255,.46) 75%),
      linear-gradient(-45deg, transparent 75%, rgba(255,255,255,.46) 75%);
    background-size: 18px 18px;
    background-position: 0 0, 0 9px, 9px -9px, -9px 0;
    -webkit-mask-image: linear-gradient(to bottom, transparent, #000 24px, #000 calc(100% - 24px), transparent);
    mask-image: linear-gradient(to bottom, transparent, #000 24px, #000 calc(100% - 24px), transparent);
  }

  #laplace-custom-chat[data-theme] .lc-chat-message {
    transition: .24s color ease, .24s background-color ease, .24s opacity ease;
  }

  #laplace-custom-chat[data-theme] .lc-chat-avatar {
    box-shadow: 0 0 0 2px rgba(255, 255, 255, .72), 0 2px 8px rgba(36, 74, 48, .16);
  }

  #laplace-custom-chat[data-theme] .lc-chat-name {
    color: #21976a;
    font-weight: 800;
    text-shadow: 0 0 2px rgba(238, 247, 241, .8);
  }

  #laplace-custom-chat[data-theme] .lc-chat-time {
    color: #7b8e82;
  }

  #laplace-custom-chat[data-theme] .lc-chat-bubble {
    color: var(--lc-event-text);
    background: var(--lc-event-bg);
    font-weight: 700;
    filter: drop-shadow(0 0 1px rgba(33, 61, 43, .24));
  }

  #laplace-custom-chat[data-theme] .lc-chat-bubble::before {
    background: var(--lc-event-bg);
    border-color: rgba(63, 103, 79, .12);
  }

  #laplace-custom-chat[data-theme] .lc-chat-reply {
    color: #15945f;
  }

  #laplace-custom-chat[data-theme] .lc-chat-medal {
    max-width: min(13em, 72%);
    text-shadow: none;
  }

  #laplace-custom-chat[data-theme] .lc-chat-badge[data-badge-type="medal"] {
    color: var(--lc-chat-medal-text);
    background: var(--lc-chat-medal-bg);
  }

  #laplace-custom-chat[data-theme] .lc-chat-badge[data-badge-type="guard"] {
    color: var(--lc-chat-guard-text);
    background: var(--lc-chat-guard-bg);
  }

  #laplace-custom-chat[data-theme] .lc-chat-badge[data-badge-type="admin"] {
    color: var(--lc-chat-admin-text);
    background: var(--lc-chat-admin-bg);
  }

  #laplace-custom-chat[data-theme] .lc-chat-badge[data-badge-type="rank"] {
    color: var(--lc-chat-rank-text);
    background: var(--lc-chat-rank-bg);
  }

  #laplace-custom-chat[data-theme] .lc-chat-badge[data-badge-type="ul"] {
    color: var(--lc-chat-ul-text);
    background: var(--lc-chat-ul-bg);
  }

  #laplace-custom-chat[data-theme] .lc-chat-badge[data-badge-type="honor"] {
    color: var(--lc-chat-honor-text);
    background: var(--lc-chat-honor-bg);
  }

  #laplace-custom-chat[data-theme] .lc-chat-badge[data-badge-type="price"] {
    color: var(--lc-chat-price-text);
    background: var(--lc-chat-price-bg);
  }

  #laplace-custom-chat[data-theme] .lc-chat-kind,
  #laplace-custom-chat[data-theme] .lc-chat-card-mark {
    color: #21422f;
    background: rgba(255, 255, 255, .5);
  }

  #laplace-custom-chat[data-theme] .lc-chat-card-event .lc-chat-bubble {
    min-width: min(18em, 100%);
    padding: 11px 15px;
    border-radius: 20px;
    border-bottom-left-radius: 8px;
    filter: drop-shadow(0 1px 2px rgba(36, 74, 48, .18));
  }

  #laplace-custom-chat[data-theme] .lc-chat-card-event .lc-chat-bubble::before {
    background: inherit;
  }

  #laplace-custom-chat[data-theme] .lc-chat-card-title {
    font-weight: 800;
  }

  #laplace-custom-chat[data-theme] .lc-chat-card-field {
    background: rgba(255, 255, 255, .42);
  }

  #laplace-custom-chat[data-theme] .lc-chat-card-field[data-field$="price"],
  #laplace-custom-chat[data-theme] .lc-chat-card-field[data-kind="money"] {
    color: #855118;
  }

  #laplace-custom-chat[data-theme] .lc-chat-card-field[data-field$="count"],
  #laplace-custom-chat[data-theme] .lc-chat-card-field[data-kind="count"] {
    color: #24523a;
  }

  #laplace-custom-chat[data-theme] .lc-chat-event-debug {
    color: #24523a;
    background: rgba(214, 239, 224, .92);
  }

  #laplace-custom-chat[data-theme] .lc-chat-card-event[data-card="gift"] .lc-chat-bubble {
    color: var(--lc-gift-text);
    background: var(--lc-gift-bg);
  }

  #laplace-custom-chat[data-theme] .lc-chat-card-event[data-card="superchat"] .lc-chat-bubble {
    color: var(--lc-superchat-text);
    background: var(--lc-superchat-bg);
  }

  #laplace-custom-chat[data-theme] .lc-chat-card-event[data-card="guard"] .lc-chat-bubble {
    color: #173b28;
    background: var(--lc-guard-3-bg);
  }

  #laplace-custom-chat[data-theme] .lc-chat-card-event[data-guard="2"] .lc-chat-bubble {
    color: #43205c;
    background: var(--lc-guard-2-bg);
  }

  #laplace-custom-chat[data-theme] .lc-chat-card-event[data-guard="1"] .lc-chat-bubble {
    color: #4d2318;
    background: var(--lc-guard-1-bg);
  }

  #laplace-custom-chat[data-theme] .lc-chat-card-event[data-card="redpacket"] .lc-chat-bubble {
    color: #4d2318;
    background: var(--lc-redpacket-bg);
  }

  #laplace-custom-chat[data-theme] .lc-chat-card-event[data-card="lottery"] .lc-chat-bubble {
    color: #173b28;
    background: var(--lc-lottery-bg);
  }

  #laplace-custom-chat[data-theme] .lc-chat-message[data-kind="follow"] .lc-chat-bubble,
  #laplace-custom-chat[data-theme] .lc-chat-message[data-kind="like"] .lc-chat-bubble,
  #laplace-custom-chat[data-theme] .lc-chat-message[data-kind="share"] .lc-chat-bubble,
  #laplace-custom-chat[data-theme] .lc-chat-message[data-kind="enter"] .lc-chat-bubble,
  #laplace-custom-chat[data-theme] .lc-chat-message[data-kind="notice"] .lc-chat-bubble,
  #laplace-custom-chat[data-theme] .lc-chat-message[data-priority="lite"] .lc-chat-bubble {
    color: #24523a;
    background: rgba(189, 229, 209, .72);
  }

  #laplace-custom-chat[data-theme] .lc-chat-actions {
    filter: drop-shadow(0 1px 2px rgba(36, 74, 48, .16));
  }

  #laplace-custom-chat[data-theme] .lc-chat-action,
  #laplace-custom-chat[data-theme] .lc-chat-send {
    color: #fff;
    background: #2f9b70;
  }

  #laplace-custom-chat[data-theme] .lc-chat-perf {
    color: #24523a;
    background: rgba(214, 239, 224, .8);
  }
`

/**
 * 午夜深蓝 iMessage 预设 (Jobs 式 #1+#20 视觉 polish 的第二份)。
 *
 * 与奶绿 (MILK_GREEN) 的关系:
 *  - 奶绿走"日间、柔和、低饱和、薄荷气息" —— 适合白天直播、家庭友好场景。
 *  - 午夜深蓝走"夜晚、深邃、高对比、霓虹点缀" —— 适合深夜直播、二次元 / VTuber 房间。
 *
 * 两份共享同一组 CSS 变量协议(--lc-chat-bg / --lc-chat-bubble / --lc-gift-bg
 * / --lc-guard-1/2/3-bg / --lc-superchat-bg ...),用户可以挑一份作为起点
 * 再微调自己的颜色变体。
 *
 * 设计要点:
 *  - 背景用 #0c1228 (近黑深蓝) 而不是纯黑——OLED 上更不显屏 banding,
 *    LCD 上也保留景深。
 *  - 主气泡用 #1a2444(微微偏暖的深蓝灰),与背景拉开 1 级 depth。
 *  - own bubble 用 iOS Tinted Indigo (#5e5ce6) 实底,白字最大对比。
 *  - SC 用电光蓝 → 紫红 gradient,模拟 iOS Lock Screen "Hero Photo" 调子。
 *  - Guard 1/2/3 用渐变金 / 渐变樱粉 / 渐变青蓝,跟 SC 不撞色但保留尊贵感。
 *  - 文字字重稍重(600 而不是 500),小字号在深色 BG 上才不糊。
 *  - 阴影改用 inset 高光 + 1px outer glow,避免传统 drop-shadow 在深色 BG
 *    上看不见的尴尬。
 */
export const MIDNIGHT_INDIGO_IMESSAGE_CSS = `/* Chatterbox 午夜深蓝 iMessage × iOS 18 Tinted */
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@500;600;700;800&display=swap');

#laplace-custom-chat[data-theme] {
    --lc-chat-font: 'Inter', -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
    --lc-chat-bg: #0c1228;
    --lc-chat-panel: rgba(20, 28, 56, .82);
    --lc-chat-border: rgba(120, 140, 220, .12);
    --lc-chat-text: #e4e7f4;
    --lc-chat-muted: #8590b8;
    --lc-chat-name: #8ca6ff;
    --lc-chat-bubble: #1a2444;
    --lc-chat-bubble-text: #e7ebfa;
    --lc-chat-own: #5e5ce6;
    --lc-chat-own-text: #fff;
    --lc-chat-chip: rgba(140, 166, 255, .14);
    --lc-chat-chip-text: #c6d2ff;
    --lc-chat-accent: #7c7afe;
    --lc-chat-shadow: rgba(0, 0, 0, .5);
    --lc-chat-bubble-shadow: 0 1px 0 rgba(255, 255, 255, .04) inset, 0 6px 18px rgba(0, 0, 0, .35);
    --lc-chat-lite: rgba(124, 122, 254, .14);
    --lc-chat-lite-text: #b6b8ec;
    --lc-chat-medal-bg: #4a3a08;
    --lc-chat-medal-text: #ffd76a;
    --lc-chat-guard-bg: #1f3a6e;
    --lc-chat-guard-text: #aac4ff;
    --lc-chat-admin-bg: #0c3a64;
    --lc-chat-admin-text: #7fc2ff;
    --lc-chat-rank-bg: #4a2f08;
    --lc-chat-rank-text: #ffc56a;
    --lc-chat-ul-bg: #3a1f5e;
    --lc-chat-ul-text: #d9beff;
    --lc-chat-honor-bg: #0e3a2c;
    --lc-chat-honor-text: #8fe6c1;
    --lc-chat-price-bg: #4a1f08;
    --lc-chat-price-text: #ffb380;
    --lc-event-text: #d8def2;
    --lc-event-bg: rgba(36, 50, 92, .65);
    --lc-gift-bg: linear-gradient(135deg, #3a1d5c, #5b2842);
    --lc-gift-text: #ffd6e8;
    --lc-superchat-bg: linear-gradient(135deg, #0d63ff, #d946ef);
    --lc-superchat-text: #fff;
    /* SC 是直播间最高优先级事件 — 给一个额外的彩虹外晕,真正"亮起来"。
       Magenta hairline pulls from the gradient's hot endpoint, electric-blue
       outer halo from the cool endpoint. Replaces baseline's red glow. */
    --lc-superchat-glow:
      0 1px 0 rgba(255, 255, 255, .15) inset,
      0 0 0 1px rgba(217, 70, 239, .25),
      0 12px 32px rgba(13, 99, 255, .35);
    --lc-guard-3-bg: linear-gradient(135deg, #0e2f5c, #133a4a);
    --lc-guard-2-bg: linear-gradient(135deg, #3a1559, #5b2a4e);
    --lc-guard-1-bg: linear-gradient(135deg, #5e3009, #6b441b);
    --lc-redpacket-bg: linear-gradient(135deg, #5b1830, #6b3a18);
    --lc-lottery-bg: linear-gradient(135deg, #15384e, #3a1f5c);
  }

  #laplace-custom-chat[data-theme],
  #laplace-custom-chat[data-theme] * {
    font-family: var(--lc-chat-font);
  }

  /* 整个聊天列表加一层深色玻璃 + 上下渐隐遮罩,跟 iOS 18 Lock Screen 类似。 */
  #laplace-custom-chat[data-theme] .lc-chat-list {
    background-image:
      radial-gradient(circle at 18% 12%, rgba(94, 92, 230, .14), transparent 38%),
      radial-gradient(circle at 82% 88%, rgba(217, 70, 239, .08), transparent 42%);
    -webkit-mask-image: linear-gradient(to bottom, transparent, #000 20px, #000 calc(100% - 20px), transparent);
    mask-image: linear-gradient(to bottom, transparent, #000 20px, #000 calc(100% - 20px), transparent);
  }

  #laplace-custom-chat[data-theme] .lc-chat-message {
    transition: .2s color ease, .2s background-color ease, .2s opacity ease, .2s transform ease;
  }

  /* 头像加一圈薄高光,让它从深色 BG 里浮起来。 */
  #laplace-custom-chat[data-theme] .lc-chat-avatar {
    box-shadow:
      0 0 0 1px rgba(140, 166, 255, .2),
      0 0 0 3px rgba(20, 28, 56, .85),
      0 2px 10px rgba(0, 0, 0, .5);
  }

  #laplace-custom-chat[data-theme] .lc-chat-name {
    color: var(--lc-chat-name);
    font-weight: 700;
    text-shadow: 0 1px 1px rgba(0, 0, 0, .3);
  }

  #laplace-custom-chat[data-theme] .lc-chat-time {
    color: var(--lc-chat-muted);
  }

  /* 普通气泡:深色 bubble + 1px 高光 inset + 弱外阴影,iOS Tinted 风。 */
  #laplace-custom-chat[data-theme] .lc-chat-bubble {
    color: var(--lc-chat-bubble-text);
    background: var(--lc-chat-bubble);
    font-weight: 500;
    box-shadow: var(--lc-chat-bubble-shadow);
  }

  #laplace-custom-chat[data-theme] .lc-chat-bubble::before {
    background: var(--lc-chat-bubble);
    border-color: var(--lc-chat-border);
  }

  #laplace-custom-chat[data-theme] .lc-chat-reply {
    color: var(--lc-chat-accent);
  }

  #laplace-custom-chat[data-theme] .lc-chat-medal {
    max-width: min(13em, 72%);
    text-shadow: none;
  }

  /* Badges:深色背景下的彩色徽章,内嵌细高光让它有"贴上去"的质感。 */
  #laplace-custom-chat[data-theme] .lc-chat-badge[data-badge-type="medal"] {
    color: var(--lc-chat-medal-text);
    background: var(--lc-chat-medal-bg);
    box-shadow: 0 1px 0 rgba(255, 255, 255, .06) inset;
  }
  #laplace-custom-chat[data-theme] .lc-chat-badge[data-badge-type="guard"] {
    color: var(--lc-chat-guard-text);
    background: var(--lc-chat-guard-bg);
    box-shadow: 0 1px 0 rgba(255, 255, 255, .06) inset;
  }
  #laplace-custom-chat[data-theme] .lc-chat-badge[data-badge-type="admin"] {
    color: var(--lc-chat-admin-text);
    background: var(--lc-chat-admin-bg);
    box-shadow: 0 1px 0 rgba(255, 255, 255, .06) inset;
  }
  #laplace-custom-chat[data-theme] .lc-chat-badge[data-badge-type="rank"] {
    color: var(--lc-chat-rank-text);
    background: var(--lc-chat-rank-bg);
    box-shadow: 0 1px 0 rgba(255, 255, 255, .06) inset;
  }
  #laplace-custom-chat[data-theme] .lc-chat-badge[data-badge-type="ul"] {
    color: var(--lc-chat-ul-text);
    background: var(--lc-chat-ul-bg);
    box-shadow: 0 1px 0 rgba(255, 255, 255, .06) inset;
  }
  #laplace-custom-chat[data-theme] .lc-chat-badge[data-badge-type="honor"] {
    color: var(--lc-chat-honor-text);
    background: var(--lc-chat-honor-bg);
    box-shadow: 0 1px 0 rgba(255, 255, 255, .06) inset;
  }
  #laplace-custom-chat[data-theme] .lc-chat-badge[data-badge-type="price"] {
    color: var(--lc-chat-price-text);
    background: var(--lc-chat-price-bg);
    box-shadow: 0 1px 0 rgba(255, 255, 255, .06) inset;
  }

  #laplace-custom-chat[data-theme] .lc-chat-kind,
  #laplace-custom-chat[data-theme] .lc-chat-card-mark {
    color: var(--lc-chat-bubble-text);
    background: rgba(140, 166, 255, .12);
  }

  /* Card events(gift / SC / guard / redpacket / lottery) */
  #laplace-custom-chat[data-theme] .lc-chat-card-event .lc-chat-bubble {
    min-width: min(18em, 100%);
    padding: 12px 16px;
    border-radius: 18px;
    border-bottom-left-radius: 6px;
    box-shadow:
      0 1px 0 rgba(255, 255, 255, .06) inset,
      0 8px 24px rgba(0, 0, 0, .45);
  }

  #laplace-custom-chat[data-theme] .lc-chat-card-event .lc-chat-bubble::before {
    background: inherit;
  }

  #laplace-custom-chat[data-theme] .lc-chat-card-title {
    font-weight: 800;
  }

  #laplace-custom-chat[data-theme] .lc-chat-card-field {
    background: rgba(255, 255, 255, .06);
  }

  #laplace-custom-chat[data-theme] .lc-chat-event-debug {
    color: var(--lc-chat-muted);
    background: rgba(36, 50, 92, .65);
  }

  /* 礼物 / SC / 舰队 — 各自层级颜色,加 inset 高光让深色 BG 上仍有 depth。 */
  #laplace-custom-chat[data-theme] .lc-chat-card-event[data-card="gift"] .lc-chat-bubble {
    color: var(--lc-gift-text);
    background: var(--lc-gift-bg);
  }

  #laplace-custom-chat[data-theme] .lc-chat-card-event[data-card="superchat"] .lc-chat-bubble {
    color: var(--lc-superchat-text);
    background: var(--lc-superchat-bg);
    /* Re-state box-shadow at this selector's higher specificity (0,1,4,0)
       so the preset's generic .lc-chat-card-event .lc-chat-bubble rule
       above (which sets a flat dark-card shadow at 0,1,3,0) does NOT win
       on the source-order tiebreaker against baseline's SC rule. The value
       comes from --lc-superchat-glow declared in this preset's :root.
       NOTE: this whole CSS string is a JS template literal — no backticks. */
    box-shadow: var(--lc-superchat-glow);
  }

  #laplace-custom-chat[data-theme] .lc-chat-card-event[data-card="guard"] .lc-chat-bubble {
    color: #c6d8ff;
    background: var(--lc-guard-3-bg);
  }

  #laplace-custom-chat[data-theme] .lc-chat-card-event[data-guard="2"] .lc-chat-bubble {
    color: #f1c9ff;
    background: var(--lc-guard-2-bg);
  }

  #laplace-custom-chat[data-theme] .lc-chat-card-event[data-guard="1"] .lc-chat-bubble {
    color: #ffd29b;
    background: var(--lc-guard-1-bg);
  }

  #laplace-custom-chat[data-theme] .lc-chat-card-event[data-card="redpacket"] .lc-chat-bubble {
    color: #ffd0b5;
    background: var(--lc-redpacket-bg);
  }

  #laplace-custom-chat[data-theme] .lc-chat-card-event[data-card="lottery"] .lc-chat-bubble {
    color: #c0d8ff;
    background: var(--lc-lottery-bg);
  }

  /* follow / like / share / enter / notice 等次要事件,用主题色 lite 变体。 */
  #laplace-custom-chat[data-theme] .lc-chat-message[data-kind="follow"] .lc-chat-bubble,
  #laplace-custom-chat[data-theme] .lc-chat-message[data-kind="like"] .lc-chat-bubble,
  #laplace-custom-chat[data-theme] .lc-chat-message[data-kind="share"] .lc-chat-bubble,
  #laplace-custom-chat[data-theme] .lc-chat-message[data-kind="enter"] .lc-chat-bubble,
  #laplace-custom-chat[data-theme] .lc-chat-message[data-kind="notice"] .lc-chat-bubble,
  #laplace-custom-chat[data-theme] .lc-chat-message[data-priority="lite"] .lc-chat-bubble {
    color: var(--lc-chat-lite-text);
    background: var(--lc-chat-lite);
  }

  #laplace-custom-chat[data-theme] .lc-chat-actions {
    filter: drop-shadow(0 2px 6px rgba(0, 0, 0, .5));
  }

  #laplace-custom-chat[data-theme] .lc-chat-action,
  #laplace-custom-chat[data-theme] .lc-chat-send {
    color: #fff;
    background: var(--lc-chat-own);
  }

  #laplace-custom-chat[data-theme] .lc-chat-perf {
    color: var(--lc-chat-muted);
    background: rgba(36, 50, 92, .65);
  }
`
