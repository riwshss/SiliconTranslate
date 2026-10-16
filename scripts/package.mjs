// Release pipeline: typecheck → unit tests → production build → release/<name>-v<version>.zip
// plus an unpacked copy ready for chrome://extensions → 加载已解压的扩展程序.
import { execSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'

const DIST = 'dist'
const RELEASE = 'release'
const ZIP_NAME = 'silk-translate'

function run(command) {
  console.log(`\n▶ ${command}`)
  execSync(command, { stdio: 'inherit' })
}

function listFiles(dir) {
  return readdirSync(dir)
    .flatMap((name) => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? listFiles(path) : [path]
    })
    .sort()
}

/** DOS date/time fields used by the zip format. */
function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

/** Minimal zip writer (deflate, UTF-8 names) — enough for an extension package. */
function createZip(rootDir, files) {
  const { time, day } = dosDateTime(new Date())
  const locals = []
  const centrals = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(relative(rootDir, file).split(sep).join('/'), 'utf8')
    const data = readFileSync(file)
    const packed = deflateRawSync(data, { level: 9 })
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, packed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(day, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + packed.length
  }
  const centralSize = centrals.reduce((sum, buf) => sum + buf.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}

function assertManifest(version) {
  const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'))
  if (manifest.version !== version) {
    throw new Error(`manifest.json version ${manifest.version} ≠ package.json version ${version}`)
  }
  const required = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    // Registered at runtime for the sites the user grants (see background), not in the manifest.
    'content.js',
  ]
  const missing = required.filter((file) => !statSync(join(DIST, file), { throwIfNoEntry: false }))
  if (missing.length) throw new Error(`dist/ is missing: ${missing.join(', ')}`)
  for (const key of new Set([...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)].map(([, key]) => key))) {
    for (const locale of readdirSync(join(DIST, '_locales'))) {
      const messages = JSON.parse(readFileSync(join(DIST, '_locales', locale, 'messages.json'), 'utf8'))
      if (!messages[key]?.message) throw new Error(`_locales/${locale} is missing "${key}"`)
    }
  }
  const maps = listFiles(DIST).filter((file) => file.endsWith('.map'))
  if (maps.length) throw new Error(`source maps must not ship: ${maps.join(', ')}`)
}

const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
run('npm run typecheck')
run('npm test')
run('npm run build')
assertManifest(version)

const baseName = `${ZIP_NAME}-v${version}`
const zipPath = join(RELEASE, `${baseName}.zip`)
const unpackedPath = join(RELEASE, baseName)
mkdirSync(RELEASE, { recursive: true })
rmSync(unpackedPath, { recursive: true, force: true })
cpSync(DIST, unpackedPath, { recursive: true })

const files = listFiles(DIST)
writeFileSync(zipPath, createZip(DIST, files))
const sizeKb = (statSync(zipPath).size / 1024).toFixed(1)
console.log(`\n✔ ${zipPath}  (${files.length} files, ${sizeKb} KB)`)
console.log(`✔ ${unpackedPath}${sep}  (chrome://extensions → 加载已解压的扩展程序)`)
