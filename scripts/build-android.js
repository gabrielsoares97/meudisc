// Gera dist/MeuDisc-Android.apk sem Android Studio nem Gradle:
// aapt2 (recursos) + javac + d8 (código) + zipalign + apksigner (assinatura).
// Precisa do Android SDK (build-tools e uma plataforma 34 ou mais nova) e de um JDK 17+.
// Uso: npm run build:android
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const yauzl = require('yauzl');
const yazl = require('yazl');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const androidDir = path.join(root, 'android');
const work = path.join(os.tmpdir(), 'meudisc-android-build');
const outApk = path.join(root, 'dist', 'MeuDisc-Android.apk');
const keystore = path.join(androidDir, 'meudisc.keystore');
const keystoreProps = path.join(androidDir, 'keystore.properties');
const MIN_SDK = 26; // Android 8
const TARGET_SDK = 34;
const exe = process.platform === 'win32' ? '.exe' : '';

function fail(msg) {
  console.error(`\n[android] ${msg}`);
  process.exit(1);
}

const verParts = (v) => String(v).split(/[^0-9]+/).filter(Boolean).map(Number);
function cmpVer(a, b) {
  const x = verParts(a);
  const y = verParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}
const subdirs = (dir) => { try { return fs.readdirSync(dir).map((d) => path.join(dir, d)); } catch { return []; } };

function findSdk() {
  const home = os.homedir();
  const candidates = [
    process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
    path.join(home, 'Library', 'Android', 'sdk'), path.join(home, 'Android', 'Sdk'),
  ].filter(Boolean);
  const sdk = candidates.find((d) => fs.existsSync(path.join(d, 'build-tools')));
  if (!sdk) fail('Android SDK não encontrado. Instale o Android Studio (ou as command-line tools) ou defina ANDROID_HOME.');
  return sdk;
}

function findBuildTools(sdk) {
  const ok = subdirs(path.join(sdk, 'build-tools')).filter((d) => ['aapt2' + exe, 'zipalign' + exe, 'lib/d8.jar', 'lib/apksigner.jar']
    .every((f) => fs.existsSync(path.join(d, f))));
  if (!ok.length) fail('Nenhum build-tools completo no Android SDK (precisa de aapt2, d8, zipalign e apksigner).');
  return ok.sort((a, b) => cmpVer(path.basename(a), path.basename(b))).pop();
}

function findPlatformJar(sdk) {
  const list = subdirs(path.join(sdk, 'platforms'))
    .filter((d) => fs.existsSync(path.join(d, 'android.jar')))
    .map((d) => ({ d, v: path.basename(d).replace(/^android-/, '') }))
    .filter((x) => (verParts(x.v)[0] || 0) >= TARGET_SDK);
  if (!list.length) fail(`Instale a plataforma Android ${TARGET_SDK} ou mais nova no SDK.`);
  // Prefere versões estáveis (android-36) às intermediárias (android-37.2).
  list.sort((a, b) => (/^\d+$/.test(a.v) - /^\d+$/.test(b.v)) || cmpVer(a.v, b.v));
  return path.join(list.pop().d, 'android.jar');
}

function findJdk() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const local = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs') : '';
  const candidates = [
    process.env.JAVA_HOME,
    ...subdirs(local).filter((d) => /jdk/i.test(path.basename(d))),
    path.join(pf, 'Android', 'Android Studio', 'jbr'),
    ...subdirs(path.join(pf, 'Eclipse Adoptium')), ...subdirs(path.join(pf, 'Java')), ...subdirs(path.join(pf, 'Microsoft')),
    '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
  ].filter(Boolean);
  const jdk = candidates.find((d) => fs.existsSync(path.join(d, 'bin', 'javac' + exe)));
  if (!jdk) fail('JDK não encontrado (precisa do javac). Instale o JDK 17 ou 21, ou defina JAVA_HOME.');
  return jdk;
}

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...opts }).toString();
  } catch (e) {
    process.stderr.write(String(e.stdout || '') + String(e.stderr || ''));
    fail(`falhou: ${path.basename(cmd)} ${args.slice(0, 2).join(' ')}`);
  }
  return '';
}

function walk(dir, ext) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, ext));
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

// Junta o APK do aapt2 com o classes.dex, mantendo sem compressão o que já estava assim
// (resources.arsc precisa ficar sem compressão no Android 11+).
function mergeDex(baseApk, dexFile, outFile) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const mtime = new Date(2020, 0, 1);
    yauzl.open(baseApk, { lazyEntries: true }, (err, zf) => {
      if (err) return reject(err);
      zf.readEntry();
      zf.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) { zf.readEntry(); return; }
        zf.openReadStream(entry, (e2, stream) => {
          if (e2) return reject(e2);
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('error', reject);
          stream.on('end', () => {
            zip.addBuffer(Buffer.concat(chunks), entry.fileName, { compress: entry.compressionMethod !== 0, mtime });
            zf.readEntry();
          });
        });
      });
      zf.on('end', () => {
        zip.addBuffer(fs.readFileSync(dexFile), 'classes.dex', { compress: true, mtime });
        zip.end();
        zip.outputStream.pipe(fs.createWriteStream(outFile)).on('close', resolve).on('error', reject);
      });
      zf.on('error', reject);
    });
  });
}

function signingKey(java) {
  if (fs.existsSync(keystore) && fs.existsSync(keystoreProps)) {
    const m = /^password=(.+)$/m.exec(fs.readFileSync(keystoreProps, 'utf8'));
    if (m) return m[1].trim();
  }
  if (fs.existsSync(keystore)) fail(`${keystore} existe, mas falta a senha em ${keystoreProps}.`);
  // Primeira vez: cria a chave que assina o app. Guarde estes dois arquivos: atualizações
  // do app só instalam por cima se forem assinadas com a mesma chave.
  const pass = crypto.randomBytes(18).toString('base64url');
  run(path.join(java, 'bin', 'keytool' + exe), [
    '-genkeypair', '-keystore', keystore, '-storetype', 'PKCS12', '-alias', 'meudisc',
    '-keyalg', 'RSA', '-keysize', '3072', '-validity', '10000',
    '-storepass:env', 'MEUDISC_KS_PASS', '-keypass:env', 'MEUDISC_KS_PASS',
    '-dname', 'CN=MeuDisc, O=MeuDisc, C=BR',
  ], { env: { ...process.env, MEUDISC_KS_PASS: pass } });
  fs.writeFileSync(keystoreProps, `# Senha da chave que assina o APK (meudisc.keystore). Não perca nem compartilhe.\npassword=${pass}\n`);
  console.log(`[android] chave de assinatura criada: ${path.relative(root, keystore)}`);
  return pass;
}

async function main() {
  const sdk = findSdk();
  const bt = findBuildTools(sdk);
  const androidJar = findPlatformJar(sdk);
  const jdk = findJdk();
  const java = path.join(jdk, 'bin', 'java' + exe);
  console.log(`[android] SDK ${sdk}\n[android] build-tools ${path.basename(bt)}, plataforma ${path.basename(path.dirname(androidJar))}, JDK ${jdk}`);

  if (!fs.existsSync(path.join(root, 'src', 'vendor', 'peerjs.min.js'))) fail('Faltam os arquivos de src/vendor. Rode "npm install".');

  fs.rmSync(work, { recursive: true, force: true });
  const dirs = ['assets/www', 'gen', 'classes', 'dex'].map((d) => path.join(work, d));
  dirs.forEach((d) => fs.mkdirSync(d, { recursive: true }));
  const [assets, gen, classes, dexDir] = dirs;

  // 1) A interface: os mesmos arquivos do app de PC.
  for (const f of ['index.html', 'styles.css', 'app.js']) fs.copyFileSync(path.join(root, 'src', f), path.join(assets, f));
  fs.cpSync(path.join(root, 'src', 'vendor'), path.join(assets, 'vendor'), { recursive: true });

  // 2) Recursos e manifesto.
  const aapt2 = path.join(bt, 'aapt2' + exe);
  const resZip = path.join(work, 'res.zip');
  const baseApk = path.join(work, 'base.apk');
  const [maj = 1, min = 0, pat = 0] = verParts(pkg.version);
  const versionCode = maj * 10000 + min * 100 + pat;
  run(aapt2, ['compile', '--dir', path.join(androidDir, 'res'), '-o', resZip]);
  run(aapt2, ['link', '-o', baseApk, '-I', androidJar, '--manifest', path.join(androidDir, 'AndroidManifest.xml'),
    '-A', path.join(work, 'assets'), '--java', gen, '--auto-add-overlay',
    '--min-sdk-version', String(MIN_SDK), '--target-sdk-version', String(TARGET_SDK),
    '--version-code', String(versionCode), '--version-name', pkg.version, resZip]);

  // 3) Código Java -> .class -> classes.dex
  const sources = [...walk(path.join(androidDir, 'java'), '.java'), ...walk(gen, '.java')];
  // core-lambda-stubs: o android.jar não traz as classes que o javac usa para compilar lambdas.
  const boot = [androidJar, path.join(bt, 'core-lambda-stubs.jar')].filter((f) => fs.existsSync(f)).join(path.delimiter);
  run(path.join(jdk, 'bin', 'javac' + exe), ['-encoding', 'UTF-8', '-source', '8', '-target', '8', '-Xlint:-options',
    '-bootclasspath', boot, '-classpath', androidJar, '-d', classes, ...sources]);
  run(java, ['-cp', path.join(bt, 'lib', 'd8.jar'), 'com.android.tools.r8.D8', '--release',
    '--min-api', String(MIN_SDK), '--lib', androidJar, '--output', dexDir, ...walk(classes, '.class')]);

  // 4) Junta, alinha e assina.
  const unaligned = path.join(work, 'unaligned.apk');
  const aligned = path.join(work, 'aligned.apk');
  await mergeDex(baseApk, path.join(dexDir, 'classes.dex'), unaligned);
  run(path.join(bt, 'zipalign' + exe), ['-p', '-f', '4', unaligned, aligned]);
  const pass = signingKey(jdk);
  fs.mkdirSync(path.dirname(outApk), { recursive: true });
  const env = { ...process.env, MEUDISC_KS_PASS: pass };
  const apksigner = path.join(bt, 'lib', 'apksigner.jar');
  run(java, ['-jar', apksigner, 'sign', '--ks', keystore, '--ks-key-alias', 'meudisc',
    '--ks-pass', 'env:MEUDISC_KS_PASS', '--key-pass', 'env:MEUDISC_KS_PASS', '--out', outApk, aligned], { env });
  run(java, ['-jar', apksigner, 'verify', outApk]);
  fs.rmSync(`${outApk}.idsig`, { force: true });

  const mb = (fs.statSync(outApk).size / 1048576).toFixed(1);
  console.log(`[android] pronto: ${path.relative(root, outApk)} (${mb} MB, versão ${pkg.version} / ${versionCode})`);
}

main().catch((e) => fail(e.stack || e.message));
