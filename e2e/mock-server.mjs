// Fake Silk backend for E2E: issues install tokens, streams deterministic "translations" in the
// /v1/translate event format, answers the first batch with 429 to exercise backoff, and records
// concurrency. Every request must carry an issued token in X-Silk-Install and no API key;
// /v1/entitlement reports the plan, and the quota can be switched to exhausted.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

const FIXTURE = readFileSync(new URL('./fixture.html', import.meta.url), 'utf8')
const CHUNK = 9
const CHUNK_DELAY_MS = 12

export const stats = { batchRequests: 0, items: 0, textRequests: 0, rateLimited: 0, active: 0, peak: 0, keys: new Set() }
/** Every model the extension offers, cheapest (the only one open during the beta) first. */
export const ALL_MODELS = ['deepseek/deepseek-v4-flash', 'anthropic/claude-haiku-5.5', 'openai/gpt-6-sol', 'google/gemini-3.8-flash']
/**
 * Silk backend side: requests seen, tokens issued and used, models asked for, request bodies,
 * the current plan and its models (switchable to pro), and a switch that makes every request
 * over quota.
 */
export const cloud = {
  requests: 0,
  quotaHits: 0,
  issued: new Set(),
  installIds: new Set(),
  bodies: [],
  models: [],
  withAuthorization: 0,
  isQuotaExhausted: false,
  plan: 'beta',
  planModels: ALL_MODELS.slice(0, 1),
}
const JSON_CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }

/** "Click <g0>this guide</g0> now" → "译·Click <g0>译·this guide</g0> 译·now" (frozen <cN> content kept). */
export function fakeTranslate(markup) {
  let frozenDepth = 0
  return markup
    .split(/(<\/?[gc]\d+\/?>)/)
    .map((part) => {
      if (/^<\/?[gc]\d+\/?>$/.test(part)) {
        if (/^<c\d+>$/.test(part)) frozenDepth++
        if (/^<\/c\d+>$/.test(part)) frozenDepth--
        return part
      }
      if (frozenDepth > 0 || !part.trim()) return part
      const [, lead, body, tail] = part.match(/^(\s*)([\s\S]*?)(\s*)$/)
      return `${lead}译·${body}${tail}`
    })
    .join('')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Writes /v1/translate events one by one, then [DONE]. */
async function streamEvents(res, events) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' })
  for (const event of events) {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
    await sleep(CHUNK_DELAY_MS)
  }
  res.end('data: [DONE]\n\n')
}

const deltas = (text) => Array.from({ length: Math.ceil(text.length / CHUNK) }, (_, i) => ({ delta: text.slice(i * CHUNK, (i + 1) * CHUNK) }))

function readBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => resolve(body))
  })
}

function handleInstall(_req, res) {
  const token = `${crypto.randomUUID()}.${'s'.repeat(43)}`
  cloud.issued.add(token)
  res.writeHead(200, JSON_CORS)
  res.end(JSON.stringify({ success: true, data: { token }, error: null, meta: null }))
}

/** Silk backend auth: a token this server issued, no API key. Returns false once it has answered the request. */
function acceptCloud(req, res) {
  const id = req.headers['x-silk-install']
  if (!cloud.issued.has(id)) {
    res.writeHead(401, { ...JSON_CORS, 'X-Silk-Error': 'unauthorized' })
    res.end(JSON.stringify({ success: false, data: null, error: { code: 'unauthorized', message: 'bad install token' } }))
    return false
  }
  cloud.installIds.add(id)
  if (req.headers.authorization) cloud.withAuthorization++
  return true
}

function handleEntitlement(req, res) {
  if (!acceptCloud(req, res)) return
  const quota = { used: cloud.isQuotaExhausted ? 100000 : 1234, limit: 100000, resetAt: '2026-10-18T00:00:00.000Z' }
  res.writeHead(200, JSON_CORS)
  res.end(JSON.stringify({ success: true, data: { plan: cloud.plan, features: ['cloud-ai'], models: cloud.planModels, quota }, error: null, meta: null }))
}

async function handleTranslate(req, res) {
  const body = JSON.parse(await readBody(req))
  if (!acceptCloud(req, res)) return
  cloud.requests++
  cloud.models.push(body.model)
  cloud.bodies.push(body)
  if (body.model && !cloud.planModels.includes(body.model)) {
    res.writeHead(403, { ...JSON_CORS, 'X-Silk-Error': 'model_locked' })
    return res.end(JSON.stringify({ success: false, data: null, error: { code: 'model_locked', message: 'This model is not available on your plan' } }))
  }
  if (cloud.isQuotaExhausted) {
    cloud.quotaHits++
    res.writeHead(429, { ...JSON_CORS, 'X-Silk-Error': 'quota_exceeded' })
    return res.end(JSON.stringify({ success: false, data: null, error: { code: 'quota_exceeded', message: 'Daily free quota used up' } }))
  }
  if (body.kind === 'selection') {
    stats.textRequests++
    return streamEvents(res, deltas(`划词译文：${body.texts[0]}`))
  }
  stats.batchRequests++
  if (stats.batchRequests === 1) {
    stats.rateLimited++
    res.writeHead(429, { 'Retry-After': '1', 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    return res.end(JSON.stringify({ message: 'TPM limit reached' }))
  }
  body.texts.forEach((v) => stats.keys.add(v))
  stats.items += body.texts.length
  stats.active++
  stats.peak = Math.max(stats.peak, stats.active)
  try {
    // Paragraphs finish in order, each after a few chunks' worth of time, like a streamed reply.
    await streamEvents(
      res,
      body.texts.map((text, index) => ({ index, text: fakeTranslate(text) })),
    )
  } finally {
    stats.active--
  }
}

/** Port 0 picks a free one; the cloud engine needs a fixed port baked into the E2E build. */
export function startMockServer(port = 0) {
  const server = createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'content-type, x-silk-install',
        'Access-Control-Allow-Methods': 'GET, POST',
      })
      return res.end()
    }
    if (req.url === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(FIXTURE)
    }
    if (req.url === '/v1/entitlement' && req.method === 'GET') return handleEntitlement(req, res)
    if (req.url === '/v1/install' && req.method === 'POST') return handleInstall(req, res)
    if (req.url === '/v1/translate' && req.method === 'POST') {
      return handleTranslate(req, res).catch((err) => {
        console.error(err)
        res.writeHead(500)
        res.end()
      })
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}
