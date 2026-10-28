// Captura do som de um programa específico no Windows (WASAPI process loopback,
// Windows 10 build 20348+ / Windows 11), chamando o sistema pelo koffi.
//   mode 'include': só o som do processo (e filhos) — o programa da janela compartilhada.
//   mode 'exclude': tudo menos o processo (e filhos) — o PC inteiro sem o próprio MeuDisc.
// Roda numa thread separada (audio-worker.js).
'use strict';

const koffi = require('koffi');

const S_OK = 0;
const E_NOINTERFACE = 0x80004002 | 0;
const VT_BLOB = 65;
const ACTIVATION_PROCESS_LOOPBACK = 1;
const AUDCLNT_SHAREMODE_SHARED = 0;
const AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
const AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY = 0x08000000;
const AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = 0x80000000;
const AUDCLNT_BUFFERFLAGS_SILENT = 0x2;
const SAMPLE_RATE = 48000;
const CHANNELS = 2;

const GUID = koffi.struct('PA_GUID', { Data1: 'uint32', Data2: 'uint16', Data3: 'uint16', Data4: koffi.array('uint8', 8) });
const LOOPBACK_PARAMS = koffi.struct('PA_LOOPBACK_PARAMS', { ActivationType: 'int32', TargetProcessId: 'uint32', Mode: 'int32' });
koffi.struct('PA_PROPVARIANT', {
  vt: 'uint16', r1: 'uint16', r2: 'uint16', r3: 'uint16', cbSize: 'uint32', pad: 'uint32', pBlobData: 'void *',
});
koffi.struct('PA_WAVEFORMATEX', {
  wFormatTag: 'uint16', nChannels: 'uint16', nSamplesPerSec: 'uint32', nAvgBytesPerSec: 'uint32',
  nBlockAlign: 'uint16', wBitsPerSample: 'uint16', cbSize: 'uint16',
});

function guid(str) {
  const h = str.replace(/-/g, '');
  return {
    Data1: parseInt(h.slice(0, 8), 16),
    Data2: parseInt(h.slice(8, 12), 16),
    Data3: parseInt(h.slice(12, 16), 16),
    Data4: Array.from({ length: 8 }, (_, i) => parseInt(h.slice(16 + i * 2, 18 + i * 2), 16)),
  };
}
const sameGuid = (a, b) => a.Data1 === b.Data1 && a.Data2 === b.Data2 && a.Data3 === b.Data3
  && a.Data4.every((v, i) => v === b.Data4[i]);
const IID = {
  IUnknown: guid('00000000-0000-0000-c000-000000000046'),
  IAgileObject: guid('94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90'),
  CompletionHandler: guid('41d949ab-9862-444a-80f6-c261334da5eb'),
  IAudioClient: guid('1cb9ad4c-dbfa-4c32-b178-c2f568a703b2'),
  IAudioCaptureClient: guid('c8adbd64-e71e-48a0-a4de-185c395cd317'),
};

const ole32 = koffi.load('ole32.dll');
const mmdevapi = koffi.load('mmdevapi.dll');
const user32 = koffi.load('user32.dll');
const CoInitializeEx = ole32.func('long __stdcall CoInitializeEx(void *reserved, uint32 coinit)');
const ActivateAudioInterfaceAsync = mmdevapi.func('long __stdcall ActivateAudioInterfaceAsync(const char16_t *path, PA_GUID *riid, PA_PROPVARIANT *params, void *handler, _Out_ void **op)');
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32 *pid)');

const M = {
  Release: [2, 'uint32 f(void *self)'],
  GetActivateResult: [3, 'long f(void *self, _Out_ int32 *hr, _Out_ void **unk)'],
  Initialize: [3, 'long f(void *self, int mode, uint32 flags, int64 duration, int64 period, PA_WAVEFORMATEX *fmt, void *session)'],
  Start: [10, 'long f(void *self)'],
  Stop: [11, 'long f(void *self)'],
  GetService: [14, 'long f(void *self, PA_GUID *riid, _Out_ void **out)'],
  GetBuffer: [3, 'long f(void *self, _Out_ void **data, _Out_ uint32 *frames, _Out_ uint32 *flags, void *devpos, void *qpc)'],
  ReleaseBuffer: [4, 'long f(void *self, uint32 frames)'],
  GetNextPacketSize: [5, 'long f(void *self, _Out_ uint32 *frames)'],
};
for (const k of Object.keys(M)) M[k] = { index: M[k][0], proto: koffi.proto(M[k][1].replace(' f(', ` PA_${k}(`)) };

function call(obj, name, ...args) {
  const m = M[name];
  const vtbl = koffi.decode(obj, 'void *');
  const fn = koffi.decode(vtbl, m.index * 8, 'void *');
  return koffi.call(fn, m.proto, obj, ...args);
}
function check(hr, what) {
  if (hr !== S_OK) {
    const err = new Error(`${what} falhou (0x${(hr >>> 0).toString(16)})`);
    err.hr = hr;
    throw err;
  }
}
const release = (obj) => { if (obj) { try { call(obj, 'Release'); } catch { /* ok */ } } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidOfWindow(hwnd) {
  const pid = [0];
  GetWindowThreadProcessId(hwnd, pid);
  return pid[0];
}

// Objeto COM mínimo (IActivateAudioInterfaceCompletionHandler, ágil) feito em JS.
function completionHandler(onDone) {
  const QI = koffi.proto('long __stdcall PA_HandlerQI(void *self, void *riid, void *ppv)');
  const Ref = koffi.proto('uint32 __stdcall PA_HandlerRef(void *self)');
  const Done = koffi.proto('long __stdcall PA_HandlerDone(void *self, void *op)');
  const vtbl = koffi.alloc('void *', 4);
  const obj = koffi.alloc('void *', 1);
  const cbs = [
    koffi.register((self, riid, ppv) => {
      const g = koffi.decode(riid, GUID);
      const ok = sameGuid(g, IID.IUnknown) || sameGuid(g, IID.IAgileObject) || sameGuid(g, IID.CompletionHandler);
      koffi.encode(ppv, 'void *', ok ? obj : null);
      return ok ? S_OK : E_NOINTERFACE;
    }, koffi.pointer(QI)),
    koffi.register(() => 1, koffi.pointer(Ref)),
    koffi.register(() => 1, koffi.pointer(Ref)),
    koffi.register(() => { onDone(); return S_OK; }, koffi.pointer(Done)),
  ];
  cbs.forEach((cb, i) => koffi.encode(vtbl, i * 8, 'void *', cb));
  koffi.encode(obj, 'void *', vtbl);
  // Nunca desregistra: o Windows ainda pode chamar Release() depois, de outra thread,
  // e chamar uma função já removida derruba o processo. Vive até a thread acabar.
  keepAlive.push({ cbs, vtbl, obj });
  return { ptr: obj };
}
const keepAlive = [];

class ProcessAudio {
  // target: { mode: 'include' | 'exclude', pid?, hwnd? }
  async open({ mode, pid, hwnd }) {
    CoInitializeEx(null, 0); // multithreaded
    const targetPid = pid || (hwnd ? pidOfWindow(hwnd) : 0);
    if (!targetPid) throw new Error('programa da janela não encontrado');
    this.pid = targetPid;

    const params = koffi.alloc(LOOPBACK_PARAMS, 1);
    koffi.encode(params, LOOPBACK_PARAMS, {
      ActivationType: ACTIVATION_PROCESS_LOOPBACK, TargetProcessId: targetPid, Mode: mode === 'exclude' ? 1 : 0,
    });
    let done = false;
    const handler = completionHandler(() => { done = true; });
    const op = [null];
    try {
      check(ActivateAudioInterfaceAsync('VAD\\Process_Loopback', IID.IAudioClient, {
        vt: VT_BLOB, r1: 0, r2: 0, r3: 0, cbSize: koffi.sizeof(LOOPBACK_PARAMS), pad: 0, pBlobData: params,
      }, handler.ptr, op), 'ActivateAudioInterfaceAsync');
      // O Windows chama o "pronto" de outra thread; deixa o JS livre até isso acontecer.
      for (let i = 0; i < 300 && !done; i++) await sleep(10);
      if (!done) throw new Error('o Windows não respondeu à captura de áudio');
      const hr = [0];
      const unk = [null];
      check(call(op[0], 'GetActivateResult', hr, unk), 'GetActivateResult');
      check(hr[0], 'ativar captura de áudio do programa');
      this.client = unk[0];
    } finally {
      release(op[0]);
      koffi.free(params);
    }

    check(call(this.client, 'Initialize', AUDCLNT_SHAREMODE_SHARED,
      (AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY) >>> 0,
      2000000, 0, {
        wFormatTag: 1, nChannels: CHANNELS, nSamplesPerSec: SAMPLE_RATE, nAvgBytesPerSec: SAMPLE_RATE * CHANNELS * 2,
        nBlockAlign: CHANNELS * 2, wBitsPerSample: 16, cbSize: 0,
      }, null), 'IAudioClient.Initialize');
    const cap = [null];
    check(call(this.client, 'GetService', IID.IAudioCaptureClient, cap), 'GetService');
    this.capture = cap[0];
    check(call(this.client, 'Start'), 'Start');
    return { pid: targetPid, sampleRate: SAMPLE_RATE, channels: CHANNELS };
  }

  // Lê o que chegou desde a última vez. Devolve um Buffer PCM 16 bits intercalado (ou null).
  read() {
    const chunks = [];
    const n = [0];
    check(call(this.capture, 'GetNextPacketSize', n), 'GetNextPacketSize');
    while (n[0] > 0) {
      const data = [null];
      const frames = [0];
      const flags = [0];
      check(call(this.capture, 'GetBuffer', data, frames, flags, null, null), 'GetBuffer');
      const bytes = frames[0] * CHANNELS * 2;
      if (bytes > 0) {
        const chunk = Buffer.alloc(bytes);
        // Copia já: depois do ReleaseBuffer o Windows reaproveita essa memória.
        // (koffi.decode copia; koffi.view não funciona no Electron por causa do isolamento de memória do V8.)
        if (!(flags[0] & AUDCLNT_BUFFERFLAGS_SILENT) && data[0]) chunk.set(koffi.decode(data[0], 'uint8', bytes));
        else this.silentPackets = (this.silentPackets || 0) + 1;
        chunks.push(chunk);
      }
      call(this.capture, 'ReleaseBuffer', frames[0]);
      check(call(this.capture, 'GetNextPacketSize', n), 'GetNextPacketSize');
    }
    return chunks.length ? Buffer.concat(chunks) : null;
  }

  close() {
    if (this.client) { try { call(this.client, 'Stop'); } catch { /* ok */ } }
    release(this.capture);
    release(this.client);
    this.capture = this.client = null;
  }
}

module.exports = { ProcessAudio, SAMPLE_RATE, CHANNELS };
