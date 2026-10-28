// Gera os pacotes do MeuDisc para Windows e Mac a partir deste PC (não precisa de um Mac).
//
//   npm run build                              -> todos
//   node scripts/build.js win32-x64            -> só Windows
//   node scripts/build.js darwin-arm64 darwin-x64
//
// Usa os binários oficiais do Electron e monta os .zip direto, mantendo os links
// simbólicos e permissões que o app de Mac precisa.
const fs = require('fs');
const path = require('path');
const { once } = require('events');
const yauzl = require('yauzl');
const yazl = require('yazl');
const { downloadArtifact } = require('@electron/get');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const electronVersion = require(path.join(root, 'node_modules', 'electron', 'package.json')).version;
const dist = path.join(root, 'dist');
const NAME = pkg.productName;

const TARGETS = {
  'win32-x64': { platform: 'win32', arch: 'x64', out: `${NAME}-Windows.zip` },
  'darwin-arm64': { platform: 'darwin', arch: 'arm64', out: `${NAME}-Mac-AppleSilicon.zip` },
  'darwin-x64': { platform: 'darwin', arch: 'x64', out: `${NAME}-Mac-Intel.zip` },
};

// ------------------------------------------------------------ arquivos do app
function walk(dir, base = dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

// Pacotes de node_modules necessários em tempo de execução (só "dependencies").
function depClosure(names) {
  const out = new Set();
  const visit = (name) => {
    if (out.has(name)) return;
    const dir = path.join(root, 'node_modules', ...name.split('/'));
    if (!fs.existsSync(path.join(dir, 'package.json'))) throw new Error(`faltando o pacote ${name}. Rode "npm install".`);
    out.add(name);
    const p = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    for (const d of Object.keys(p.dependencies || {})) visit(d);
  };
  names.forEach(visit);
  return out;
}

function addDir(files, rel) {
  const dir = path.join(root, rel);
  if (!fs.existsSync(dir)) throw new Error(`faltando ${rel}. Rode "npm install" antes.`);
  for (const f of walk(dir)) files.set(`${rel.split(path.sep).join('/')}/${f}`, fs.readFileSync(path.join(dir, f)));
}

function appFiles(platform) {
  const files = new Map();
  const appPkg = {
    name: pkg.name, productName: pkg.productName, version: pkg.version,
    description: pkg.description, main: pkg.main, author: pkg.author, license: pkg.license,
  };
  files.set('package.json', Buffer.from(JSON.stringify(appPkg, null, 2)));
  for (const f of ['main.js', 'preload.js', 'build/icon.png']) files.set(f, fs.readFileSync(path.join(root, f)));
  addDir(files, 'src');
  addDir(files, 'native');
  // Bloqueador de anúncios (todos) e captura direta da tela pelo koffi (Windows).
  const roots = ['@ghostery/adblocker-electron'];
  if (platform === 'win32') roots.push('koffi', '@koromix/koffi-win32-x64');
  for (const name of depClosure(roots)) addDir(files, path.join('node_modules', ...name.split('/')));
  if (!files.has('src/vendor/peerjs.min.js')) throw new Error('src/vendor está vazio. Rode "npm install" antes.');
  return files;
}

// ------------------------------------------------------------ zip
const openZip = (file) => new Promise((resolve, reject) => {
  yauzl.open(file, { lazyEntries: true, autoClose: true }, (err, zip) => (err ? reject(err) : resolve(zip)));
});

const readEntry = (zip, entry) => new Promise((resolve, reject) => {
  zip.openReadStream(entry, (err, stream) => {
    if (err) return reject(err);
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
});

async function repack(srcZip, outZip, { rename, transform, extra }) {
  const out = new yazl.ZipFile();
  const ws = fs.createWriteStream(outZip);
  out.outputStream.pipe(ws);
  const zip = await openZip(srcZip);
  await new Promise((resolve, reject) => {
    zip.on('entry', async (entry) => {
      try {
        const name = rename(entry.fileName);
        if (name) {
          const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
          const mtime = entry.getLastModDate();
          if (entry.fileName.endsWith('/')) {
            out.addEmptyDirectory(name, { mode: mode || 0o40755, mtime });
          } else {
            let buf = await readEntry(zip, entry);
            if (transform) buf = (await transform(name, buf)) || buf;
            const isLink = (mode & 0o170000) === 0o120000;
            out.addBuffer(buf, name, { mode: mode || 0o100644, mtime, compress: !isLink });
          }
        }
        zip.readEntry();
      } catch (e) {
        reject(e);
      }
    });
    zip.on('end', resolve);
    zip.on('error', reject);
    zip.readEntry();
  });
  for (const [name, buf, mode] of extra) out.addBuffer(buf, name, { mode: mode || 0o100644, mtime: new Date() });
  out.end();
  await once(ws, 'close');
}

// ------------------------------------------------------------ Windows
async function brandExe(buf) {
  try {
    const ResEdit = await import('resedit');
    const exe = ResEdit.NtExecutable.from(buf, { ignoreCert: true });
    const res = ResEdit.NtExecutableResource.from(exe);
    const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(root, 'build', 'icon.ico')));
    const group = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries)[0];
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      res.entries, group ? group.id : 1, group ? group.lang : 1033, ico.icons.map((i) => i.data),
    );
    const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0];
    if (vi) {
      for (const lang of vi.getAllLanguagesForStringValues()) {
        vi.setStringValues(lang, {
          FileDescription: NAME, ProductName: NAME, InternalName: NAME,
          OriginalFilename: `${NAME}.exe`, CompanyName: NAME,
        });
      }
      vi.setFileVersion(pkg.version);
      vi.setProductVersion(pkg.version);
      vi.outputToResourceEntries(res.entries);
    }
    res.outputResource(exe);
    return Buffer.from(exe.generate());
  } catch (e) {
    console.warn('  (não deu para trocar o ícone do .exe, segue com o padrão)', e.message);
    return buf;
  }
}

const WIN_README = `MeuDisc para Windows
====================

1. Extraia esta pasta (botão direito > Extrair tudo).
2. Abra a pasta MeuDisc e dê dois cliques em MeuDisc.exe.
3. Se o Windows mostrar "O Windows protegeu o computador", clique em
   "Mais informações" e depois em "Executar assim mesmo".
   (Isso aparece porque o app não tem assinatura paga da Microsoft.)

Dica: clique com o botão direito em MeuDisc.exe > Enviar para >
Área de trabalho (criar atalho) para ter um atalho.
`;

async function buildWindows(zipPath, outZip, files) {
  const prefix = `${NAME}/`;
  const extra = [...files].map(([f, buf]) => [`${prefix}resources/app/${f}`, buf]);
  extra.push([`LEIA-ME.txt`, Buffer.from(WIN_README.replace(/\n/g, '\r\n'))]);
  await repack(zipPath, outZip, {
    rename: (n) => {
      if (n === 'resources/default_app.asar') return null;
      if (n === 'electron.exe') return `${prefix}${NAME}.exe`;
      return prefix + n;
    },
    transform: (n, buf) => (n.endsWith(`${NAME}.exe`) ? brandExe(buf) : null),
    extra,
  });
}

// ------------------------------------------------------------ Mac
const MAC_README = `MeuDisc para Mac
================

1. Dê dois cliques neste .zip para extrair. Vai aparecer o MeuDisc.app.
2. Arraste o MeuDisc.app para a pasta Aplicativos.
3. Como o app não tem assinatura paga da Apple, o macOS bloqueia na
   primeira vez. Para liberar, abra o Terminal (Cmd+Espaço, digite
   Terminal) e cole esta linha inteira, depois aperte Enter:

   xattr -cr /Applications/MeuDisc.app && codesign --force --deep --sign - /Applications/MeuDisc.app && open /Applications/MeuDisc.app

4. Quando o MeuDisc pedir acesso ao microfone e à câmera, permita.
5. Para compartilhar a tela: Ajustes do Sistema > Privacidade e
   Segurança > Gravação de Tela e Áudio do Sistema > ative o MeuDisc,
   feche e abra o app de novo.
`;

function patchPlist(xml) {
  if (!xml.startsWith('<?xml')) {
    console.warn('  Info.plist não é XML, mantendo o original');
    return null;
  }
  const set = (key, value) => {
    const re = new RegExp(`(<key>${key}</key>\\s*<string>)([^<]*)(</string>)`);
    if (re.test(xml)) xml = xml.replace(re, `$1${value}$3`);
    else xml = xml.replace('<dict>', `<dict>\n\t<key>${key}</key>\n\t<string>${value}</string>`);
  };
  set('CFBundleName', NAME);
  set('CFBundleDisplayName', NAME);
  set('NSMicrophoneUsageDescription', 'O MeuDisc usa o microfone para você conversar com seu amigo.');
  set('NSCameraUsageDescription', 'O MeuDisc usa a câmera para seu amigo te ver.');
  return xml;
}

async function buildMac(zipPath, outZip, files) {
  const app = `${NAME}.app/`;
  const extra = [...files].map(([f, buf]) => [`${app}Contents/Resources/app/${f}`, buf, 0o100644]);
  extra.push([`LEIA-ME.txt`, Buffer.from(MAC_README), 0o100644]);
  const icns = fs.readFileSync(path.join(root, 'build', 'icon.icns'));
  await repack(zipPath, outZip, {
    rename: (n) => {
      if (!n.startsWith('Electron.app/')) return n === 'LICENSE' || n === 'LICENSES.chromium.html' ? `licencas/${n}` : null;
      if (n === 'Electron.app/Contents/Resources/default_app.asar') return null;
      return app + n.slice('Electron.app/'.length);
    },
    transform: (n, buf) => {
      if (n === `${app}Contents/Info.plist`) {
        const patched = patchPlist(buf.toString('utf8'));
        return patched ? Buffer.from(patched, 'utf8') : null;
      }
      if (n === `${app}Contents/Resources/electron.icns`) return icns;
      return null;
    },
    extra,
  });
}

// ------------------------------------------------------------ main
(async () => {
  const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(TARGETS);
  fs.mkdirSync(dist, { recursive: true });
  for (const key of wanted) {
    const t = TARGETS[key];
    if (!t) throw new Error(`alvo desconhecido: ${key}`);
    const files = appFiles(t.platform);
    console.log(`> ${key}: baixando Electron ${electronVersion}…`);
    const zipPath = await downloadArtifact({ version: electronVersion, artifactName: 'electron', platform: t.platform, arch: t.arch });
    const outZip = path.join(dist, t.out);
    console.log(`> ${key}: montando ${t.out}…`);
    if (t.platform === 'win32') await buildWindows(zipPath, outZip, files);
    else await buildMac(zipPath, outZip, files);
    console.log(`  pronto: ${path.relative(root, outZip)} (${(fs.statSync(outZip).size / 1e6).toFixed(0)} MB)`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
