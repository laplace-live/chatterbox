# 动态 `@connect` 研究 (Jobs 式 #16)

**状态**: 研究 / 不实施 — 当前 userscript metadata 模型不支持运行时 `@connect`,
所有可能访问的域必须在 `vite.config.ts` 的 `connect` 数组里静态声明。结论:
**保持现状,通过 README 分类表(已完成 #14)管理用户预期**;若上游 vite-plugin-monkey
未来支持 runtime grant API,则迁移。

## 问题陈述

当前 `@connect` 列表(19 域)在脚本管理器(Tampermonkey / Violentmonkey)
首次安装时全部一次性请求。用户看到的是:

```
即将安装 "B站独轮车 + 自动跟车"。该脚本将访问以下 19 个域:
  api.live.bilibili.com, workers.vrp.moe, sbhzm.cn, chatterbox-cloud..., ...
[安装] [取消]
```

新用户无法把"我开启 X 功能 → 它访问 Y 域"对应起来——Tampermonkey 把所有
跨域域名压成一份清单。这造成两个问题:
1. **隐私 friction**: 用户看到 LLM API 域 / Soniox / radar / Guard Room 等
   可选服务的域,但还没决定开启它们,感觉"被偷偷加了一堆访问点"。
2. **决策疲劳**: 19 个域要逐个审视——大多数用户直接点"安装"而不审,等于
   safelist 失去意义。

理想:**只在用户首次启用某个功能时**才申请该功能依赖域的 `@connect`。
"按需 grant"是 web Permissions API、Android 6+、iOS 全平台的标准模式。

## 调研结果

### Greasemonkey / Tampermonkey / Violentmonkey API

- **GM_xmlhttpRequest** 自身**不接受**运行时声明域,所有目标域必须在脚本头
  `@connect` 元数据里声明 — 否则脚本管理器在请求前阻止。这是脚本管理器
  enforcing 的安全门,**不是 vite-plugin-monkey 的限制**。
- **GM.notification / GM_addStyle** 等等都是已声明能力,无运行时 grant 函数
  (相比之下,WebExtension 有 `chrome.permissions.request()`)。
- **`@connect *` 通配符**: Tampermonkey 支持;每次首次访问一个新域会单独
  弹窗确认。我们的 vite.config 已经在末尾加了 `'*'` 兜底(主要为 OpenAI 兼容
  自填 base URL)。**这就是当前最接近 "按需 grant" 的机制**:
  - 每个新 LLM provider 域,**首次**调用时弹窗(单域)
  - 用户拒绝 → 该域永久 block(用户可在 TM 设置里再开)
  - 用户接受 → 该域加入 allowlist,后续静默

  这覆盖了"用户切换 LLM provider 域"的场景(用户主动操作 → 弹窗 → 决策)。
  但**不覆盖**"用户不开就不申请已知必要域"的场景(必要域必须列在 `@connect`
  里,否则脚本无法访问)。

### vite-plugin-monkey

- 当前版本(8.x)**没有**动态 connect API,`UserScriptHeaderItem.connect` 是
  build-time 数组。
- 上游 issue 跟踪:见 https://github.com/lisonge/vite-plugin-monkey/issues
  暂无相关 RFE(2026-05 检索)。
- **决策**: 若要进展,得在 vite-plugin-monkey 上游开一个 RFE: 接受 build
  方向 `Promise<string[]>` 让插件运行时调整 `@connect` 列表 — 但即使有这个
  API,**脚本管理器侧的 enforcing 仍然要求 `@connect` 在脚本头**,所以本质
  上 vite 这层做不了运行时 grant。

### WebExtension `permissions.request()`

- Manifest V2/V3 支持运行时请求 host_permissions。这是真的"按需 grant",
  但要求把 chatterbox 重写为浏览器扩展。
- **不实施**: 重写为 WebExtension 是另一个量级的工作(打破当前 Greasy Fork
  分发链 + Bilibili 登录态共享 + GM_setValue 持久化),Jobs 审计 #1
  (Chatterbox Chat 美学) + #9 (Guard Room 剥离) 都更高优先级。

## 当前缓解(已做)

- **README @connect 分类表** (#14 已完成): 把 19 域分成 5 组(必要 / 烂梗库 /
  LLM / 同传 / 公会同步),用户在安装前能在 Greasy Fork 页面看清"这域服务
  什么功能"。
- **每域单域确认** (Tampermonkey 默认行为): 即便 `@match` 列了某域,首次
  实际 fetch 时 Tampermonkey 仍弹窗确认。这是脚本管理器的二次闸门,我们
  无法绕过——也不想绕过。
- **`'*'` 兜底用于自填 OpenAI 兼容 base URL** (vite.config.ts 末尾): 用户填
  自定义 LLM 域时,首次访问 TM 弹窗确认,这是该用户专用域,跟"广泛 connect"
  本质不同。

## 长期路径(若上游能力成熟)

1. **跟踪 vite-plugin-monkey 上游**:每季度检索一次有无新 dynamic-connect API。
2. **若有**:对照下面"按需域映射"重构 vite.config.ts 把 19 域降到必要 5 域,
   把可选服务对应的域改为运行时 grant。
3. **若 5 年内仍无**:把 chatterbox 转 WebExtension(配合 #1 Chatterbox Chat
   做美 + #9 剥离 Guard Room 一起,作为 v3.0 的整体改造)。

### 按需域映射(供未来重构参考)

| 用户行为 | 该激活的域 |
|---|---|
| 首次安装 | `api.live.bilibili.com`(发送弹幕)、`workers.vrp.moe`(LAPLACE)、`chatterbox-cloud.aijc-eric.workers.dev`(烂梗库默认后端)、`edge-workers.laplace.cn`(AI 规避后台) |
| 用户启用同传 | `api.soniox.com`, `unpkg.com` |
| 用户填了 Anthropic key | `api.anthropic.com` |
| 用户填了 OpenAI key | `api.openai.com` |
| 用户填了 OpenAI 兼容 base URL | 对应单域(已经走 `*` 兜底,TM 单独弹窗) |
| 用户开启 radar 雷达 | `live-meme-radar.aijc-eric.workers.dev` |
| 用户开启 SBHZM 烂梗库 | `sbhzm.cn` |
| 用户填 Guard Room URL | 用户指定的 URL(已经走 `*` 兜底) |
| 本地开发 | `localhost` |

## 不打算研究的方向

- ❌ **削减 `@connect` 列表到 0**(纯依赖 `*` 兜底): 每条新域都 TM 弹窗会
  破坏用户体验,常用域(B 站 API、LAPLACE)应该静默。
- ❌ **改用 fetch 代替 GM_xhr 绕过 @connect 限制**: 一些目标域有 CORS 限制
  (sbhzm.cn / chatterbox-cloud / LLM provider),fetch 直连会被浏览器拒绝。
  GM_xhr 是 CORS 绕过的关键路径,不能放弃。
- ❌ **不上报 README/CLAUDE.md 把 `*` 兜底说成 "动态 grant"**: 那是误导,
  `*` 是 build-time 通配,不是 runtime grant。

## 复盘问

如果哪天 vite-plugin-monkey 真支持运行时 connect,先回看本文档的"按需域映射"
表,然后决定迁移节奏。
