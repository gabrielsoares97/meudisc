// Thread separada da captura de som por programa.
// Recebe workerData { mode, pid?, hwnd? } e { cmd: 'stop' }.
// Envia { type: 'ready', pid } , { type: 'pcm', data: ArrayBuffer } e { type: 'error', message }.
'use strict';

const { parentPort, workerData } = require('worker_threads');
const { ProcessAudio } = require('./app-audio');

let running = true;
parentPort.on('message', (m) => { if (m && m.cmd === 'stop') running = false; });

(async () => {
  const cap = new ProcessAudio();
  try {
    const info = await cap.open(workerData);
    parentPort.postMessage({ type: 'ready', ...info });
    while (running) {
      const pcm = cap.read();
      if (pcm) {
        const ab = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
        parentPort.postMessage({ type: 'pcm', data: ab }, [ab]);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  } catch (e) {
    parentPort.postMessage({ type: 'error', message: e.message });
  } finally {
    cap.close();
    parentPort.postMessage({ type: 'stopped' });
  }
})();
