// Copia as bibliotecas usadas pela interface para src/vendor, para o app
// funcionar sem depender de CDN (e também como página web estática).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const nm = path.join(root, 'node_modules');
const out = path.join(root, 'src', 'vendor');

function copy(from, to) {
  const src = path.join(nm, from);
  if (!fs.existsSync(src)) {
    console.warn('[vendor] não encontrado:', from);
    return;
  }
  const dst = path.join(out, to);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

copy('peerjs/dist/peerjs.min.js', 'peerjs.min.js');

const fonts = [
  ['@fontsource/big-shoulders-display/files/big-shoulders-display-latin-600-normal.woff2', 'fonts/display-600.woff2'],
  ['@fontsource/big-shoulders-display/files/big-shoulders-display-latin-800-normal.woff2', 'fonts/display-800.woff2'],
  ['@fontsource/instrument-sans/files/instrument-sans-latin-400-normal.woff2', 'fonts/sans-400.woff2'],
  ['@fontsource/instrument-sans/files/instrument-sans-latin-500-normal.woff2', 'fonts/sans-500.woff2'],
  ['@fontsource/instrument-sans/files/instrument-sans-latin-600-normal.woff2', 'fonts/sans-600.woff2'],
];
for (const [from, to] of fonts) copy(from, to);

console.log('[vendor] ok');
