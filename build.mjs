import { build, context } from 'esbuild'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

// SILK_API_URL: Silk backend the cloud engine talks to (the deployed Cloudflare Worker).
// SILK_CHANNEL: "beta" (default: everything unlocked, Beta in the name) or "stable".
// SILK_OUTDIR: output folder, so E2E can build a variant without touching dist/.
const DEFAULT_API_URL = 'http://127.0.0.1:8787'

const isWatch = process.argv.includes('--watch')
const outdir = process.env.SILK_OUTDIR || 'dist'
const apiUrl = parseApiUrl(process.env.SILK_API_URL || DEFAULT_API_URL)
const channel = process.env.SILK_CHANNEL === 'stable' ? 'stable' : 'beta'

/** https anywhere, plain http only on loopback (same rule as user-configured endpoints). */
function parseApiUrl(value) {
  const url = new URL(value)
  const isLoopback = ['localhost', '127.0.0.1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new Error(`SILK_API_URL must be https (or http on localhost): ${value}`)
  }
  return url.href.replace(/\/+$/, '')
}

const shared = {
  bundle: true,
  target: 'chrome116',
  sourcemap: isWatch ? 'inline' : false,
  minify: !isWatch,
  legalComments: 'none',
  logLevel: 'info',
  define: {
    __SILK_API_URL__: JSON.stringify(apiUrl),
    __SILK_CHANNEL__: JSON.stringify(channel),
  },
}

const configs = [
  { ...shared, entryPoints: { background: 'src/background/index.ts' }, outdir, format: 'esm' },
  { ...shared, entryPoints: { content: 'src/content/index.ts' }, outdir, format: 'iife' },
  { ...shared, entryPoints: { popup: 'src/popup/popup.ts' }, outdir, format: 'iife' },
  { ...shared, entryPoints: { offscreen: 'src/offscreen/index.ts' }, outdir, format: 'iife' },
]

/** The backend origin must be a host permission; beta builds say so in their name. */
function writeManifest() {
  const manifest = JSON.parse(readFileSync('static/manifest.json', 'utf8'))
  const { protocol, hostname } = new URL(apiUrl)
  const apiHost = `${protocol}//${hostname}/*`
  const hosts = manifest.host_permissions.includes(apiHost) ? manifest.host_permissions : [...manifest.host_permissions, apiHost]
  const beta = channel === 'beta' ? { name: `${manifest.name} Beta`, version_name: `${manifest.version} Beta` } : {}
  const next = { ...manifest, ...beta, host_permissions: hosts }
  writeFileSync(`${outdir}/manifest.json`, `${JSON.stringify(next, null, 2)}\n`)
}

function copyStatic() {
  cpSync('static', outdir, { recursive: true })
  cpSync('src/popup/popup.html', `${outdir}/popup.html`)
  cpSync('src/popup/popup.css', `${outdir}/popup.css`)
  cpSync('src/offscreen/offscreen.html', `${outdir}/offscreen.html`)
  writeManifest()
}

rmSync(outdir, { recursive: true, force: true })
mkdirSync(outdir, { recursive: true })
copyStatic()

if (isWatch) {
  for (const cfg of configs) {
    const ctx = await context(cfg)
    await ctx.watch()
  }
  console.log('watching… (static files are copied once; re-run on manifest/html/css change)')
} else {
  await Promise.all(configs.map((cfg) => build(cfg)))
  console.log(`built → ${outdir}/  [${channel}, api ${apiUrl}]  (load it via chrome://extensions → 加载已解压的扩展程序)`)
}
