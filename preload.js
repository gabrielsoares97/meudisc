const { contextBridge, ipcRenderer, sharedTexture } = require('electron');

// Quadros vindos da GPU pelo processo principal: 'screen' (captura direta da tela)
// ou 'browser' (navegador compartilhado).
const frameHandlers = { screen: null, browser: null };
let onPointer = null;
let onError = null;
let onBrowserState = null;
if (sharedTexture && typeof sharedTexture.setSharedTextureReceiver === 'function') {
  sharedTexture.setSharedTextureReceiver(async (data, channel) => {
    const imported = data.importedSharedTexture;
    try {
      const handler = frameHandlers[channel === 'browser' ? 'browser' : 'screen'];
      if (handler) await handler(imported);
    } catch {
      /* quadro perdido */
    } finally {
      imported.release();
    }
  });
}
ipcRenderer.on('native:pointer', (_e, p) => { if (onPointer) onPointer(p); });
ipcRenderer.on('native:error', (_e, msg) => { if (onError) onError(msg); });
ipcRenderer.on('browser:state', (_e, st) => { if (onBrowserState) onBrowserState(st); });
let onAppAudio = null;
let onAppAudioError = null;
ipcRenderer.on('native:audio', (_e, pcm) => { if (onAppAudio) onAppAudio(pcm); });
ipcRenderer.on('native:audioError', (_e, message) => { if (onAppAudioError) onAppAudioError(message); });

const fn = (cb) => (typeof cb === 'function' ? cb : null);
const gpuFrames = !!sharedTexture && typeof sharedTexture.setSharedTextureReceiver === 'function';

contextBridge.exposeInMainWorld('desktop', {
  platform: process.platform,
  listSources: () => ipcRenderer.invoke('sources:list'),
  chooseSource: (choice) => ipcRenderer.invoke('sources:choose', choice),
  accessStatus: (kind) => ipcRenderer.invoke('access:status', kind),
  askAccess: (kind) => ipcRenderer.invoke('access:ask', kind),
  openScreenSettings: () => ipcRenderer.invoke('access:openScreenSettings'),
  nativeCapture: {
    supported: gpuFrames,
    available: () => ipcRenderer.invoke('native:available'),
    start: (opts) => ipcRenderer.invoke('native:start', opts),
    stop: () => ipcRenderer.invoke('native:stop'),
    stats: () => ipcRenderer.invoke('native:stats'),
    onFrame: (cb) => { frameHandlers.screen = fn(cb); },
    onPointer: (cb) => { onPointer = fn(cb); },
    onError: (cb) => { onError = fn(cb); },
  },
  // Som só da janela escolhida (ou do PC sem o MeuDisc), em PCM 16 bits, 48 kHz, estéreo.
  appAudio: {
    supported: process.platform === 'win32',
    start: (opts) => ipcRenderer.invoke('native:audioStart', opts),
    stop: () => ipcRenderer.invoke('native:audioStop'),
    onData: (cb) => { onAppAudio = fn(cb); },
    onError: (cb) => { onAppAudioError = fn(cb); },
  },
  browser: {
    supported: gpuFrames,
    open: (opts) => ipcRenderer.invoke('browser:open', opts),
    close: () => ipcRenderer.invoke('browser:close'),
    state: () => ipcRenderer.invoke('browser:state'),
    stats: () => ipcRenderer.invoke('browser:stats'),
    audioSourceId: () => ipcRenderer.invoke('browser:audioSourceId'),
    setAdblock: (on) => ipcRenderer.invoke('browser:adblock', !!on),
    input: (ev) => ipcRenderer.send('browser:input', ev),
    nav: (action, url) => ipcRenderer.send('browser:nav', action, url),
    text: (text) => ipcRenderer.send('browser:text', text),
    onFrame: (cb) => { frameHandlers.browser = fn(cb); },
    onState: (cb) => { onBrowserState = fn(cb); },
  },
});
