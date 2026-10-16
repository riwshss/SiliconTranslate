// End-to-end check in a real Chromium with the unpacked extension loaded.
// Usage: npm run build && npm run e2e   (screenshots → e2e/output/)
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.env.PLAYWRIGHT_BROWSERS_PATH ??= 'D:\\DevCache\\ms-playwright'
const { chromium } = await import('playwright')
const { startMockServer, stats } = await import('./mock-server.mjs')

// EXT_DIR lets the release check run the suite against the packaged build.
const DIST = resolve(process.env.EXT_DIR ?? 'dist')
const OUT = resolve('e2e/output')
mkdirSync(OUT, { recursive: true })

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

const server = await startMockServer()
const origin = `http://127.0.0.1:${server.address().port}`
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
  await worker.evaluate(
    (baseUrl) => chrome.storage.local.set({ settings: { apiKey: 'sk-test', baseUrl, model: 'mock/model-a' } }),
    `${origin}/v1`,
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
  await check('测试连接成功并拉取模型列表', async () => {
    await popup.click('#test-btn')
    await popup.waitForFunction(() => document.getElementById('test-result').textContent.includes('连接成功'))
    assert((await popup.$$eval('#model-list option', (o) => o.length)) === 2, 'models')
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
  await popup.screenshot({ path: join(OUT, '5-popup-dark.png'), fullPage: true })
} finally {
  await context.close()
  server.close()
  rmSync(profile, { recursive: true, force: true })
}

const failed = results.filter(([ok]) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed · batches=${stats.batchRequests} items=${stats.items} peak=${stats.peak}`)
console.log(`screenshots → ${OUT}`)
process.exit(failed ? 1 : 0)
