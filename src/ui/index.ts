import { GM_getValue, GM_setValue } from '$'
import { loop } from '../loop.js'
import { setupAutoSend } from './auto-send.js'
import { setupManualSend } from './manual-send.js'
import { setupSettings } from './settings.js'
import { setupTranscription } from './transcription.js'

type GetVal = (key: string, def?: unknown) => unknown

function getDialogHTML(getVal: GetVal): string {
  const maxLogLines = Number(getVal('maxLogLines')) || 1000
  const sonioxHints = (getVal('sonioxLanguageHints') as string[]) || ['zh']
  const hasZh = sonioxHints.includes('zh')
  const hasEn = sonioxHints.includes('en')
  const hasJa = sonioxHints.includes('ja')
  const hasKo = sonioxHints.includes('ko')
  const sonioxTarget = String(getVal('sonioxTranslationTarget') ?? 'en')

  return `<div>
  <div style="display: flex; margin-block: -5px .75em; margin-inline: -10px; padding: 0 10px; gap: .25em; border-bottom: 1px solid var(--Ga2, #ddd);">
    <button id="tab-dulunche" class="tab-btn" style="padding: .25em .75em; margin-bottom: -1px; border: none; background: none; cursor: pointer; border-bottom: 1px solid transparent;">独轮车</button>
    <button id="tab-fasong" class="tab-btn" style="padding: .25em .75em; margin-bottom: -1px; border: none; background: none; cursor: pointer; border-bottom: 1px solid transparent;">常规发送</button>
    <button id="tab-tongchuan" class="tab-btn" style="padding: .25em .75em; margin-bottom: -1px; border: none; background: none; cursor: pointer; border-bottom: 1px solid transparent;">同传</button>
    <button id="tab-settings" class="tab-btn" style="padding: .25em .75em; margin-bottom: -1px; border: none; background: none; cursor: pointer; border-bottom: 1px solid transparent;">设置</button>
  </div>

  <div id="content-dulunche" class="tab-content" style="display: none;">
    <div style="margin: .5em 0; display: flex; align-items: center; flex-wrap: wrap; gap: .25em;">
      <button id="sendBtn">开启独轮车</button>
      <select id="templateSelect" style="width: 16ch;"></select>
      <button id="addTemplateBtn">新增</button>
      <button id="removeTemplateBtn">删除当前</button>
    </div>
    <textarea id="msgList" placeholder="在这输入弹幕，每行一句话，超过可发送字数的会自动进行分割" style="box-sizing: border-box; height: 100px; width: 100%; resize: vertical;"></textarea>
    <div style="margin: .5em 0;">
      <span id="msgCount"></span><span>间隔</span>
      <input id="msgSendInterval" style="width: 40px;" autocomplete="off" type="number" min="0" value="${getVal('msgSendInterval', 1)}" />
      <span>秒，</span>
      <span>超过</span>
      <input id="maxLength" style="width: 30px;" autocomplete="off" type="number" min="1" value="${getVal('maxLength', 20)}" />
      <span>字自动分段，</span>
      <span style="display: inline-flex; align-items: center; gap: .25em;">
        <input id="randomColor" type="checkbox" ${getVal('randomColor') ? 'checked' : ''} />
        <label for="randomColor">随机颜色</label>
      </span>
      <span style="display: inline-flex; align-items: center; gap: .25em;">
        <input id="randomInterval" type="checkbox" ${getVal('randomInterval') ? 'checked' : ''} />
        <label for="randomInterval">间隔增加随机性</label>
      </span>
      <span style="display: inline-flex; align-items: center; gap: .25em;">
        <input id="randomChar" type="checkbox" ${getVal('randomChar') ? 'checked' : ''} />
        <label for="randomChar">随机字符</label>
      </span>
    </div>
  </div>

  <div id="content-fasong" class="tab-content" style="display: none;">
    <div style="margin: .5em 0;">
      <textarea id="fasongInput" placeholder="输入弹幕内容… (Enter 发送)" style="box-sizing: border-box; height: 50px; width: 100%; resize: vertical;"></textarea>
    </div>
    <div style="margin: .5em 0;">
      <span style="display: inline-flex; align-items: center; gap: .25em;">
        <input id="aiEvasion" type="checkbox" ${getVal('aiEvasion') ? 'checked' : ''} />
        <label for="aiEvasion">AI规避（发送失败时自动检测敏感词并重试）</label>
      </span>
    </div>
  </div>

  <div id="content-tongchuan" class="tab-content" style="display: none;">
    <div style="margin: .5em 0; padding-bottom: .5em; border-bottom: 1px solid var(--Ga2, #eee);">
      <div style="font-weight: bold; margin-bottom: .5em;">Soniox API 设置</div>
      <div style="display: flex; gap: .5em; align-items: center; flex-wrap: wrap; margin-bottom: .5em;">
        <input id="sonioxApiKey" type="password" placeholder="输入 Soniox API Key" style="flex: 1; min-width: 150px;" value="${String(getVal('sonioxApiKey') ?? '')}" />
        <button id="sonioxApiKeyToggle" style="cursor: pointer;">显示</button>
      </div>
      <div style="margin-block: .5em; color: #666; font-size: 0.9em;">
        前往 <a href="https://soniox.com/" target="_blank" style="color: #288bb8;">Soniox</a> 注册账号并获取 API Key
      </div>
    </div>
    <div style="margin: .5em 0; padding-bottom: .5em; border-bottom: 1px solid var(--Ga2, #eee);">
      <div style="font-weight: bold; margin-bottom: .5em;">语音识别设置</div>
      <div style="display: flex; gap: .5em; align-items: center; flex-wrap: wrap; margin-bottom: .5em;">
        <span>语言提示：</span>
        <span style="display: inline-flex; align-items: center; gap: .25em;">
          <input id="sonioxLangZh" type="checkbox" value="zh" ${hasZh ? 'checked' : ''} />
          <label for="sonioxLangZh">中文</label>
        </span>
        <span style="display: inline-flex; align-items: center; gap: .25em;">
          <input id="sonioxLangEn" type="checkbox" value="en" ${hasEn ? 'checked' : ''} />
          <label for="sonioxLangEn">English</label>
        </span>
        <span style="display: inline-flex; align-items: center; gap: .25em;">
          <input id="sonioxLangJa" type="checkbox" value="ja" ${hasJa ? 'checked' : ''} />
          <label for="sonioxLangJa">日本語</label>
        </span>
        <span style="display: inline-flex; align-items: center; gap: .25em;">
          <input id="sonioxLangKo" type="checkbox" value="ko" ${hasKo ? 'checked' : ''} />
          <label for="sonioxLangKo">한국어</label>
        </span>
        <label for="sonioxMaxLength">超过</label>
        <input id="sonioxMaxLength" type="number" min="1" style="width: 40px;" value="${getVal('sonioxMaxLength', 40)}" />
        <span>字自动分段</span>
      </div>
      <div style="display: flex; gap: .5em; align-items: center; flex-wrap: wrap;">
        <span style="display: inline-flex; align-items: center; gap: .25em;">
          <input id="sonioxAutoSend" type="checkbox" ${getVal('sonioxAutoSend') ? 'checked' : ''} />
          <label for="sonioxAutoSend">识别完成后自动发送弹幕</label>
        </span>
      </div>
    </div>
    <div style="margin: .5em 0; padding-bottom: .5em; border-bottom: 1px solid var(--Ga2, #eee);">
      <div style="font-weight: bold; margin-bottom: .5em;">实时翻译设置</div>
      <div style="display: flex; gap: .5em; align-items: center; flex-wrap: wrap; margin-bottom: .5em;">
        <span style="display: inline-flex; align-items: center; gap: .25em;">
          <input id="sonioxTranslationEnabled" type="checkbox" ${getVal('sonioxTranslationEnabled') ? 'checked' : ''} />
          <label for="sonioxTranslationEnabled">启用实时翻译</label>
        </span>
      </div>
      <div style="display: flex; gap: .5em; align-items: center; flex-wrap: wrap;">
        <label for="sonioxTranslationTarget">翻译目标语言：</label>
        <select id="sonioxTranslationTarget" style="min-width: 80px;">
          <option value="en" ${sonioxTarget === 'en' ? 'selected' : ''}>English</option>
          <option value="zh" ${sonioxTarget === 'zh' ? 'selected' : ''}>中文</option>
          <option value="ja" ${sonioxTarget === 'ja' ? 'selected' : ''}>日本語</option>
        </select>
      </div>
      <div style="margin-top: .5em; color: #666; font-size: 0.9em;">
        启用后将发送翻译结果而非原始识别文字
      </div>
    </div>
    <div style="margin: .5em 0;">
      <div style="display: flex; gap: .5em; align-items: center; flex-wrap: wrap; margin-bottom: .5em;">
        <button id="sonioxStartBtn">开始同传</button>
        <span id="sonioxStatus" style="color: #666;">未启动</span>
      </div>
      <div style="margin-block: .5em;">
        <div style="font-weight: bold; margin-bottom: .25em;">实时识别结果：</div>
        <div id="sonioxTranscript" style="padding: .5em; background: var(--bg2, #f5f5f5); border-radius: 4px; min-height: 40px; max-height: 100px; overflow-y: auto; word-break: break-all;">
          <span id="sonioxFinalText"></span><span id="sonioxNonFinalText" style="color: #999;"></span>
        </div>
      </div>
    </div>
  </div>

  <div id="content-settings" class="tab-content" style="display: none;">
    <div style="margin: .5em 0; padding-bottom: .5em; border-bottom: 1px solid var(--Ga2, #eee);">
      <div style="font-weight: bold; margin-bottom: .5em;">
        云端规则替换
        <a href="https://github.com/laplace-live/public/blob/master/artifacts/livesrtream-keywords.json" target="_blank" style="color: #288bb8; text-decoration: none;">我要贡献规则</a>
      </div>
      <div style="margin-block: .5em; color: #666;">
        每10分钟会自动同步云端替换规则
      </div>
      <div style="display: flex; gap: .5em; align-items: center; flex-wrap: wrap; margin-bottom: .5em;">
        <button id="syncRemoteBtn">同步</button>
        <button id="testRemoteBtn">测试云端词库</button>
        <span id="remoteKeywordsStatus" style="color: #666;">未同步</span>
      </div>
      <div id="remoteKeywordsInfo" style="color: #666;"></div>
    </div>
    <div style="margin: .5em 0; padding-bottom: .5em; border-bottom: 1px solid var(--Ga2, #eee);">
      <div style="display: flex; gap: .5em; align-items: center; flex-wrap: wrap; margin-bottom: .5em;">
        <div style="font-weight: bold;">本地规则替换</div>
        <button id="testLocalBtn">测试本地词库</button>
      </div>
      <div style="margin-block: .5em; color: #666;">规则从上至下执行；本地规则总是最后执行</div>
      <div id="replacementRulesList" style="margin-bottom: .5em; max-height: 160px; overflow-y: auto;"></div>
      <div style="display: flex; gap: .25em; align-items: center; flex-wrap: wrap;">
        <input id="replaceFrom" placeholder="替换前" style="flex: 1; min-width: 80px;" />
        <span>→</span>
        <input id="replaceTo" placeholder="替换后" style="flex: 1; min-width: 80px;" />
        <button id="addRuleBtn">添加</button>
      </div>
    </div>
    <div style="margin: .5em 0; padding-bottom: .5em; border-bottom: 1px solid var(--Ga2, #eee);">
      <div style="font-weight: bold; margin-bottom: .5em;">日志设置</div>
      <div style="display: flex; gap: .5em; align-items: center; flex-wrap: wrap;">
        <label for="maxLogLinesInput" style="color: #666;">最大日志行数:</label>
        <input id="maxLogLinesInput" type="number" min="1" max="1000" value="${maxLogLines}" style="width: 80px;" />
        <span style="color: #999; font-size: 0.9em;">(1-1000)</span>
      </div>
    </div>
    <div style="margin: .5em 0;">
      <div style="font-weight: bold; margin-bottom: .5em;">其他设置</div>
      <div style="display: flex; gap: .5em; align-items: center; flex-wrap: wrap;">
        <span style="display: inline-flex; align-items: center; gap: .25em;">
          <input id="forceScrollDanmaku" type="checkbox" ${getVal('forceScrollDanmaku') ? 'checked' : ''} />
          <label for="forceScrollDanmaku">脚本载入时强制配置弹幕位置为滚动方向</label>
        </span>
      </div>
    </div>
  </div>

  <details style="margin-top: .25em;">
    <summary style="cursor: pointer; user-select: none; font-weight: bold;">日志</summary>
    <textarea id="msgLogs" style="box-sizing: border-box; height: 80px; width: 100%; resize: vertical; margin-top: .5em;" placeholder="此处将输出日志（最多保留 ${maxLogLines} 条）" readonly></textarea>
  </details>
  </div>`
}

function switchTab(tabId: string): void {
  const dialog = document.getElementById('laplace-chatterbox-dialog')
  if (!dialog) return
  dialog.querySelectorAll('.tab-content').forEach(content => {
    ;(content as HTMLElement).style.display = 'none'
  })
  dialog.querySelectorAll('.tab-btn').forEach(btn => {
    ;(btn as HTMLElement).style.borderBottom = '1px solid transparent'
    ;(btn as HTMLElement).style.fontWeight = 'normal'
  })
  const contentEl = document.getElementById(`content-${tabId}`)
  if (contentEl) contentEl.style.display = 'block'
  const tabBtn = document.getElementById(`tab-${tabId}`)
  if (tabBtn) {
    ;(tabBtn as HTMLElement).style.borderBottom = '1px solid #36a185'
    ;(tabBtn as HTMLElement).style.fontWeight = 'bold'
  }
  GM_setValue('activeTab', tabId)
}

/**
 * Waits for document.body, then creates the UI and starts the loop.
 */
export function initUI(): void {
  const check = setInterval(() => {
    if (!document.body) return

    const toggleBtn = document.createElement('div')
    toggleBtn.id = 'toggleBtn'
    toggleBtn.textContent = '弹幕助手'
    toggleBtn.style.cssText = `
      position: fixed;
      right: 4px;
      bottom: 4px;
      z-index: 2147483647;
      cursor: pointer;
      background: #777;
      color: white;
      padding: 6px 8px;
      border-radius: 4px;
      user-select: none;
    `
    document.body.appendChild(toggleBtn)

    const list = document.createElement('div')
    list.id = 'laplace-chatterbox-dialog'
    list.style.cssText = `
      position: fixed;
      right: 4px;
      bottom: calc(4px + 30px);
      z-index: 2147483647;
      background: var(--bg1, #fff);
      display: none;
      padding: 10px;
      box-shadow: 0 0 0 1px var(--Ga2, rgba(0, 0, 0, .2));
      border-radius: 4px;
      min-width: 50px;
      max-height: calc(100vh - 64px);
      overflow-y: auto;
      width: 300px;
    `

    const scopedStyles = document.createElement('style')
    scopedStyles.textContent = `
      #toggleBtn,
      #laplace-chatterbox-dialog,
      #laplace-chatterbox-dialog * {
        font-size: 12px !important;
      }
      #laplace-chatterbox-dialog input {
        border: 1px solid;
        outline: none;
      }
    `
    document.head.appendChild(scopedStyles)

    const getVal: GetVal = (key, def) => GM_getValue(key, def)
    list.innerHTML = getDialogHTML(getVal)
    document.body.appendChild(list)

    const activeTab = (GM_getValue('activeTab', 'dulunche') as string) ?? 'dulunche'

    document.getElementById('tab-dulunche')?.addEventListener('click', () => switchTab('dulunche'))
    document.getElementById('tab-fasong')?.addEventListener('click', () => switchTab('fasong'))
    document.getElementById('tab-tongchuan')?.addEventListener('click', () => switchTab('tongchuan'))
    document.getElementById('tab-settings')?.addEventListener('click', () => switchTab('settings'))

    switchTab(activeTab)

    toggleBtn.addEventListener('click', () => {
      list.style.display = list.style.display === 'none' ? 'block' : 'none'
    })

    setupAutoSend(toggleBtn, list)
    setupManualSend()
    setupTranscription()
    setupSettings()

    loop()
    clearInterval(check)
  }, 100)
}
