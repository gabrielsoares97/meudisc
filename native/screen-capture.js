// Processo principal: liga a thread de captura DXGI, importa as texturas da GPU no
// Electron (sharedTexture) e envia cada quadro para a página.
'use strict';

const path = require('path');
const { Worker } = require('worker_threads');
const { app, screen, desktopCapturer, sharedTexture } = require('electron');

let dxgi;
function loadDxgi() {
  if (dxgi === undefined) {
    try {
      dxgi = require('./dxgi');
    } catch (e) {
      console.warn('[captura] DXGI indisponível:', e.message);
      dxgi = null;
    }
  }
  return dxgi;
}

function available() {
  return process.platform === 'win32'
    && !!sharedTexture && typeof sharedTexture.importSharedTexture === 'function'
    && !!loadDxgi();
}

// Placa de vídeo que o Electron está usando para vídeo (as texturas precisam estar nela).
async function targetAdapter(adapters) {
  try {
    const info = await app.getGPUInfo('complete');
    const active = ((info && info.gpuDevice) || []).find((d) => d.active);
    if (active) {
      const m = adapters.find((a) => a.vendorId === active.vendorId && a.deviceId === active.deviceId);
      if (m) return m;
    }
  } catch { /* usa a regra abaixo */ }
  // O app pede a placa de alto desempenho: a de mais memória dedicada.
  const hw = adapters.filter((a) => !a.software).sort((a, b) => b.vram - a.vram);
  return hw[0] || adapters[0];
}

// Acha a saída DXGI do monitor escolhido no seletor (fonte "screen:..." do desktopCapturer).
async function findOutput(adapters, sourceId) {
  const outputs = adapters.flatMap((a) => a.outputs.filter((o) => o.attached));
  if (!outputs.length) throw new Error('nenhum monitor encontrado');
  let display = null;
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const src = sources.find((s) => s.id === sourceId);
    if (src && src.display_id) display = screen.getAllDisplays().find((d) => String(d.id) === String(src.display_id));
  } catch { /* segue sem */ }
  if (!display) display = screen.getPrimaryDisplay();
  const r = process.platform === 'win32' && screen.dipToScreenRect ? screen.dipToScreenRect(null, display.bounds) : display.bounds;
  let best = null;
  let bestDist = Infinity;
  for (const o of outputs) {
    const d = Math.abs(o.left - r.x) + Math.abs(o.top - r.y) + Math.abs(o.width - r.width) + Math.abs(o.height - r.height);
    if (d < bestDist) { bestDist = d; best = o; }
  }
  return best;
}

class NativeCapture {
  constructor(webContents) {
    this.wc = webContents;
    this.worker = null;
    this.ring = [];
    this.inflight = 0;
    this.lastIndex = -1;
    this.lastSent = 0;
    this.stats = { sent: 0, dropped: 0, errors: 0 };
  }

  async start({ sourceId, fps }) {
    const lib = loadDxgi();
    if (!lib) throw new Error('captura direta indisponível');
    const adapters = lib.enumAdapters();
    const out = await findOutput(adapters, sourceId);
    const target = await targetAdapter(adapters);
    const source = adapters.find((a) => a.index === out.adapterIndex);

    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
      const timer = setTimeout(() => done(reject, new Error('a captura não respondeu')), 6000);
      this.worker = new Worker(path.join(__dirname, 'capture-worker.js'), {
        workerData: { adapterIndex: out.adapterIndex, outputIndex: out.outputIndex, targetAdapterIndex: target.index, fps, ringSize: 8 },
      });
      this.worker.on('message', (m) => {
        if (m.type === 'ready') {
          try {
            this.importRing(m);
          } catch (e) {
            done(reject, e);
            return;
          }
          done(resolve, {
            width: m.width, height: m.height, refresh: Math.round(m.refresh), bounce: m.bounce,
            monitor: out.deviceName, gpu: source ? source.name : '', encoderGpu: target.name,
          });
        } else if (m.type === 'frame') {
          this.send(m.index);
        } else if (m.type === 'pointer') {
          if (!this.wc.isDestroyed()) this.wc.send('native:pointer', { x: m.x, y: m.y, visible: m.visible });
        } else if (m.type === 'error') {
          console.warn('[captura]', m.message);
          if (!settled) done(reject, new Error(m.message));
          else if (!this.wc.isDestroyed()) this.wc.send('native:error', m.message);
        }
      });
      this.worker.on('error', (e) => done(reject, e));
      // Reenvia o último quadro quando a tela está parada: quem começa a assistir
      // precisa de um quadro para ver a imagem.
      this.idleTimer = setInterval(() => {
        if (this.lastIndex >= 0 && Date.now() - this.lastSent > 150) this.send(this.lastIndex);
      }, 60);
    });
  }

  importRing({ width, height, handles }) {
    this.releaseRing();
    this.width = width;
    this.height = height;
    this.ring = handles.map((h) => {
      const buf = Buffer.alloc(8);
      buf.writeBigUInt64LE(BigInt(h));
      return sharedTexture.importSharedTexture({
        textureInfo: { pixelFormat: 'bgra', codedSize: { width, height }, handle: { ntHandle: buf } },
      });
    });
    this.lastIndex = -1;
  }

  send(index) {
    const imported = this.ring[index];
    if (!imported || this.wc.isDestroyed()) return;
    this.lastIndex = index;
    this.lastSent = Date.now();
    if (this.inflight >= 2) { this.stats.dropped++; return; }
    this.inflight++;
    sharedTexture.sendSharedTexture({ frame: this.wc.mainFrame, importedSharedTexture: imported })
      .then(() => { this.stats.sent++; })
      .catch(() => { this.stats.errors++; })
      .finally(() => { this.inflight--; });
  }

  releaseRing() {
    for (const r of this.ring) { try { r.release(); } catch { /* ok */ } }
    this.ring = [];
  }

  stop() {
    clearInterval(this.idleTimer);
    const w = this.worker;
    this.worker = null;
    if (w) {
      w.postMessage({ cmd: 'stop' });
      setTimeout(() => w.terminate().catch(() => {}), 1500);
    }
    // Dá tempo para os últimos quadros em trânsito antes de soltar as texturas.
    const ring = this.ring;
    this.ring = [];
    setTimeout(() => { for (const r of ring) { try { r.release(); } catch { /* ok */ } } }, 500);
  }
}

module.exports = { available, NativeCapture };
