// Gera build/icon.png, build/icon.ico e build/icon.icns a partir de build/icon.svg.
// Uso: npx electron scripts/make-icon.js
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'build');
const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');

function ico(images) {
  // ICO com PNG embutido (Windows Vista em diante).
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

function icns(images) {
  const types = { 16: 'icp4', 32: 'icp5', 64: 'icp6', 128: 'ic07', 256: 'ic08', 512: 'ic09', 1024: 'ic10' };
  const chunks = images.filter((i) => types[i.size]).map(({ size, png }) => {
    const h = Buffer.alloc(8);
    h.write(types[size], 0, 'ascii');
    h.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([h, png]);
  });
  const body = Buffer.concat(chunks);
  const h = Buffer.alloc(8);
  h.write('icns', 0, 'ascii');
  h.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([h, body]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false, width: 1024, height: 1024, transparent: true, frame: false,
    webPreferences: { offscreen: true },
  });
  win.webContents.setFrameRate(1);
  const html = `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg width="1024" height="1024" ')}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 500));
  const shot = await win.webContents.capturePage();
  const base = shot.resize({ width: 1024, height: 1024, quality: 'best' });
  const sizes = [16, 32, 48, 64, 128, 256, 512, 1024];
  const images = sizes.map((size) => ({ size, png: base.resize({ width: size, height: size, quality: 'best' }).toPNG() }));
  fs.writeFileSync(path.join(dir, 'icon.png'), images.find((i) => i.size === 512).png);
  fs.writeFileSync(path.join(dir, 'icon.ico'), ico(images.filter((i) => i.size <= 256)));
  fs.writeFileSync(path.join(dir, 'icon.icns'), icns(images));
  console.log('ícones gerados em', dir);
  app.quit();
});
