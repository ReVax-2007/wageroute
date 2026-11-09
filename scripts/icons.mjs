// Regenerates every logo and icon from the one source of truth, build/icon.svg.
//
//   npm run icons        (runs this file with Electron; macOS for the .icns)
//
// SVG copies (used as-is wherever an SVG works):
//   assets/logo.svg                        website favicon, nav and footer
//   src/pocket/public/favicon.svg          Pocket favicon, welcome mark, manifest
//   src/renderer/src/assets/wageroute-mark.svg   desktop sidebar mark
//
// Raster files, only where a platform refuses SVG:
//   build/icon.png, build/icon.iconset/*, build/icon.icns   macOS / Linux app icon
//   build/icon.ico                                         Windows app icon
//   src/pocket/public/icon-192.png, icon-512.png           PWA install icons
//   src/pocket/public/icon-maskable-512.png                Android adaptive icon
//   src/pocket/public/apple-touch-icon.png                 iOS home screen
//
// Electron's own Chromium renders the SVG, so the pixels match what a browser
// shows. Nothing here touches app data.

import { app, BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(root, 'build', 'icon.svg')
const svg = readFileSync(SOURCE, 'utf8')

app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.disableHardwareAcceleration()

// Variants of the same artwork for platforms that crop it themselves.
// macOS draws app icons inside a 824px tile with transparent margin.
const macTile = (s) =>
  s.replace('<rect width="1024"', '<g transform="translate(100 100) scale(0.8046875)"><rect width="1024"').replace(
    /<\/svg>\s*$/,
    '</g></svg>'
  )
// Android and iOS apply their own mask: give them a full square and keep the
// mark inside the 80% safe zone.
const fullSquare = (s) =>
  s
    .replace('rx="232"', 'rx="0"')
    .replace('<g filter=', '<g transform="translate(512 512) scale(0.82) translate(-512 -512)"><g filter=')
    .replace(/<\/g>\s*<\/svg>\s*$/, '</g></g></svg>')

let win
async function render(source, size) {
  const data = Buffer.from(source).toString('base64')
  const html = `<!doctype html><html><body style="margin:0;background:transparent">
    <img id="i" width="${size}" height="${size}" style="display:block" src="data:image/svg+xml;base64,${data}">
    </body></html>`
  win.setContentSize(size, size)
  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'))
  await win.webContents.executeJavaScript('document.getElementById("i").decode().then(() => true)')
  await new Promise((r) => setTimeout(r, 60))
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })
  const { width, height } = image.getSize()
  if (width !== size || height !== size) throw new Error(`rendered ${width}x${height}, wanted ${size}`)
  return image.toPNG()
}

// A Windows .ico holding PNG-compressed images (supported since Vista).
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, png }, i) => {
    const at = 6 + 16 * i
    header.writeUInt8(size >= 256 ? 0 : size, at)
    header.writeUInt8(size >= 256 ? 0 : size, at + 1)
    header.writeUInt8(0, at + 2)
    header.writeUInt8(0, at + 3)
    header.writeUInt16LE(1, at + 4)
    header.writeUInt16LE(32, at + 6)
    header.writeUInt32LE(png.length, at + 8)
    header.writeUInt32LE(offset, at + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...images.map((x) => x.png)])
}

const out = (rel, data) => {
  const file = join(root, rel)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, data)
  process.stdout.write(`wrote ${rel}\n`)
}

async function main() {
  win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1024,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    useContentSize: true,
    webPreferences: { offscreen: true }
  })

  for (const rel of ['assets/logo.svg', 'src/pocket/public/favicon.svg', 'src/renderer/src/assets/wageroute-mark.svg']) {
    copyFileSync(SOURCE, join(root, rel))
    process.stdout.write(`copied build/icon.svg -> ${rel}\n`)
  }

  const tile = macTile(svg)
  out('build/icon.png', await render(tile, 1024))

  const iconset = join(root, 'build', 'icon.iconset')
  rmSync(iconset, { recursive: true, force: true })
  for (const base of [16, 32, 128, 256, 512]) {
    out(`build/icon.iconset/icon_${base}x${base}.png`, await render(tile, base))
    out(`build/icon.iconset/icon_${base}x${base}@2x.png`, await render(tile, base * 2))
  }
  if (process.platform === 'darwin') {
    execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(root, 'build', 'icon.icns')])
    process.stdout.write('wrote build/icon.icns\n')
  } else {
    process.stdout.write('skipped build/icon.icns (iconutil is macOS-only)\n')
  }

  const icoImages = []
  for (const size of [16, 24, 32, 48, 64, 128, 256]) icoImages.push({ size, png: await render(svg, size) })
  out('build/icon.ico', ico(icoImages))

  out('src/pocket/public/icon-192.png', await render(svg, 192))
  out('src/pocket/public/icon-512.png', await render(svg, 512))
  const square = fullSquare(svg)
  out('src/pocket/public/icon-maskable-512.png', await render(square, 512))
  out('src/pocket/public/apple-touch-icon.png', await render(square, 180))
}

app.whenReady().then(async () => {
  try {
    await main()
  } catch (error) {
    process.stderr.write(`icons: ${error.message}\n`)
    process.exitCode = 1
  } finally {
    app.quit()
  }
})
