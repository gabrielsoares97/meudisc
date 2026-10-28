// Navegador compartilhado: roda escondido (renderização fora da tela, na GPU) no PC de
// quem abriu. Os quadros vão para a página do app como VideoFrame e daí para a sala;
// mouse e teclado de todos voltam para cá.
'use strict';

const { BrowserWindow, session, sharedTexture } = require('electron');
const adblock = require('./adblock');

const PARTITION = 'persist:meudisc-navegador';
const HOME = 'https://www.google.com/';
const MODIFIERS = new Set(['shift', 'control', 'alt', 'meta', 'leftButtonDown', 'middleButtonDown', 'rightButtonDown']);
const TYPES = new Set(['mouseMove', 'mouseDown', 'mouseUp', 'mouseWheel', 'mouseLeave', 'keyDown', 'keyUp', 'char']);

// Só páginas da web: nada de arquivos do PC (file://), configurações internas etc.
const isWeb = (url) => /^(https?:\/\/|about:blank$)/i.test(String(url || ''));

function normalizeUrl(input) {
  const t = String(input || '').trim();
  if (!t) return HOME;
  if (/^https?:\/\//i.test(t)) return t;
  if (!/\s/.test(t) && /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(t)) return `https://${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

function browserSession() {
  const ses = session.fromPartition(PARTITION);
  if (!ses.meudiscReady) {
    ses.meudiscReady = true;
    // Sites abertos aqui não usam câmera, microfone, tela, localização etc. de quem abriu.
    const allowed = new Set(['clipboard-sanitized-write']);
    ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
    // Ninguém da sala baixa arquivos no PC de quem abriu o navegador.
    ses.on('will-download', (e) => e.preventDefault());
  }
  return ses;
}

const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));
const clampNum = (v, max) => Math.max(-max, Math.min(max, Number(v) || 0));

class SharedBrowser {
  constructor(appContents, { width = 1280, height = 720, fps = 60 } = {}) {
    this.app = appContents;
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.inflight = 0;
    this.lastPaint = 0;
    this.cursor = 'default';
    this.htmlFullscreen = false;
    this.adblock = { on: false, lists: false };
    this.blockedBase = adblock.blockedCount();
    this.lastBlocked = 0;
    this.stats = { frames: 0, dropped: 0 };
  }

  async open(url) {
    const ses = browserSession();
    // Bloqueador de anúncios ligado por padrão (listas ficam em cache por alguns dias).
    this.adblock = await adblock.setAdblock(ses, true);
    this.win = new BrowserWindow({
      show: false,
      width: this.width,
      height: this.height,
      useContentSize: true,
      fullscreenable: false,
      webPreferences: {
        offscreen: { useSharedTexture: true, deviceScaleFactor: 1 },
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    const wc = this.win.webContents;
    wc.setFrameRate(this.fps);
    wc.on('paint', (details) => this.onPaint(details && details.texture));
    wc.setWindowOpenHandler(({ url: target }) => {
      if (isWeb(target)) wc.loadURL(target); // abre na mesma aba, para todos verem
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e, target) => { if (!isWeb(target)) e.preventDefault(); });
    wc.on('will-redirect', (e, target) => { if (!isWeb(target)) e.preventDefault(); });
    for (const ev of ['did-navigate', 'did-navigate-in-page', 'page-title-updated', 'did-start-loading', 'did-stop-loading']) {
      wc.on(ev, () => this.emitState());
    }
    wc.on('cursor-changed', (_e, type) => {
      if (type !== this.cursor) { this.cursor = type; this.emitState(); }
    });
    // Tela cheia do site (ex.: botão de tela cheia do YouTube): o vídeo ocupa a página toda.
    wc.on('enter-html-full-screen', () => { this.htmlFullscreen = true; this.emitState(); });
    wc.on('leave-html-full-screen', () => { this.htmlFullscreen = false; this.emitState(); });
    wc.on('render-process-gone', () => { if (this.win && !this.win.isDestroyed()) wc.reload(); });
    this.countTimer = setInterval(() => {
      const n = adblock.blockedCount() - this.blockedBase;
      if (n !== this.lastBlocked) { this.lastBlocked = n; this.emitState(); }
    }, 1500);
    // Página parada não pinta; repinta de vez em quando para quem acabou de entrar ver a imagem.
    this.idleTimer = setInterval(() => {
      if (this.win && !this.win.isDestroyed() && Date.now() - this.lastPaint > 300) wc.invalidate();
    }, 300);
    wc.loadURL(normalizeUrl(url));
    wc.focus();
  }

  onPaint(texture) {
    if (!texture) return;
    this.lastPaint = Date.now();
    if (this.inflight >= 2 || this.app.isDestroyed()) {
      this.stats.dropped++;
      texture.release();
      return;
    }
    let imported;
    try {
      imported = sharedTexture.importSharedTexture({
        textureInfo: texture.textureInfo,
        allReferencesReleased: () => texture.release(),
      });
    } catch (e) {
      texture.release();
      return;
    }
    this.inflight++;
    sharedTexture.sendSharedTexture({ frame: this.app.mainFrame, importedSharedTexture: imported }, 'browser')
      .then(() => { this.stats.frames++; })
      .catch(() => { this.stats.dropped++; })
      .finally(() => {
        imported.release();
        this.inflight--;
      });
  }

  state() {
    const wc = this.win.webContents;
    const h = wc.navigationHistory;
    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canBack: h ? h.canGoBack() : false,
      canForward: h ? h.canGoForward() : false,
      cursor: this.cursor,
      htmlFullscreen: this.htmlFullscreen,
      adblock: this.adblock.on,
      blocked: adblock.blockedCount() - this.blockedBase,
    };
  }

  async setAdblock(on) {
    if (!this.win || this.win.isDestroyed()) return;
    this.adblock = await adblock.setAdblock(this.win.webContents.session, !!on);
    this.win.webContents.reload();
    this.emitState();
  }

  emitState() {
    clearTimeout(this.stateTimer);
    this.stateTimer = setTimeout(() => {
      if (this.win && !this.win.isDestroyed() && !this.app.isDestroyed()) this.app.send('browser:state', this.state());
    }, 30);
  }

  // Eventos chegam com x/y de 0 a 1 (quem mexe pode estar vendo em qualquer tamanho).
  input(ev) {
    if (!this.win || this.win.isDestroyed() || !ev || !TYPES.has(ev.type)) return;
    const [w, h] = this.win.getContentSize();
    const e = { type: ev.type };
    if (ev.type.startsWith('mouse')) {
      e.x = Math.round(clamp01(ev.x) * (w - 1));
      e.y = Math.round(clamp01(ev.y) * (h - 1));
    }
    if (ev.type === 'mouseDown' || ev.type === 'mouseUp') {
      e.button = ['left', 'middle', 'right'].includes(ev.button) ? ev.button : 'left';
      e.clickCount = Math.min(3, Math.max(1, Number(ev.clickCount) || 1));
    }
    if (ev.type === 'mouseWheel') {
      e.deltaX = clampNum(ev.deltaX, 2000);
      e.deltaY = clampNum(ev.deltaY, 2000);
      e.canScroll = true;
    }
    if (ev.type === 'keyDown' || ev.type === 'keyUp' || ev.type === 'char') {
      e.keyCode = String(ev.keyCode || '').slice(0, 24);
      if (!e.keyCode) return;
    }
    if (Array.isArray(ev.modifiers)) e.modifiers = ev.modifiers.filter((m) => MODIFIERS.has(m));
    this.win.webContents.sendInputEvent(e);
  }

  insertText(text) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.insertText(String(text || '').slice(0, 5000));
  }

  nav(action, url) {
    if (!this.win || this.win.isDestroyed()) return;
    const wc = this.win.webContents;
    const h = wc.navigationHistory;
    if (action === 'go') wc.loadURL(normalizeUrl(url));
    else if (action === 'back' && h && h.canGoBack()) h.goBack();
    else if (action === 'forward' && h && h.canGoForward()) h.goForward();
    else if (action === 'reload') wc.reload();
    else if (action === 'stop') wc.stop();
  }

  audioSourceId(requestContents) {
    return this.win.webContents.getMediaSourceId(requestContents);
  }

  close() {
    clearInterval(this.idleTimer);
    clearInterval(this.countTimer);
    clearTimeout(this.stateTimer);
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

module.exports = { SharedBrowser };
