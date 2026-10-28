const {
  app, BrowserWindow, ipcMain, desktopCapturer, session, systemPreferences, shell, Menu,
} = require('electron');
const path = require('path');

// Permite rodar duas cópias no mesmo PC (útil para testar): MEUDISC_PROFILE=b npm start
if (process.env.MEUDISC_PROFILE) {
  app.setPath('userData', path.join(app.getPath('appData'), `MeuDisc-${process.env.MEUDISC_PROFILE}`));
}

// O app continua capturando/enviando a tela em velocidade total mesmo minimizado
// ou atrás de um jogo em tela cheia.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('force_high_performance_gpu');

let win = null;
let pendingShare = null; // fonte escolhida no seletor, consumida pelo getDisplayMedia

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1b2029',
    title: 'MeuDisc',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Links externos abrem no navegador, nunca dentro do app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });
}

function setupPermissions() {
  const allowed = new Set([
    'media', 'display-capture', 'fullscreen', 'clipboard-sanitized-write',
    'notifications', 'speaker-selection', 'screen-wake-lock', 'clipboard-read',
  ]);
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    const choice = pendingShare;
    pendingShare = null;
    if (!choice) return callback(null);
    // Som do navegador compartilhado: captura o áudio dele. Quem abriu ouve pelo app
    // (com controle de volume), não direto do navegador escondido.
    if (choice.browserAudio) {
      const frame = sharedBrowser && sharedBrowser.win && !sharedBrowser.win.isDestroyed()
        ? sharedBrowser.win.webContents.mainFrame : null;
      if (!frame) return callback(null);
      try {
        return callback({ video: frame, audio: frame, enableLocalEcho: false });
      } catch (err) {
        console.error('som do navegador', err);
        return callback(null);
      }
    }
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const source = sources.find((s) => s.id === choice.id);
      if (!source) return callback(null);
      const streams = { video: source };
      if (choice.audio && process.platform === 'win32') streams.audio = 'loopback';
      callback(streams);
    } catch (err) {
      console.error('display media', err);
      callback(null);
    }
  });
}

ipcMain.handle('sources:list', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 400, height: 225 },
    fetchWindowIcons: true,
  });
  return sources
    .filter((s) => !s.name.startsWith('MeuDisc'))
    .map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen:') ? 'screen' : 'window',
      thumb: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
      icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
    }));
});

ipcMain.handle('sources:choose', (_e, choice) => {
  if (choice && choice.browserAudio) pendingShare = { browserAudio: true };
  else pendingShare = choice && typeof choice.id === 'string' ? { id: choice.id, audio: !!choice.audio } : null;
  return true;
});

// Captura direta da tela inteira (Windows, DXGI): chega à taxa do monitor (120/144/165 Hz).
let nativeCapture = null;
function nativeModule() {
  try { return require('./native/screen-capture'); } catch (e) { console.warn('[captura]', e.message); return null; }
}
ipcMain.handle('native:available', () => {
  const m = nativeModule();
  return !!(m && m.available());
});
ipcMain.handle('native:start', async (e, opts) => {
  const m = nativeModule();
  if (nativeCapture) { nativeCapture.stop(); nativeCapture = null; }
  if (!m || !m.available()) return { ok: false, error: 'indisponível' };
  const cap = new m.NativeCapture(e.sender);
  try {
    const info = await cap.start({ sourceId: String(opts && opts.sourceId), fps: Number(opts && opts.fps) || 60 });
    nativeCapture = cap;
    return { ok: true, ...info };
  } catch (err) {
    cap.stop();
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('native:stop', () => {
  if (nativeCapture) { nativeCapture.stop(); nativeCapture = null; }
});
ipcMain.handle('native:stats', () => (nativeCapture ? { ...nativeCapture.stats, inflight: nativeCapture.inflight } : null));

// Som do compartilhamento (Windows): só o programa da janela escolhida, ou o PC
// inteiro menos o próprio MeuDisc (assim a voz da sala não volta como eco).
let appAudio = null;
function stopAppAudio() {
  const w = appAudio;
  appAudio = null;
  if (w) {
    w.postMessage({ cmd: 'stop' });
    setTimeout(() => w.terminate().catch(() => {}), 1500);
  }
}
ipcMain.handle('native:audioStart', (e, opts) => {
  stopAppAudio();
  if (process.platform !== 'win32') return { ok: false, error: 'só no Windows' };
  const sourceId = String((opts && opts.sourceId) || '');
  const isWindow = sourceId.startsWith('window:');
  const workerData = isWindow
    ? { mode: 'include', hwnd: Number(sourceId.split(':')[1]) || 0 }
    : { mode: 'exclude', pid: process.pid };
  const { Worker } = require('worker_threads');
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => { stopAppAudio(); done({ ok: false, error: 'sem resposta' }); }, 6000);
    let w;
    try {
      w = new Worker(path.join(__dirname, 'native', 'audio-worker.js'), { workerData });
    } catch (err) {
      done({ ok: false, error: err.message });
      return;
    }
    appAudio = w;
    let failed = false;
    const fail = (message) => {
      if (failed) return;
      failed = true;
      const wasReady = settled;
      done({ ok: false, error: message });
      if (wasReady && appAudio === w && !e.sender.isDestroyed()) e.sender.send('native:audioError', message);
      if (appAudio === w) appAudio = null;
    };
    w.on('message', (m) => {
      if (m.type === 'ready') done({ ok: true, mode: workerData.mode, pid: m.pid });
      else if (m.type === 'pcm') { if (appAudio === w && !e.sender.isDestroyed()) e.sender.send('native:audio', m.data); }
      else if (m.type === 'error') { console.warn('[som]', m.message); fail(m.message); }
    });
    w.on('error', (err) => fail(err.message));
    w.on('exit', (code) => { if (appAudio === w) fail(`captura de som encerrada (${code})`); });
  });
});
ipcMain.handle('native:audioStop', () => stopAppAudio());

// Navegador compartilhado da sala.
let sharedBrowser = null;
ipcMain.handle('browser:open', async (e, opts) => {
  if (sharedBrowser) { sharedBrowser.close(); sharedBrowser = null; }
  try {
    const { SharedBrowser } = require('./native/shared-browser');
    const b = new SharedBrowser(e.sender, { width: 1280, height: 720, fps: 60 });
    sharedBrowser = b;
    await b.open(opts && opts.url);
    if (sharedBrowser !== b) { b.close(); return { ok: false, error: 'fechado' }; }
    return { ok: true, width: b.width, height: b.height, adblock: b.adblock };
  } catch (err) {
    if (sharedBrowser) { sharedBrowser.close(); sharedBrowser = null; }
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('browser:adblock', async (_e, on) => {
  if (sharedBrowser) await sharedBrowser.setAdblock(!!on);
  return sharedBrowser ? sharedBrowser.state() : null;
});
ipcMain.handle('browser:close', () => {
  if (sharedBrowser) { sharedBrowser.close(); sharedBrowser = null; }
});
ipcMain.handle('browser:state', () => (sharedBrowser ? sharedBrowser.state() : null));
ipcMain.handle('browser:audioSourceId', (e) => (sharedBrowser ? sharedBrowser.audioSourceId(e.sender) : null));
ipcMain.handle('browser:stats', () => (sharedBrowser ? { ...sharedBrowser.stats, inflight: sharedBrowser.inflight } : null));
ipcMain.on('browser:input', (_e, ev) => { if (sharedBrowser) sharedBrowser.input(ev); });
ipcMain.on('browser:nav', (_e, action, url) => { if (sharedBrowser) sharedBrowser.nav(String(action), url); });
ipcMain.on('browser:text', (_e, text) => { if (sharedBrowser) sharedBrowser.insertText(text); });

ipcMain.handle('access:status', (_e, kind) => {
  if (process.platform !== 'darwin') return 'granted';
  return systemPreferences.getMediaAccessStatus(kind);
});

ipcMain.handle('access:ask', async (_e, kind) => {
  if (process.platform !== 'darwin') return true;
  if (kind !== 'microphone' && kind !== 'camera') return false;
  return systemPreferences.askForMediaAccess(kind);
});

ipcMain.handle('access:openScreenSettings', () => {
  if (process.platform === 'darwin') {
    shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  }
});

app.whenReady().then(() => {
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  setupPermissions();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (nativeCapture) { nativeCapture.stop(); nativeCapture = null; }
  if (sharedBrowser) { sharedBrowser.close(); sharedBrowser = null; }
  stopAppAudio();
  app.quit();
});
