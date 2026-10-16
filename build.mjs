import { build, context } from 'esbuild'
import { cpSync, mkdirSync, rmSync } from 'node:fs'

const isWatch = process.argv.includes('--watch')
const outdir = 'dist'

const shared = {
  bundle: true,
  target: 'chrome116',
  sourcemap: isWatch ? 'inline' : false,
  minify: !isWatch,
  legalComments: 'none',
  logLevel: 'info',
}

const configs = [
  { ...shared, entryPoints: { background: 'src/background/index.ts' }, outdir, format: 'esm' },
  { ...shared, entryPoints: { content: 'src/content/index.ts' }, outdir, format: 'iife' },
  { ...shared, entryPoints: { popup: 'src/popup/popup.ts' }, outdir, format: 'iife' },
  { ...shared, entryPoints: { offscreen: 'src/offscreen/index.ts' }, outdir, format: 'iife' },
]

function copyStatic() {
  cpSync('static', outdir, { recursive: true })
  cpSync('src/popup/popup.html', `${outdir}/popup.html`)
  cpSync('src/popup/popup.css', `${outdir}/popup.css`)
  cpSync('src/offscreen/offscreen.html', `${outdir}/offscreen.html`)
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
  console.log(`built → ${outdir}/  (load it via chrome://extensions → 加载已解压的扩展程序)`)
}
