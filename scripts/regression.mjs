// Translation quality regression run against a real Silk backend (not part of CI: it costs quota).
//
//   node scripts/regression.mjs [--target zh-TW] [--model <id>] [--api <url>] [--baseline <run.json>]
//
// Translates every paragraph of tests/fixtures/regression/paragraphs.json, checks markers, kept
// text and the target's required / forbidden terms, and writes regression-output/<run>.json plus a
// Markdown report. With --baseline (an earlier run's .json) the report also lists every paragraph
// whose translation changed, side by side, for a human to judge.
//
// The install token is read from SILK_TOKEN, else regression-output/token.txt, else requested once
// from /v1/install and saved there (each network only gets a few per day). The backend's shared
// cache answers paragraphs it has seen before; it is keyed by PROMPT_VERSION
// (src/core/prompt.ts), so bump that whenever the prompt changes to get fresh translations.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { checkTranslation } from './regression-check.mjs'

const DEFAULT_API = 'https://silk-translate-api.silktranslate.workers.dev'
const OUT = 'regression-output'
const MAX_ITEMS = 12
const MAX_CHARS = 1800
const PARALLEL = 3

const { values: args } = parseArgs({
  options: {
    target: { type: 'string', default: 'zh-TW' },
    model: { type: 'string' },
    api: { type: 'string', default: process.env.SILK_API_URL || DEFAULT_API },
    baseline: { type: 'string' },
  },
})
const api = args.api.replace(/\/+$/, '')
const fixture = JSON.parse(readFileSync('tests/fixtures/regression/paragraphs.json', 'utf8'))
mkdirSync(OUT, { recursive: true })

async function installToken() {
  if (process.env.SILK_TOKEN) return process.env.SILK_TOKEN
  const file = join(OUT, 'token.txt')
  if (existsSync(file)) return readFileSync(file, 'utf8').trim()
  const res = await fetch(`${api}/v1/install`, { method: 'POST' })
  const body = await res.json()
  if (!body?.success) throw new Error(`install failed: HTTP ${res.status} ${JSON.stringify(body?.error)}`)
  writeFileSync(file, body.data.token)
  return body.data.token
}

function batches(items) {
  const out = []
  let batch = []
  let chars = 0
  for (const item of items) {
    if (batch.length && (batch.length >= MAX_ITEMS || chars + item.source.length > MAX_CHARS)) {
      out.push(batch)
      batch = []
      chars = 0
    }
    batch.push(item)
    chars += item.source.length
  }
  if (batch.length) out.push(batch)
  return out
}

/** One /v1/translate call; resolves to { index → translation } and the time to the first paragraph. */
async function translate(token, texts, attempt = 0) {
  const started = performance.now()
  const res = await fetch(`${api}/v1/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Silk-Install': token },
    body: JSON.stringify({ ...(args.model ? { model: args.model } : {}), target: args.target, title: 'Silk regression set', kind: 'page', texts }),
  })
  const isTransient = (res.status === 429 && !res.headers.get('x-silk-error')) || res.status >= 500
  if (isTransient && attempt < 3) {
    await res.body?.cancel()
    await new Promise((resolve) => setTimeout(resolve, (Number(res.headers.get('retry-after')) || 2 ** attempt) * 1000))
    return translate(token, texts, attempt + 1)
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.headers.get('x-silk-error') ?? ''} ${await res.text()}`)
  const text = await res.text()
  const results = {}
  let firstMs = null
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data === '[DONE]') break
    const event = JSON.parse(data)
    if (event.error) throw new Error(`${event.error.code}: ${event.error.message}`)
    if (Number.isInteger(event.index)) {
      results[event.index] = event.text
      firstMs ??= Math.round(performance.now() - started)
    }
  }
  return { results, firstMs, totalMs: Math.round(performance.now() - started) }
}

async function run() {
  const token = await installToken()
  const queue = batches(fixture.items)
  const translations = {}
  const timings = []
  const worker = async () => {
    for (let batch = queue.shift(); batch; batch = queue.shift()) {
      const { results, firstMs, totalMs } = await translate(
        token,
        batch.map((item) => item.source),
      )
      batch.forEach((item, i) => (translations[item.id] = results[i]))
      timings.push({ items: batch.length, firstMs, totalMs })
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker))

  const items = fixture.items.map((item) => ({ id: item.id, category: item.category, source: item.source, translation: translations[item.id] ?? null, problems: checkTranslation(item, args.target, translations[item.id]) }))
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const name = `${args.target}-${(args.model ?? 'default').replace(/\//g, '_')}-${stamp}`
  const result = { target: args.target, model: args.model ?? null, api, date: new Date().toISOString(), timings, items }
  writeFileSync(join(OUT, `${name}.json`), `${JSON.stringify(result, null, 2)}\n`)
  writeFileSync(join(OUT, `${name}.md`), report(result, args.baseline ? JSON.parse(readFileSync(args.baseline, 'utf8')) : null))

  const failing = items.filter((item) => item.problems.length)
  console.log(`${items.length - failing.length}/${items.length} paragraphs pass the checks → ${join(OUT, `${name}.md`)}`)
  failing.forEach((item) => console.log(`  ✗ ${item.id}: ${item.problems.join('; ')}`))
}

const cell = (text) => (text ?? '—').replace(/\|/g, '\\|').replace(/\n/g, ' ')

function report(result, baseline) {
  const lines = [`# Regression run: ${result.target} · ${result.model ?? 'plan default'}`, '', `${result.date} · ${result.api}`, '']
  const firsts = result.timings.map((t) => t.firstMs).filter((ms) => ms !== null).sort((a, b) => a - b)
  if (firsts.length) lines.push(`First paragraph per request: median ${firsts[Math.floor(firsts.length / 2)]} ms, max ${firsts.at(-1)} ms`, '')
  const failing = result.items.filter((item) => item.problems.length)
  lines.push(`## Checks: ${result.items.length - failing.length}/${result.items.length} pass`, '')
  if (failing.length) {
    lines.push('| id | problems | translation |', '|---|---|---|')
    failing.forEach((item) => lines.push(`| ${item.id} | ${cell(item.problems.join('; '))} | ${cell(item.translation)} |`))
    lines.push('')
  }
  if (baseline) {
    const before = new Map(baseline.items.map((item) => [item.id, item]))
    const changed = result.items.filter((item) => before.get(item.id)?.translation !== item.translation)
    lines.push(`## Changed since ${baseline.date}: ${changed.length}`, '', '| id | source | before | after |', '|---|---|---|---|')
    changed.forEach((item) => lines.push(`| ${item.id} | ${cell(item.source)} | ${cell(before.get(item.id)?.translation)} | ${cell(item.translation)} |`))
    lines.push('')
  }
  lines.push('## All translations', '', '| id | source | translation |', '|---|---|---|')
  result.items.forEach((item) => lines.push(`| ${item.id} | ${cell(item.source)} | ${cell(item.translation)} |`))
  return `${lines.join('\n')}\n`
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
