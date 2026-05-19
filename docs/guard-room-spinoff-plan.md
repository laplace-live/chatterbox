# Guard Room / live-desk 剥离计划 (Jobs 式 #9) — DECISION REVERSED (2026-05-18)

> [!WARNING]
> **此计划已撤销 —— 不要再次按字面意思执行拆分。**
>
> 撤销原因:**前提搞错了**。本计划(以及当时 CLAUDE.md 里的对应描述)
> 把 guard-room / live-desk 这套功能描述成"公会管理员工具"。实际上它服务的
> 是**重度多房间观众** —— 同时挂着几个直播间,哪个有意思跳哪个,需要跨房间
> 状态同步、跨设备/tab 接管、远程下发预设。这跟 chatterbox 的核心用户(被
> 屏蔽风险下的重度直播观众)是**同一拨人**,不应该拆。
>
> 关于命名:本来一度考虑把"保安室 / 监控室代理"也改成"多房间观察台 /
> 跨房间挂机",但**改名取消**。"保安室" 是个**有画面的隐喻** —— 想象一个
> 老大爷坐在监控室,面前一排监视器,哪个房间有动静瞄哪个,切来切去 ——
> 这正是多房间观众的真实体验。Apple 的命名一向如此(Finder、Time Machine、
> Mission Control、Dashboard,不叫 File Manager、Backup System、Window
> Manager、Widget Container)—— 有人味的具体名词永远赢过功能描述。
> Stage 1 的姊妹仓库已删,5 个 lib 文件上的 `@deprecated` 横幅已撤,UI 上
> "(即将剥离)" 提示已撤,**UI 字符串保持原样**。
>
> **这份文档保留在 git 里作为"决策回顾",防止未来 session 翻到旧讨论时
> 重复执行错误的拆分**。下面的步骤 / checklist 仍然准确描述了"如果真要拆,
> 该怎么做",但**不要执行**。

---

## 原始计划(已撤销,仅作历史参考)

**原始状态**: **规划阶段,代码尚未拆出。** 已在所有相关模块加 `@deprecated`
横幅警告意图;实际剥离要等下面的 prerequisite 完成后执行(目标本年内,见
v3.0 release plan)。

## 为什么剥离

Jobs 式审计 #9 的核心论点:**Guard Room sync + live-desk heartbeat 是公会
管理工具,服务的用户群和 chatterbox 的核心目标用户(被屏蔽风险下的重度
直播观众)是两类人**。把两类用户挤在同一 userscript 里:

- 普通观众的设置面板里出现"保安室同步密钥 / spaceId@syncSecret / 心跳间隔
  10-120s / 监控会话 ID"等术语,完全不知道是什么,造成认知噪音。
- 公会管理员的需求(多账号、多直播间、远程控制 profile、批量轮值监控)
  和 chatterbox 单实例观众工具是反向的——chatterbox 不会朝那个方向演进。
- 维护成本:每次 chatterbox 改架构,Guard Room 集成都得跟着 verify;反过来
  Guard Room 后端 API 改了,chatterbox 这边也得跟。两个不同生命周期粘在
  一个 release cycle 里互相拖累。

剥成姊妹脚本 `bilibili-guild-companion` 后:
- chatterbox 设置面板砍掉 ~40 行 Guard Room UI(粉丝牌巡检 section 收缩
  到只有"巡检按钮 + 结果列表 + 复制/下载报告")。
- @connect 列表去掉 `bilibili-guard-room.vercel.app` 域(默认安装 -1 域)。
- 公会管理员安装两个脚本(`chatterbox` for self-service + `bilibili-guild-
  companion` for guild ops),互不耦合。两个脚本可共享同一 GM storage
  namespace 读对方的 medalCheckResultsByUid 等公共状态。

## 待剥离的代码

### 完整模块(整文件搬到新仓库)

| 文件 | 角色 |
|---|---|
| `src/lib/guard-room-sync.ts` | 低层 sync client(POST 巡检摘要 / shadow rules / live-desk 心跳) |
| `src/lib/guard-room-agent.ts` | Agent 运行时,套用 control profile,watchlist 同步 |
| `src/lib/guard-room-handoff.ts` | URL query param `?guard_room_source=guard-room&...` 接管 |
| `src/lib/guard-room-live-desk-state.ts` | live-desk runtime signals(session id / 心跳 / 风险等级 / watchlist) |
| `src/lib/live-desk-sync.ts` | 基于 custom-chat 事件的心跳循环 |

### 部分代码(从 chatterbox 同位减去)

| 文件 | 要砍掉的代码片 |
|---|---|
| `src/components/app.tsx` | `useEffect(() => { startGuardRoomAgent(); ... }, [])` + `useEffect` for `startLiveDeskSync` + `applyGuardRoomHandoff()`。imports 同步删除。 |
| `src/components/settings/medal-check-section.tsx` | "直播间保安室同步" sub-details(40 行) + "高级:监控室代理" sub-details(60 行) + `guardRoom*` 状态读 + `syncGuardRoomInspection()` 函数 + `buildGuardRoomInspectionRun()` |
| `src/lib/shadow-learn.ts` | guardRoom 镜像写入(如果有) |
| `src/lib/store.ts` | re-exports of `guardRoom*` 信号(从 store.ts 删 export,signals 跟代码一起去新 repo) |
| `vite.config.ts` `connect` 数组 | 去掉 `bilibili-guard-room.vercel.app` |
| `README.md` + `public/index.html` | "权限说明" → "可选公会同步" 行删除 / 链接到姊妹脚本 |
| `CLAUDE.md` | Architecture Overview → "Guard Room (`guard-room-*`, `live-desk-sync.ts`)" 整段移除 |

### 测试也跟着搬

```
tests/guard-room-*.test.ts
tests/live-desk-*.test.ts
tests/guard-room-handoff-*.test.ts
```

(以 `git mv` 保留 history,在新仓库导入。)

## 执行步骤(将来执行时的 checklist)

### 阶段 1:新仓库初始化
1. `gh repo create aijc123/bilibili-guild-companion --public`
2. Copy minimal scaffold:`package.json` (Bun + vite + vite-plugin-monkey),
   `tsconfig.json`, `biome.json`, `.github/workflows/ci.yml` (mirror chatterbox).
3. `src/main.tsx` 简单挂载,默认渲染 "Guild companion — 监控室管理面板"
   占位 UI。
4. Greasy Fork 提交申请(独立 scriptId)。

### 阶段 2:代码搬迁(单 PR,chatterbox + companion 同步)
1. **新仓库 PR-A**: copy 5 个 lib 文件 + 相关 tests 进新仓库,wire 进 boot path,
   验证 build + test:client 全过。
2. **chatterbox PR-B**: 删除上面"待剥离的代码"列出的部分,验证 build + tests
   通过(以 deprecation banner 已经替换的相关 import 为基础)。
3. 两个 PR 同 day merge + tag release(chatterbox v3.0.0, companion v1.0.0)。
4. 同步 README:chatterbox 顶部加一句 "Guild ops 工具已剥离到
   [bilibili-guild-companion](URL)"。

### 阶段 3:用户迁移(release notes)
- chatterbox v3.0.0 release notes 第一条:
  > **重大改动**: Guard Room 同步 / 监控室代理 / live-desk 心跳已剥离到
  > 独立脚本 `bilibili-guild-companion`。如果你是公会管理员,请额外安装它。
  > 单纯发弹幕/跟车/巡检自己粉丝牌的普通观众无需任何操作。

- GM 存储兼容性:两个 userscript 默认**共享** `GM_getValue` namespace
  (Tampermonkey storage scoped per scriptid),所以 chatterbox 写的
  `medalCheckResultsByUid` 等需要"跨脚本读取"——这是关键技术点:
  - **方案 a**(简单):companion script 自己再调 fetchMedalRooms,自己一份
    cache。两个脚本数据完全独立。多份 cache 但用户感知不到。
  - **方案 b**(复杂):companion script 用 `unsafeWindow.GM_getValue` from
    chatterbox's scriptid。需要研究 Tampermonkey 是否允许这种跨脚本读。

  **建议方案 a**——简单,没有跨脚本协议要求,companion 独立工作。

## 短期 / 当前做的(本次 commit 的内容)

1. ✅ 在 5 个 lib 文件顶部加 `@deprecated` JSDoc 标记 + 注释链接到本计划。
2. ✅ 在 `medal-check-section.tsx` 的"保安室同步" sub-details summary 上加
   "(即将剥离到独立脚本 bilibili-guild-companion)" 提示。
3. ✅ 本 `docs/guard-room-spinoff-plan.md` 落地。
4. ❌ **不**真删任何代码——所有 Guard Room 功能继续工作。剥离要在专门的
   release window 进行(影响重大,要给用户提前通知)。

## 谁会用这个文档

- Claude 未来 session 接手 Guard Room 任何工作时,先读本文档,确认是
  "在 chatterbox 维护现状"还是"启动剥离"。
- 真启动剥离时,把"阶段 1/2/3"的 checklist 当 PR 描述模板。
- 用户:如果你是公会管理员,本文档帮你预判 v3.0 升级要装哪个新脚本。
