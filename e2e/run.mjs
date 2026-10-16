// End-to-end check in a real Chromium with the unpacked extension loaded.
// Usage: npm run e2e   (builds an E2E variant whose Silk backend is the mock server; screenshots → e2e/output/)
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.env.PLAYWRIGHT_BROWSERS_PATH ??= 'D:\\DevCache\\ms-playwright'
const { chromium } = await import('playwright')
const { startMockServer, stats, cloud, ALL_MODELS } = await import('./mock-server.mjs')

const MOCK_PORT = 18787
const MOCK_ORIGIN = `http://127.0.0.1:${MOCK_PORT}`
const OUT = resolve('e2e/output')
mkdirSync(OUT, { recursive: true })

// Build a variant whose Silk backend is the mock server (a packaged build would hit production).
const DIST = join(OUT, 'ext')
execFileSync(process.execPath, ['build.mjs'], { stdio: 'inherit', env: { ...process.env, SILK_API_URL: MOCK_ORIGIN, SILK_OUTDIR: DIST } })

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push([true, name])
    console.log(`  ✓ ${name}`)
  } catch (err) {
    results.push([false, name])
    console.log(`  ✗ ${name}\n      ${String(err?.message ?? err).split('\n')[0]}`)
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message)
}

const server = await startMockServer(MOCK_PORT)
const origin = MOCK_ORIGIN
const profile = mkdtempSync(join(tmpdir(), 'silk-e2e-'))
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  viewport: { width: 1100, height: 760 },
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
})

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  const extensionId = new URL(worker.url()).host
  // Settings left over from older versions (engine, API key) must be ignored, and the chosen model is
  // locked during the beta (requests fall back to the cheapest); Chinese UI for the checks below.
  await worker.evaluate(() =>
    chrome.storage.local.set({ settings: { provider: 'openai', apiKey: 'sk-test', model: 'google/gemini-3.8-flash', uiLang: 'zh-CN' } }),
  )

  const page = await context.newPage()
  await page.goto(`${origin}/page`)
  await page.waitForFunction(() => document.querySelector('silk-ui'))
  const initialHtml = await page.evaluate(() => {
    window.__link = document.getElementById('link')
    window.__btn = document.getElementById('btn')
    return document.body.innerHTML
  })
  const text = (sel) => page.$eval(sel, (el) => el.textContent)

  console.log('\n覆盖模式 (Alt+T)')
  await page.keyboard.press('Alt+T')
  await check('首屏段落被翻译（429 后自动重试成功）', async () => {
    await page.waitForFunction(() => document.getElementById('p1').textContent.includes('译·'), null, { timeout: 15000 })
    assert(stats.rateLimited === 1, `rateLimited=${stats.rateLimited}`)
  })
  await check('请求走 Silk 后端：测试期只用最便宜的模型、匿名安装 ID、不带 API Key', async () => {
    assert(cloud.models.length > 0 && cloud.models.every((m) => m === 'deepseek/deepseek-v4-flash'), cloud.models.join(','))
    assert(cloud.installIds.size === 1, `install ids ${cloud.installIds.size}`)
    assert(cloud.withAuthorization === 0, 'Authorization header leaked to the Silk backend')
  })
  await check('内联结构保留：链接节点、href、strong、code 都没变', async () => {
    const info = await page.evaluate(() => ({
      sameLink: document.getElementById('link') === window.__link,
      href: document.getElementById('link').href,
      linkText: document.getElementById('link').textContent,
      strong: document.querySelector('#p1 strong').textContent,
      code: document.querySelector('#p1 code').textContent,
    }))
    assert(info.sameLink, 'link node replaced')
    assert(info.href === 'https://example.com/guide', info.href)
    assert(info.linkText === '译·this guide', info.linkText)
    assert(info.strong === '译·error handling', info.strong)
    assert(info.code === 'npm test', info.code)
  })
  await check('按钮事件监听仍然有效', async () => {
    await page.waitForFunction(() => document.getElementById('btn').textContent.startsWith('译·'))
    await page.click('#btn')
    const result = await page.evaluate(() => ({ same: document.getElementById('btn') === window.__btn, clicks: window.clicks }))
    assert(result.same && result.clicks === 1, JSON.stringify(result))
  })
  await check('跳过：中文段落、pre、纯数字时间', async () => {
    assert((await text('#zh')) === '这一段已经是中文，不需要翻译。', 'zh changed')
    assert((await text('#pre')) === 'const answer = computeTheAnswer()', 'pre changed')
    assert((await text('#num')) === '2026-10-15 · 12:30', 'num changed')
  })
  await check('Flex 导航项分别翻译', async () => {
    assert((await text('#nav a:nth-child(2)')) === '译·Documentation', await text('#nav a:nth-child(2)'))
  })
  await page.screenshot({ path: join(OUT, '1-overlay.png') })

  await check('懒加载：底部段落尚未请求', async () => {
    await page.waitForTimeout(800)
    assert(!(await text('#last')).includes('译·'), 'bottom paragraph translated too early')
    assert(stats.items < 40, `items requested before scroll: ${stats.items}`)
  })
  const itemsBeforeScroll = stats.items
  await check('滚动到底部后加载剩余段落', async () => {
    await page.evaluate(() => document.getElementById('last').scrollIntoView())
    await page.waitForFunction(() => document.getElementById('last').textContent.includes('译·'), null, { timeout: 15000 })
    assert(stats.items > itemsBeforeScroll, 'no new requests after scroll')
  })
  await check(`并发不超过 4（峰值 ${stats.peak}）且每段只请求一次`, async () => {
    assert(stats.peak <= 4, `peak ${stats.peak}`)
    assert(stats.items === stats.keys.size, `items ${stats.items} vs unique ${stats.keys.size}`)
  })
  await page.evaluate(() => scrollTo(0, 0))

  console.log('\n模式切换（全部来自缓存）')
  const requestsBeforeSwitch = stats.batchRequests
  await check('双语模式：原文恢复 + 译文元素插入', async () => {
    await page.click('silk-ui .seg button[data-mode="bilingual"]')
    await page.waitForSelector('#p1 silk-trans')
    assert((await text('#link')) === 'this guide', 'original not restored')
    const trans = await page.$eval('#p1 silk-trans', (el) => ({ text: el.textContent, href: el.querySelector('a')?.getAttribute('href') }))
    assert(trans.text.includes('译·this guide') && trans.href === 'https://example.com/guide', JSON.stringify(trans))
  })
  await page.screenshot({ path: join(OUT, '2-bilingual.png') })
  await check('切回原文：DOM 与初始 HTML 完全一致', async () => {
    await page.click('silk-ui .seg button[data-mode="original"]')
    await page.waitForFunction(() => !document.querySelector('silk-trans'))
    const html = await page.evaluate(() => document.body.innerHTML)
    assert(html === initialHtml, 'DOM differs from the original')
  })
  await check('切换期间零新增 API 请求', async () => {
    await page.keyboard.press('Alt+T')
    await page.waitForFunction(() => document.getElementById('p1').textContent.includes('译·'))
    assert(stats.batchRequests === requestsBeforeSwitch, `${stats.batchRequests} vs ${requestsBeforeSwitch}`)
  })

  console.log('\nSPA 兼容')
  await check('框架改写文本节点后自动重新翻译', async () => {
    await page.evaluate(() => (document.getElementById('dyn').firstChild.nodeValue = 'Status changed by the app.'))
    await page.waitForFunction(() => document.getElementById('dyn').textContent === '译·Status changed by the app.', null, { timeout: 10000 })
  })
  await check('动态插入的新段落自动翻译', async () => {
    await page.evaluate(() => {
      const p = document.createElement('p')
      p.id = 'spa'
      p.textContent = 'Freshly inserted paragraph from the router.'
      document.getElementById('main').prepend(p)
    })
    await page.waitForFunction(() => document.getElementById('spa').textContent.startsWith('译·'), null, { timeout: 10000 })
  })

  console.log('\n划词翻译')
  await check('选中文字 → 图标 → 流式翻译卡片', async () => {
    await page.click('silk-ui .seg button[data-mode="original"]')
    await page.click('#title', { clickCount: 3 })
    await page.waitForSelector('silk-ui .trigger:not([hidden])')
    await page.click('silk-ui .trigger')
    await page.waitForFunction(
      () => document.querySelector('silk-ui').shadowRoot.querySelector('.result').textContent.includes('划词译文：Building'),
      null,
      { timeout: 10000 },
    )
    assert((await page.$eval('silk-ui', (el) => el.shadowRoot.querySelector('.chip').textContent)) === '→ 简体中文', 'chip')
  })
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(OUT, '3-selection.png') })

  console.log('\nPopup')
  const popup = await context.newPage()
  await popup.setViewportSize({ width: 372, height: 900 })
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)
  await check('Popup 显示测试版与今日额度（200万字）', async () => {
    await popup.waitForFunction(() => document.getElementById('test-result').textContent.includes('今日已用'))
    const result = await popup.$eval('#test-result', (el) => el.textContent)
    assert(result.includes('测试版') && result.includes('1234') && result.includes('200万'), result)
    assert((await popup.$eval('#conn', (el) => el.textContent)) === '可用', 'conn pill')
    assert(!(await popup.$eval('#beta-badge', (el) => el.hidden)), 'beta badge hidden')
  })
  const modelCards = () =>
    popup.$$eval('.model', (cards) => cards.map((c) => [c.dataset.value, c.getAttribute('aria-checked'), c.getAttribute('aria-disabled')]))
  const storedModel = () => worker.evaluate(() => chrome.storage.local.get('settings').then((s) => s.settings.model))
  await check('测试期：四个模型里只有 DeepSeek V4 Flash 可选，其余锁定并提示', async () => {
    const cards = await modelCards()
    const expected = [
      ['deepseek/deepseek-v4-flash', 'true', 'false'],
      ['anthropic/claude-haiku-5.5', 'false', 'true'],
      ['openai/gpt-6-sol', 'false', 'true'],
      ['google/gemini-3.8-flash', 'false', 'true'],
    ]
    assert(JSON.stringify(cards) === JSON.stringify(expected), JSON.stringify(cards))
    assert(!(await popup.$eval('#models-hint', (el) => el.hidden)), 'beta hint hidden')
    assert((await popup.$eval('.model[data-value="openai/gpt-6-sol"] .model-note', (el) => el.textContent)) === '正式版开放', 'locked note')
    assert((await popup.$$('#provider, #api-key, #google-key, #base-url')).length === 0, 'old engine controls still present')
  })
  await check('点击锁定的模型无效，点击可用模型写入 storage', async () => {
    await popup.click('.model[data-value="anthropic/claude-haiku-5.5"]', { force: true })
    await popup.waitForTimeout(300)
    assert((await storedModel()) === 'google/gemini-3.8-flash', await storedModel())
    await popup.click('.model[data-value="deepseek/deepseek-v4-flash"]')
    await popup.waitForTimeout(300)
    assert((await storedModel()) === 'deepseek/deepseek-v4-flash', await storedModel())
  })
  await check('修改目标语言写入 storage', async () => {
    await popup.selectOption('#lang', 'ja')
    await popup.waitForTimeout(300)
    const lang = await worker.evaluate(() => chrome.storage.local.get('settings').then((s) => s.settings.targetLang))
    assert(lang === 'ja', lang)
    await popup.selectOption('#lang', 'zh-CN')
  })
  await popup.screenshot({ path: join(OUT, '4-popup-light.png'), fullPage: true })
  await popup.emulateMedia({ colorScheme: 'dark' })
  await popup.waitForTimeout(400) // let background transitions finish
  await popup.screenshot({ path: join(OUT, '5-popup-dark.png'), fullPage: true })
  await popup.emulateMedia({ colorScheme: 'light' })
  await popup.waitForTimeout(400) // let background transitions finish

  console.log('\nEnglish UI')
  await check('界面语言切到 English：Popup 文案与额度显示', async () => {
    await popup.selectOption('#ui-lang', 'en')
    await popup.waitForFunction(() => document.getElementById('test-result').textContent.includes('Used today'))
    assert((await popup.$eval('#translate-btn', (el) => el.textContent.trim())) === 'Translate this page', 'translate button')
    assert((await popup.$eval('#test-result', (el) => el.textContent)).includes('2M'), 'quota in English')
    assert((await popup.$eval('html', (el) => el.lang)) === 'en', 'html lang')
    assert((await popup.$eval('#host', (el) => el.textContent)) === 'chrome-extension page', 'host label')
  })
  await popup.screenshot({ path: join(OUT, '6-popup-english.png'), fullPage: true })
  await check('页面 HUD 随之切换为英文', async () => {
    await page.waitForFunction(() => {
      const root = document.querySelector('silk-ui').shadowRoot
      return root.querySelector('.seg button[data-mode="original"]').textContent === 'Original'
    })
  })
  await popup.selectOption('#ui-lang', 'zh-CN')
  await popup.waitForFunction(() => document.getElementById('test-result').textContent.includes('今日已用'))

  {
    console.log('\nSilk AI 云端引擎（mock 后端）')
    const selectAndTranslate = async (selector) => {
      await page.bringToFront()
      await page.mouse.click(5, 5)
      await page.click(selector, { clickCount: 3 })
      await page.waitForSelector('silk-ui .trigger:not([hidden])')
      await page.click('silk-ui .trigger')
    }
    const cardText = () => page.$eval('silk-ui', (el) => el.shadowRoot.querySelector('.result')?.textContent ?? '')
    await check('直接请求锁定模型会被后端拒绝（403 model_locked）', async () => {
      const res = await fetch(`${origin}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Silk-Install': [...cloud.installIds][0] },
        body: JSON.stringify({ model: 'openai/gpt-6-sol', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      })
      assert(res.status === 403 && res.headers.get('x-silk-error') === 'model_locked', `${res.status}`)
    })
    await check('正式版（pro）解锁全部模型：选 GPT-6 Sol 后请求使用它', async () => {
      cloud.plan = 'pro'
      cloud.planModels = ALL_MODELS
      await popup.bringToFront()
      await popup.click('#test-btn')
      await popup.waitForFunction(() => document.querySelectorAll('.model[aria-disabled="true"]').length === 0)
      assert(await popup.$eval('#models-hint', (el) => el.hidden), 'beta hint still shown')
      await popup.click('.model[data-value="openai/gpt-6-sol"]')
      await popup.waitForTimeout(300)
      assert((await storedModel()) === 'openai/gpt-6-sol', await storedModel())
      const before = cloud.models.length
      await selectAndTranslate('#p2')
      await page.waitForFunction(() => document.querySelector('silk-ui').shadowRoot.querySelector('.result').textContent.includes('划词译文'), null, {
        timeout: 10000,
      })
      assert(cloud.models.slice(before).every((m) => m === 'openai/gpt-6-sol') && cloud.models.length > before, cloud.models.slice(before).join(','))
      cloud.plan = 'beta'
      cloud.planModels = ALL_MODELS.slice(0, 1)
      await popup.click('#test-btn')
      await popup.waitForFunction(() => document.querySelectorAll('.model[aria-disabled="true"]').length === 3)
    })
    await check('划词翻译走 Silk 后端：测试期回落到最便宜的模型、匿名安装 ID、不带 API Key', async () => {
      const before = cloud.models.length
      await selectAndTranslate('#title')
      await page.waitForFunction(
        () => document.querySelector('silk-ui').shadowRoot.querySelector('.result').textContent.includes('划词译文：Building'),
        null,
        { timeout: 10000 },
      )
      assert(cloud.models.slice(before).every((m) => m === 'deepseek/deepseek-v4-flash') && cloud.models.length > before, cloud.models.slice(before).join(','))
      assert(cloud.installIds.size === 1, `install ids ${cloud.installIds.size}`)
      assert(cloud.withAuthorization === 0, 'Authorization header leaked to the Silk backend')
    })
    await check('额度用完：显示友好提示且不重试', async () => {
      cloud.isQuotaExhausted = true
      const before = cloud.requests
      await selectAndTranslate('#p1')
      await page.waitForFunction(
        () => document.querySelector('silk-ui').shadowRoot.querySelector('.result')?.textContent.includes('额度'),
        null,
        { timeout: 10000 },
      )
      await page.waitForTimeout(1500)
      assert(cloud.requests - before === 1, `requests after quota error: ${cloud.requests - before}`)
      assert((await cardText()).includes('免费额度已用完'), await cardText())
    })
    await page.screenshot({ path: join(OUT, '7-quota.png') })
  }
} finally {
  await context.close()
  server.close()
  rmSync(profile, { recursive: true, force: true })
}

const failed = results.filter(([ok]) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed · batches=${stats.batchRequests} items=${stats.items} peak=${stats.peak}`)
console.log(`screenshots → ${OUT}`)
process.exit(failed ? 1 : 0)
