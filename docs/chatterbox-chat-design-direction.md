# Chatterbox Chat 视觉设计方向 (Jobs 式 #1 + #20)

## Context

Chatterbox Chat 是 chatterbox 的"替你看"产品线—— 接管 B 站直播间右侧聊天区,
显示更清爽的弹幕 / 礼物 / SC / guard 事件流。Jobs 式审计 #1 指出:目前的视觉
"不够优美,不够优雅",虽然已经有 `iMessage Dark / iMessage Light / Compact
Bubble` 三套基础主题 + `MILK_GREEN_IMESSAGE_CSS` 用户预设,但和 iMessage 真正
的美感差一截—— 缺 depth,缺 motion,缺各事件层级的强烈对比。

这份文档锁定**设计方向**,给未来的视觉 polish 工作(以及 #20 列出的 2102 行
`custom-chat-dom.ts` 重构)一个明确的"什么是好"标尺。**不是 spec**——是
方向。具体每个像素如何走,在 PR 里反复迭代。

## 核心原则

### 1. 信息层级 = 视觉层级

直播间事件按用户关注度排序(高 → 低):

1. **Superchat 醒目留言** — 用户付费要求被看见。**最强视觉**:渐变高饱和
   背景 + 大字 + 外发光,占据视觉中心。
2. **舰队上船 (guard)** — 大额支付 + 持续身份。**次强**:渐变背景按 1/2/3 档
   区分(总督 / 提督 / 舰长),金属质感(金 / 樱粉 / 钛蓝)。
3. **大额礼物 (gift)** — 一次性大额支付。**第三**:暖色渐变(橙红 / 玫瑰金)。
4. **普通弹幕 / 弹幕回复** — 主流,数量最多。**底色信息**:中性气泡,
   只在内容本身上提供细节(头像、徽章、ts 等)。
5. **进场 / 关注 / 点赞 / 系统通知** — 流量大但每条信息低。**最弱**:lite
   背景色,小字,可被一眼略过。

**当前问题**:`iMessage Dark` baseline 把 SC 和普通弹幕的视觉对比不够强 —
SC 用 `--lc-superchat-bg` 一个 gradient,但缺 outer glow / 字重升级 / size
scale-up,看起来像"颜色不同的普通气泡"而不是"快看这条!"。新预设
`MIDNIGHT_INDIGO_IMESSAGE_CSS` 给 SC 加了 `0 12px 32px rgba(13,99,255,.35)`
的外发光,这才是 SC 该有的视觉重量。

### 2. Depth via inset highlight + outer shadow, not flat colors

iMessage 之所以"高级",关键是它没有任何"纯色块"。每个气泡都有:
- 1px inset 白色高光(让边缘有光泽)
- 极弱 outer drop-shadow(让它从背景里浮起来)
- 微妙的灰度梯度(top 比 bottom 略亮)

我们当前的 baseline 多数地方还是平涂(`background: #...`)。新预设
`MIDNIGHT_INDIGO` 引入了 `box-shadow: 0 1px 0 rgba(255,255,255,.06) inset, 0 6px 18px rgba(0,0,0,.35)` 模式 —— inset 高光是关键,deep 模式下能立刻显出
"贴在背景上的卡片"质感。**未来 baseline 重做时,这个模式应该统一应用**。

### 3. Spacing rhythm = 4px 网格

iOS 18 用 4px 作为基础单位:padding 4/8/12/16,gap 4/8/12/16,radius 4/8/16/20。
不要出现 3px / 5px / 7px 这种破节奏的值。

**当前问题**:`custom-chat-dom.ts` 渲染时存在 `padding: 11px 15px` 之类的
奇数值(MILK_GREEN_IMESSAGE_CSS 第 150 行就有 `padding: 11px 15px`,
border-radius: 20px / 8px 不在一个体系)。**重做时全部对齐 4px 网格**。

### 4. Motion 是体验的一部分,不是装饰

iMessage 的关键体验:气泡**入场动画**(滑入 + 弹簧)、**点击微反馈**
(0.96x scale)、**长按浮起**(shadow growth)。

**当前**:`.lc-chat-message` 有 `transition: .24s color, .24s background-color,
.24s opacity`—— 只动颜色,**不动空间属性**。气泡的入场和滚动是瞬间出现的,
缺少 iMessage 的"我来了"感觉。

**重做建议**:
```css
.lc-chat-message {
  animation: lc-msg-in .35s cubic-bezier(.34, 1.56, .64, 1);
}
@keyframes lc-msg-in {
  0%   { opacity: 0; transform: translateY(8px) scale(.96); }
  100% { opacity: 1; transform: translateY(0)   scale(1);   }
}
@media (prefers-reduced-motion: reduce) {
  .lc-chat-message { animation: none; }
}
```

cubic-bezier `(.34, 1.56, .64, 1)` 是 Apple Smooth Spring,过头一点点再回来 —
这是 iMessage 标志性的"弹"。

### 5. Typography:1 个字族 + 3 个字重

iMessage 用 SF Pro Text,只用 400 / 600 / 700。我们的 baseline 用
`var(--lc-chat-font, system-ui)` + 5 个字重(400/500/600/700/800),
弱化了 hierarchical contrast。

**建议**:
- 普通弹幕正文:600(略粗,深色 BG 下不糊)
- 用户名:700
- SC / Guard / Gift 标题:800
- 时间戳 / 元信息:500 + muted color
- 不用 400 — 在 12-13px 字号下太轻,深色背景上几乎看不清

### 6. Don't ship two themes that solve the same problem

当前主题:`iMessage Dark` / `iMessage Light` / `Compact Bubble` + 一份
MILK_GREEN 用户预设。`iMessage Dark` 和 `MILK_GREEN` 都是"日间柔色" — 
区分度低。

新增 `MIDNIGHT_INDIGO_IMESSAGE_CSS` 才填补"深色精致 + 高对比"的方向。
未来如果再加预设,**让它去填空白方向**(高饱和动漫 / 极简黑白 /
木质暖色),不要再做一份"差不多 iMessage" 的克隆。

## 短期 vs 长期工作切分

### 已经做的(本次 commit)
- ✅ `MIDNIGHT_INDIGO_IMESSAGE_CSS` 第二份用户预设 — 给"深夜直播 / VTuber
  房间"场景提供 baseline 之外的高质量选项。
- ✅ Settings → Chatterbox Chat 自定义 CSS 加"午夜深蓝 iMessage"按钮。
- ✅ 本设计方向文档,作为未来 polish 工作的目标。

### 短期 (1-2 周内可做的视觉 polish,不需要 dom refactor)
- 给 `iMessage Dark` baseline 的 `custom-chat-style.ts` 加 inset highlight
  + outer glow on SC bubble(参考 MIDNIGHT_INDIGO 的实现)。
- 给所有 baseline 加 `.lc-chat-message` 入场动画(参考"Motion"小节,
  respect prefers-reduced-motion)。
- 把 padding / radius / gap 全部规约到 4px 网格。
- 把字重压成 500 / 700 / 800 三档。

### 中期 (需要 `custom-chat-dom.ts` 重构成,参考 [docs/custom-chat-dom-refactor-plan.md](./custom-chat-dom-refactor-plan.md))
- 重新设计 SC / Guard / Gift / RedPacket / Lottery card 的 DOM 结构,
  让 CSS 能干净表达 hierarchy(当前 DOM 结构有点扁,每个 card 都长得像
  普通气泡多了一个 data attribute,visual contrast 受限于此)。
- 引入 `.lc-chat-card-event--hero` 这种"主角事件"修饰类,SC 不只是
  data-card="superchat",而是 hero card,visual treatment 是另一个层级。
- 滚动虚拟化时,把"已经看过的旧消息"加 fade-back(降低 saturation +
  opacity 0.7),让用户视线自然聚焦到底部新消息。

### 长期(姊妹脚本拆分级别的工作)
- 完整重做 `iMessage Dark` 主题,用 MIDNIGHT_INDIGO 作为新 baseline 替换
  当前 `laplace` 主题(老的 `laplace` 改名 `laplace-classic` 作为兼容
  preset 留给老用户)。
- 给视频流叠加可选(对接 OBS 浏览器源):一份针对 OBS 1080p stream-overlay
  优化的预设,字号 + 对比度 + safe area 都按"远观可读"调。

## 教训:preset CSS 的 cascade 陷阱(2026-05-17 Preview vs Cloud 审计)

第一版 `MIDNIGHT_INDIGO_IMESSAGE_CSS` 和 `MILK_GREEN_IMESSAGE_CSS` 都写得很认真,
但实际加载到 panel 上 **几乎不生效** —— 用户点 "午夜深蓝" 看到的依然是 baseline
深色,只有 font 和 drop-shadow 这种 baseline 没设置的属性偷偷溜进去。

通过 `tmp/chat-preview/` 把两份 preset 渲染到一个 iframe 里,跑
`getComputedStyle(root).getPropertyValue('--lc-chat-bg')` 比对,发现:

- preset 想要 `--lc-chat-bg: #0c1228` (午夜深蓝)
- 实际值 `--lc-chat-bg: #050608` (baseline laplace 黑)

两个根因:

1. **`@layer chatterbox-custom-css { … }` 包装杀掉了 preset 的所有规则。**
   按 CSS Cascading Level 5 spec,**任何 unlayered author 规则永远赢 layered author 规则**,
   不分 specificity / 不分 source order。baseline `CUSTOM_CHAT_STYLE` 是 unlayered,
   preset 一旦包进 layer 就全部输掉。这是 spec 里最反直觉的一条 —— 大多数人以为 layer 是
   "命名空间隔离",其实它是"自愿降级"。
2. **`#laplace-custom-chat` 单 id 选择器输给 baseline 的 data-theme 变体。**
   即使 unlayered,baseline 有 `#laplace-custom-chat[data-theme="laplace"] {...}`
   声明深色变量(specificity `0,1,1,0`),preset 用 `#laplace-custom-chat {...}`
   只有 `0,1,0,0`,被压制。修复:preset 也用 `#laplace-custom-chat[data-theme] {...}`
   (匹配 *any* data-theme,specificity 同样是 `0,1,1,0`),源代码顺序又在后,
   tie-break 由 preset 赢。

**写 preset CSS 永远遵守的两条**:

- 不要包 `@layer …`。tests/`custom-chat-presets.test.ts` 会 catch 这条。
- 每个 selector 用 `#laplace-custom-chat[data-theme]` 而不是裸 id。tests 同样 catch。

**怎么提前发现**:`bun tmp/chat-preview/gen-preview.mjs` 生成对比页,
用 `getComputedStyle(root).getPropertyValue('--lc-chat-bg')` 跟 preset 声明值
做 deep-equals。或者在 Chatterbox Chat 实际加载的 panel 上,DevTools Computed 栏
搜 `--lc-chat-bg` —— 它如果没变成 preset 的值,preset 就没在做事。

## 复盘问

读这个文档的人(包括未来的 Claude session、维护者、新贡献者)在动 Chatterbox
Chat 视觉之前,先问:
1. 这个改动是把当前层级 hierarchy **更明确**了,还是更糊?
2. 这个 padding / radius / gap 落在 4px 网格上吗?
3. 这个动画 respect `prefers-reduced-motion` 吗?
4. 添加的 preset 是填空白方向,还是又一份"差不多 iMessage"?

如果四个答案都"是 / 否的好",PR 可以走。

## 配套阅读

- [docs/custom-chat-dom-refactor-plan.md](./custom-chat-dom-refactor-plan.md) — 2102 行 DOM 层重构的具体步骤
- [docs/guard-room-spinoff-plan.md](./guard-room-spinoff-plan.md) — Guard Room 剥离计划(配合视觉重做可以同步 release)
