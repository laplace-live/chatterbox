import { CornerCluster } from './corner-cluster'
import { InfoButton } from './info-button'

/**
 * Minimal app surface for `space.bilibili.com`.
 *
 * The live-page `<AppRoom />` boots half a dozen live-only modules (send
 * loop, danmaku-direct, auto-blend, audio-only, auto-seek, auto-quality,
 * user-blacklist) that would either silently no-op or actively crash
 * against a user space page — no `.chat-items`, no `livePlayer`, no
 * `ensureRoomId` target. Rather than litter every module with
 * `isLiveHost` guards we keep them out of the tree entirely on space
 * pages and mount a much smaller surface here.
 *
 * What we mount on space pages:
 *   - `<CornerCluster>` with just `<InfoButton />`. UID identity is
 *     supplied by `main.tsx` writing the parsed-from-URL uid into
 *     `infoCurrentUid` before render.
 *
 * What we deliberately DON'T mount:
 *   - `<ConfiguratorButton />` / `<AudioOnlyButton />` — both depend on
 *     live-room machinery (the configurator's `SettingsTab` reads
 *     `cachedRoomId`, audio-only manipulates the live player chrome).
 *   - `<Configurator />` / `<AlertDialog />` — same reason; the LLM
 *     section depends on `loop()`, which only runs on the live surface.
 *
 * `fetch-hijack.ts` (which the space `unlockSpaceBlock` feature relies
 * on) is imported at the top of `main.tsx`, runs unconditionally, and
 * doesn't depend on this component — so disabling that feature stays
 * possible via the live-page settings tab as before.
 */
export function AppSpace() {
  return (
    <CornerCluster>
      <InfoButton />
    </CornerCluster>
  )
}
