// Fake SiliconFlow (OpenAI-compatible) endpoint for E2E: streams deterministic "translations",
// answers the first batch with 429 to exercise backoff, and records concurrency.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

const FIXTURE = readFileSync(new URL('./fixture.html', import.meta.url), 'utf8')
const CHUNK = 9
const CHUNK_DELAY_MS = 12

export const stats = { batchRequests: 0, items: 0, textRequests: 0, rateLimited: 0, active: 0, peak: 0, keys: new Set() }

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

async function streamText(res, text) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Access-Control-Allow-Origin': '*' })
  for (let i = 0; i < text.length; i += CHUNK) {
    const delta = { choices: [{ delta: { content: text.slice(i, i + CHUNK) } }] }
    res.write(`data: ${JSON.stringify(delta)}\n\n`)
    await sleep(CHUNK_DELAY_MS)
  }
  res.end('data: [DONE]\n\n')
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => resolve(body))
  })
}

async function handleChat(req, res) {
  const body = JSON.parse(await readBody(req))
  if (req.headers.authorization !== 'Bearer sk-test') {
    res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    return res.end(JSON.stringify({ message: 'Invalid token' }))
  }
  if (!body.stream) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    return res.end(JSON.stringify({ choices: [{ message: { content: 'p' } }] }))
  }
  const system = body.messages[0].content
  const user = body.messages[1].content
  if (!system.includes('JSON object')) {
    stats.textRequests++
    return streamText(res, `划词译文：${user}`)
  }
  stats.batchRequests++
  if (stats.batchRequests === 1) {
    stats.rateLimited++
    res.writeHead(429, { 'Retry-After': '1', 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    return res.end(JSON.stringify({ message: 'TPM limit reached' }))
  }
  const input = JSON.parse(user)
  Object.values(input).forEach((v) => stats.keys.add(v))
  stats.items += Object.keys(input).length
  const output = Object.fromEntries(Object.entries(input).map(([k, v]) => [k, fakeTranslate(v)]))
  stats.active++
  stats.peak = Math.max(stats.peak, stats.active)
  try {
    await streamText(res, JSON.stringify(output))
  } finally {
    stats.active--
  }
}

export function startMockServer() {
  const server = createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'authorization, content-type',
        'Access-Control-Allow-Methods': 'GET, POST',
      })
      return res.end()
    }
    if (req.url === '/page') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(FIXTURE)
    }
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      return res.end(JSON.stringify({ data: [{ id: 'mock/model-a' }, { id: 'mock/model-b' }] }))
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      return handleChat(req, res).catch((err) => {
        console.error(err)
        res.writeHead(500)
        res.end()
      })
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}
