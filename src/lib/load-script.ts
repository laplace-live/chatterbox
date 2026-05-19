/**
 * Shared lazy `<script>` loader for CDN-hosted UMD bundles.
 *
 * 用一个共享 helper 是因为：未来若 audio-only (mpegts.js)、speech-to-text
 * (Soniox)、或别的 lazy CDN dep 都要做同样的事 —— 检查全局变量、缺失则
 * 注入 `<script>` 标签、共享在飞 promise 避免并发竞态、失败时清缓存允许重试。
 * 集中实现保证未来加 dep 都拿到这套已验证过的行为，不必散在各处漂移。
 *
 * 为什么刻意绕开 bundler 的 `externalGlobals` / Tampermonkey `@require`：
 * 那条路径是 eager 加载 —— 每次脚本注入都拉，即使用户从来不开这个功能。
 * 懒注入把成本压到"用户第一次开关功能"那一刻。
 *
 * 注入的 `<script>` 跑在 page context（不是 userscript sandbox），所以
 * 全局会落到真实 page window 上。调用者必须用 `unsafeWindow` 探测，不能
 * 用 sandboxed `window`。
 *
 * Cherry-picked from laplace-live/chatterbox@a7f74c4.
 */

const inFlight = new Map<string, Promise<unknown>>()

/**
 * 注入 `url` 为 `<script>` 标签，等 `getGlobal()` 报告期待的全局上挂之后
 * resolve。可并发安全 —— 同一 URL 的并发调用共享一次 fetch。
 *
 * @param url - 脚本 URL（一般是 unpkg 上锁版本号的路径）。
 * @param getGlobal - 探测函数，返回已挂到 window 上的全局，否则 `null`。
 *   注入前调用一次（短路：页面别处已经载好了同库），onload 后再调一次
 *   确认 install 确实生效 —— `script.onload` 只能证明字节下载完了，不能
 *   证明真的做了什么有意义的事（200 + 空 body 也会"成功"）。
 */
export function loadScript<T>(url: string, getGlobal: () => T | null): Promise<T> {
  const existing = getGlobal()
  if (existing) return Promise.resolve(existing)

  const cached = inFlight.get(url)
  if (cached) return cached as Promise<T>

  const promise = new Promise<T>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = url
    // unpkg 配置 `access-control-allow-origin: *`，所以匿名 CORS 可用，
    // 浏览器不会因为带凭据 CORS 检查阻止全局赋值。
    script.crossOrigin = 'anonymous'
    script.onload = () => {
      const g = getGlobal()
      if (g) {
        resolve(g)
      } else {
        // 跟 onerror 路径对称：200 + 空 body / CDN 返回错误 bundle 之类的
        // "script 跑过但全局没装上"也必须清 inFlight，否则 toggle 关掉再
        // 打开会拿到 cached rejected promise，永远再也试不了。
        // （Codex P2 review on PR #34 命中这条 — 上一版漏了对称 evict。）
        inFlight.delete(url)
        reject(new Error(`script loaded but expected global not found: ${url}`))
      }
    }
    script.onerror = () => {
      // 清缓存让下一个调用者可以重试，不至于永远锁死在 failed promise 上。
      inFlight.delete(url)
      reject(new Error(`failed to load script from ${url}`))
    }
    document.head.appendChild(script)
  })
  inFlight.set(url, promise)
  return promise
}
