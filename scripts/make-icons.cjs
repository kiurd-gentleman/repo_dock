// Renders build/icon.svg into the PNG/ICO files Electron and the installer need.
const sharp = require('sharp')
const fs = require('fs')
const pngToIco = require('png-to-ico').default ?? require('png-to-ico')
;(async () => {
  const svg = fs.readFileSync('build/icon.svg')
  await sharp(svg, { density: 384 }).resize(1024, 1024).png().toFile('build/icon.png')
  await sharp(svg, { density: 192 }).resize(256, 256).png().toFile('resources/icon.png')
  const sizes = [16, 24, 32, 48, 64, 128, 256]
  const pngs = await Promise.all(sizes.map((s) => sharp(svg, { density: 384 }).resize(s, s).png().toBuffer()))
  fs.writeFileSync('build/icon.ico', await pngToIco(pngs))
  console.log('icons written')
})().catch((e) => { console.error(e); process.exit(1) })
