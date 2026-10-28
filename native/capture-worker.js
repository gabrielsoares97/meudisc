// Thread separada que captura o monitor sem travar o resto do app.
// Mensagens recebidas:  { cmd: 'stop' }
// Mensagens enviadas:   { type: 'ready', width, height, handles, refresh, bounce }
//                       { type: 'frame', index }
//                       { type: 'pointer', x, y, visible }   (posição relativa ao monitor, 0..1)
//                       { type: 'error', message }
'use strict';

const { parentPort, workerData } = require('worker_threads');
const { Duplicator } = require('./dxgi');

let running = true;
parentPort.on('message', (m) => { if (m && m.cmd === 'stop') running = false; });

const tick = () => new Promise((r) => setImmediate(r));

(async () => {
  let dup = null;
  try {
    dup = new Duplicator(workerData);
    const announce = () => {
      const handles = dup.createRing();
      parentPort.postMessage({ type: 'ready', width: dup.width, height: dup.height, handles, refresh: dup.refresh, bounce: dup.bounce });
    };
    announce();

    // Limita à taxa pedida pela média (e não pelo intervalo entre quadros): com o monitor
    // a 165 Hz e alvo de 120 fps, um intervalo mínimo fixo acabaria entregando só ~95.
    const interval = 1000 / Math.max(1, workerData.fps);
    let nextDue = 0;
    let pendingFrame = -1;
    let lastPointer = 0;
    let pendingPointer = null;
    let errors = 0;
    while (running) {
      let r = null;
      try {
        r = dup.acquire(4);
        errors = 0;
      } catch (e) {
        if (++errors > 50) throw e;
        await new Promise((res) => setTimeout(res, 100));
        continue;
      }
      const now = performance.now();
      if (r && r.resized) {
        pendingFrame = -1;
        announce();
      } else if (r) {
        if (r.index >= 0) pendingFrame = r.index;
        if (r.pointer) pendingPointer = r.pointer;
      }
      // Entrega o quadro mais recente, no máximo na taxa pedida.
      if (pendingFrame >= 0 && now >= nextDue - 0.5) {
        nextDue = Math.max(nextDue + interval, now - interval);
        parentPort.postMessage({ type: 'frame', index: pendingFrame });
        pendingFrame = -1;
      }
      if (pendingPointer && now - lastPointer > 16) {
        lastPointer = now;
        parentPort.postMessage({
          type: 'pointer',
          x: pendingPointer.x / dup.width,
          y: pendingPointer.y / dup.height,
          visible: pendingPointer.visible,
        });
        pendingPointer = null;
      }
      await tick();
    }
  } catch (e) {
    parentPort.postMessage({ type: 'error', message: e.message });
  } finally {
    if (dup) dup.close();
    parentPort.postMessage({ type: 'stopped' });
  }
})();
