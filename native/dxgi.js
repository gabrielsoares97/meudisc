// Captura de monitor no Windows por DXGI Desktop Duplication, chamando as APIs do
// sistema direto do JavaScript (koffi). Cada quadro vai para uma textura da GPU
// compartilhável (NT handle), que o Electron importa como VideoFrame.
//
// A captura do Chromium (Windows Graphics Capture) entrega ~55-60 fps em tela inteira
// em vários PCs; a duplicação DXGI acompanha a taxa do monitor (120/144/165 Hz).
'use strict';

const koffi = require('koffi');

const S_OK = 0;
const S_FALSE = 1;
const DXGI_ERROR_NOT_FOUND = 0x887a0002 | 0;
const DXGI_ERROR_WAIT_TIMEOUT = 0x887a0027 | 0;
const DXGI_ERROR_ACCESS_LOST = 0x887a0026 | 0;

const DXGI_FORMAT_B8G8R8A8_UNORM = 87;
const D3D_DRIVER_TYPE_UNKNOWN = 0;
const D3D11_CREATE_DEVICE_BGRA_SUPPORT = 0x20;
const D3D11_SDK_VERSION = 7;
const D3D11_USAGE_DEFAULT = 0;
const D3D11_USAGE_STAGING = 3;
const D3D11_BIND_SHADER_RESOURCE = 0x8;
const D3D11_BIND_RENDER_TARGET = 0x20;
const D3D11_CPU_ACCESS_READ = 0x20000;
const D3D11_RESOURCE_MISC_SHARED = 0x2;
const D3D11_RESOURCE_MISC_SHARED_NTHANDLE = 0x800;
const D3D11_MAP_READ = 1;
const D3D11_QUERY_EVENT = 0;
const DXGI_SHARED_RESOURCE_READ = 0x80000000;
const DXGI_SHARED_RESOURCE_WRITE = 1;

// ------------------------------------------------------------ tipos
const GUID = koffi.struct('GUID', { Data1: 'uint32', Data2: 'uint16', Data3: 'uint16', Data4: koffi.array('uint8', 8) });
const LUID = koffi.struct('LUID', { LowPart: 'uint32', HighPart: 'int32' });
const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' });
koffi.struct('DXGI_ADAPTER_DESC1', {
  Description: koffi.array('char16_t', 128, 'String'),
  VendorId: 'uint32', DeviceId: 'uint32', SubSysId: 'uint32', Revision: 'uint32',
  DedicatedVideoMemory: 'size_t', DedicatedSystemMemory: 'size_t', SharedSystemMemory: 'size_t',
  AdapterLuid: LUID, Flags: 'uint32',
});
koffi.struct('DXGI_OUTPUT_DESC', {
  DeviceName: koffi.array('char16_t', 32, 'String'),
  DesktopCoordinates: RECT, AttachedToDesktop: 'int32', Rotation: 'int32', Monitor: 'void *',
});
const DXGI_RATIONAL = koffi.struct('DXGI_RATIONAL', { Numerator: 'uint32', Denominator: 'uint32' });
const DXGI_MODE_DESC = koffi.struct('DXGI_MODE_DESC', {
  Width: 'uint32', Height: 'uint32', RefreshRate: DXGI_RATIONAL, Format: 'int32', ScanlineOrdering: 'int32', Scaling: 'int32',
});
koffi.struct('DXGI_OUTDUPL_DESC', { ModeDesc: DXGI_MODE_DESC, Rotation: 'int32', DesktopImageInSystemMemory: 'int32' });
const DXGI_OUTDUPL_POINTER_POSITION = koffi.struct('DXGI_OUTDUPL_POINTER_POSITION', { Position: POINT, Visible: 'int32' });
koffi.struct('DXGI_OUTDUPL_FRAME_INFO', {
  LastPresentTime: 'int64', LastMouseUpdateTime: 'int64', AccumulatedFrames: 'uint32', RectsCoalesced: 'int32',
  ProtectedContentMaskedOut: 'int32', PointerPosition: DXGI_OUTDUPL_POINTER_POSITION,
  TotalMetadataBufferSize: 'uint32', PointerShapeBufferSize: 'uint32',
});
const DXGI_SAMPLE_DESC = koffi.struct('DXGI_SAMPLE_DESC', { Count: 'uint32', Quality: 'uint32' });
koffi.struct('D3D11_TEXTURE2D_DESC', {
  Width: 'uint32', Height: 'uint32', MipLevels: 'uint32', ArraySize: 'uint32', Format: 'int32',
  SampleDesc: DXGI_SAMPLE_DESC, Usage: 'int32', BindFlags: 'uint32', CPUAccessFlags: 'uint32', MiscFlags: 'uint32',
});
koffi.struct('D3D11_MAPPED_SUBRESOURCE', { pData: 'void *', RowPitch: 'uint32', DepthPitch: 'uint32' });
koffi.struct('D3D11_QUERY_DESC', { Query: 'int32', MiscFlags: 'uint32' });

function guid(str) {
  const h = str.replace(/-/g, '');
  return {
    Data1: parseInt(h.slice(0, 8), 16),
    Data2: parseInt(h.slice(8, 12), 16),
    Data3: parseInt(h.slice(12, 16), 16),
    Data4: Array.from({ length: 8 }, (_, i) => parseInt(h.slice(16 + i * 2, 18 + i * 2), 16)),
  };
}
const IID = {
  IDXGIFactory1: guid('770aae78-f26f-4dba-a829-253c83d1b387'),
  IDXGIOutput1: guid('00cddea8-939b-4b83-a340-a685226666cc'),
  IDXGIResource1: guid('30961379-4609-4a41-998e-54fe567ee0c1'),
  ID3D11Texture2D: guid('6f15aaf2-d208-4e89-9ab4-489535d34f9c'),
};

// ------------------------------------------------------------ funções do sistema
const d3d11 = koffi.load('d3d11.dll');
const dxgi = koffi.load('dxgi.dll');
const kernel32 = koffi.load('kernel32.dll');
const D3D11CreateDevice = d3d11.func('long __stdcall D3D11CreateDevice(void *adapter, int driverType, void *software, uint32 flags, void *levels, uint32 nLevels, uint32 sdk, _Out_ void **device, _Out_ int *level, _Out_ void **context)');
const CreateDXGIFactory1 = dxgi.func('long __stdcall CreateDXGIFactory1(GUID *riid, _Out_ void **factory)');
const CloseHandle = kernel32.func('int __stdcall CloseHandle(void *h)');

// Métodos COM: posição na vtable (contando os 3 do IUnknown) e assinatura.
const M = {
  QueryInterface: [0, 'long f(void *self, GUID *riid, _Out_ void **out)'],
  Release: [2, 'uint32 f(void *self)'],
  EnumAdapters1: [12, 'long f(void *self, uint32 i, _Out_ void **out)'],
  AdapterGetDesc1: [10, 'long f(void *self, _Out_ DXGI_ADAPTER_DESC1 *desc)'],
  EnumOutputs: [7, 'long f(void *self, uint32 i, _Out_ void **out)'],
  OutputGetDesc: [7, 'long f(void *self, _Out_ DXGI_OUTPUT_DESC *desc)'],
  DuplicateOutput: [22, 'long f(void *self, void *device, _Out_ void **out)'],
  DuplGetDesc: [7, 'void f(void *self, _Out_ DXGI_OUTDUPL_DESC *desc)'],
  AcquireNextFrame: [8, 'long f(void *self, uint32 timeout, _Out_ DXGI_OUTDUPL_FRAME_INFO *info, _Out_ void **res)'],
  ReleaseFrame: [14, 'long f(void *self)'],
  CreateTexture2D: [5, 'long f(void *self, D3D11_TEXTURE2D_DESC *desc, void *init, _Out_ void **out)'],
  CreateQuery: [24, 'long f(void *self, D3D11_QUERY_DESC *desc, _Out_ void **out)'],
  Map: [14, 'long f(void *self, void *res, uint32 sub, int type, uint32 flags, _Out_ D3D11_MAPPED_SUBRESOURCE *mapped)'],
  Unmap: [15, 'void f(void *self, void *res, uint32 sub)'],
  End: [28, 'void f(void *self, void *query)'],
  GetData: [29, 'long f(void *self, void *query, _Out_ int32 *data, uint32 size, uint32 flags)'],
  CopyResource: [47, 'void f(void *self, void *dst, void *src)'],
  UpdateSubresource: [48, 'void f(void *self, void *dst, uint32 sub, void *box, void *src, uint32 rowPitch, uint32 depthPitch)'],
  Flush: [111, 'void f(void *self)'],
  CreateSharedHandle: [13, 'long f(void *self, void *attrs, uint32 access, void *name, _Out_ void **handle)'],
};
for (const k of Object.keys(M)) {
  // Cada protótipo precisa de um nome único no koffi.
  M[k] = { index: M[k][0], proto: koffi.proto(M[k][1].replace(' f(', ` Dxgi_${k}(`)) };
}

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

function release(obj) {
  if (obj) { try { call(obj, 'Release'); } catch { /* ok */ } }
}

function queryInterface(obj, iid) {
  const out = [null];
  check(call(obj, 'QueryInterface', iid, out), 'QueryInterface');
  return out[0];
}

function createFactory() {
  const fac = [null];
  check(CreateDXGIFactory1(IID.IDXGIFactory1, fac), 'CreateDXGIFactory1');
  return fac[0];
}

function getAdapter(factory, index) {
  const ad = [null];
  check(call(factory, 'EnumAdapters1', index, ad), 'EnumAdapters1');
  return ad[0];
}

function createDevice(adapter) {
  const dev = [null];
  const ctx = [null];
  const level = [0];
  check(D3D11CreateDevice(adapter, D3D_DRIVER_TYPE_UNKNOWN, null, D3D11_CREATE_DEVICE_BGRA_SUPPORT, null, 0, D3D11_SDK_VERSION, dev, level, ctx), 'D3D11CreateDevice');
  const q = [null];
  check(call(dev[0], 'CreateQuery', { Query: D3D11_QUERY_EVENT, MiscFlags: 0 }, q), 'CreateQuery');
  return { device: dev[0], context: ctx[0], query: q[0] };
}

function destroyDevice(d) {
  if (!d) return;
  release(d.query);
  release(d.context);
  release(d.device);
}

// Espera a GPU terminar o que foi enviado (para o Chromium não ler um quadro pela metade).
function gpuWait(d, maxMs = 20) {
  call(d.context, 'End', d.query);
  call(d.context, 'Flush');
  const done = [0];
  const t0 = process.hrtime.bigint();
  const limit = BigInt(maxMs) * 1000000n;
  while (call(d.context, 'GetData', d.query, done, 4, 0) === S_FALSE) {
    if (process.hrtime.bigint() - t0 > limit) break;
  }
}

// ------------------------------------------------------------ placas e monitores
function enumAdapters() {
  const factory = createFactory();
  const list = [];
  try {
    for (let a = 0; ; a++) {
      const ad = [null];
      const hr = call(factory, 'EnumAdapters1', a, ad);
      if (hr === DXGI_ERROR_NOT_FOUND) break;
      check(hr, 'EnumAdapters1');
      const desc = {};
      call(ad[0], 'AdapterGetDesc1', desc);
      const outputs = [];
      for (let o = 0; ; o++) {
        const out = [null];
        if (call(ad[0], 'EnumOutputs', o, out) !== S_OK) break;
        const od = {};
        call(out[0], 'OutputGetDesc', od);
        const r = od.DesktopCoordinates;
        outputs.push({
          adapterIndex: a, outputIndex: o, deviceName: od.DeviceName,
          left: r.left, top: r.top, width: r.right - r.left, height: r.bottom - r.top,
          attached: !!od.AttachedToDesktop,
        });
        release(out[0]);
      }
      list.push({
        index: a, name: desc.Description, vendorId: desc.VendorId, deviceId: desc.DeviceId,
        vram: Number(desc.DedicatedVideoMemory), software: !!(desc.Flags & 2), outputs,
      });
      release(ad[0]);
    }
  } finally {
    release(factory);
  }
  return list;
}

// ------------------------------------------------------------ duplicação
// src: placa que tem o monitor. dst: placa usada pelo Electron para vídeo.
// Se forem a mesma, a cópia é direta na GPU; se não, passa pela memória.
class Duplicator {
  constructor({ adapterIndex, outputIndex, targetAdapterIndex, ringSize = 6 }) {
    this.ringSize = ringSize;
    this.ring = [];
    this.factory = createFactory();
    this.adapter = getAdapter(this.factory, adapterIndex);
    const out = [null];
    check(call(this.adapter, 'EnumOutputs', outputIndex, out), 'EnumOutputs');
    this.output = out[0];
    this.output1 = queryInterface(this.output, IID.IDXGIOutput1);
    this.src = createDevice(this.adapter);
    this.bounce = targetAdapterIndex != null && targetAdapterIndex !== adapterIndex;
    if (this.bounce) {
      this.targetAdapter = getAdapter(this.factory, targetAdapterIndex);
      this.dst = createDevice(this.targetAdapter);
    } else {
      this.dst = this.src;
    }
    this.openDuplication();
  }

  openDuplication() {
    const dup = [null];
    check(call(this.output1, 'DuplicateOutput', this.src.device, dup), 'DuplicateOutput');
    this.dupl = dup[0];
    const desc = {};
    call(this.dupl, 'DuplGetDesc', desc);
    this.width = desc.ModeDesc.Width;
    this.height = desc.ModeDesc.Height;
    this.refresh = desc.ModeDesc.RefreshRate.Denominator
      ? desc.ModeDesc.RefreshRate.Numerator / desc.ModeDesc.RefreshRate.Denominator : 0;
  }

  texture(dev, usage, bind, cpu, misc) {
    const tex = [null];
    check(call(dev.device, 'CreateTexture2D', {
      Width: this.width, Height: this.height, MipLevels: 1, ArraySize: 1,
      Format: DXGI_FORMAT_B8G8R8A8_UNORM, SampleDesc: { Count: 1, Quality: 0 },
      Usage: usage, BindFlags: bind, CPUAccessFlags: cpu, MiscFlags: misc,
    }, null, tex), 'CreateTexture2D');
    return tex[0];
  }

  // Cria as texturas compartilháveis (anel) e devolve os NT handles.
  createRing() {
    this.destroyRing();
    for (let i = 0; i < this.ringSize; i++) {
      const tex = this.texture(this.dst, D3D11_USAGE_DEFAULT, D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET, 0,
        D3D11_RESOURCE_MISC_SHARED | D3D11_RESOURCE_MISC_SHARED_NTHANDLE);
      const res1 = queryInterface(tex, IID.IDXGIResource1);
      const h = [null];
      check(call(res1, 'CreateSharedHandle', null, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, null, h), 'CreateSharedHandle');
      release(res1);
      this.ring.push({ tex, handle: h[0], handleValue: koffi.address(h[0]) });
    }
    if (this.bounce) this.staging = this.texture(this.src, D3D11_USAGE_STAGING, 0, D3D11_CPU_ACCESS_READ, 0);
    this.next = 0;
    return this.ring.map((r) => r.handleValue);
  }

  destroyRing() {
    for (const r of this.ring) {
      try { CloseHandle(r.handle); } catch { /* ok */ }
      release(r.tex);
    }
    this.ring = [];
    release(this.staging);
    this.staging = null;
  }

  // Espera o próximo quadro (até timeoutMs). Devolve:
  //   null                      -> nada mudou
  //   { resized: true }         -> mudou a resolução, recrie o anel
  //   { index, pointer }        -> quadro novo na textura `index` (ou -1 se só o mouse mexeu)
  acquire(timeoutMs) {
    const info = {};
    const res = [null];
    const hr = call(this.dupl, 'AcquireNextFrame', timeoutMs, info, res);
    if (hr === DXGI_ERROR_WAIT_TIMEOUT) return null;
    if (hr === DXGI_ERROR_ACCESS_LOST) {
      // Troca de resolução, tela de UAC, jogo em tela cheia exclusiva assumindo...
      release(this.dupl);
      this.dupl = null;
      const w = this.width;
      const h = this.height;
      this.openDuplication();
      return { resized: w !== this.width || h !== this.height };
    }
    check(hr, 'AcquireNextFrame');
    let result = null;
    let mapped = false;
    try {
      const pointer = info.LastMouseUpdateTime
        ? { x: info.PointerPosition.Position.x, y: info.PointerPosition.Position.y, visible: !!info.PointerPosition.Visible }
        : null;
      if (info.LastPresentTime && this.ring.length) {
        const tex = queryInterface(res[0], IID.ID3D11Texture2D);
        const slot = this.next;
        this.next = (this.next + 1) % this.ring.length;
        if (!this.bounce) {
          call(this.src.context, 'CopyResource', this.ring[slot].tex, tex);
          release(tex);
        } else {
          call(this.src.context, 'CopyResource', this.staging, tex);
          release(tex);
          const m = {};
          check(call(this.src.context, 'Map', this.staging, 0, D3D11_MAP_READ, 0, m), 'Map');
          mapped = true;
          call(this.dst.context, 'UpdateSubresource', this.ring[slot].tex, 0, null, m.pData, m.RowPitch, 0);
        }
        gpuWait(this.dst);
        result = { index: slot, pointer };
      } else if (pointer) {
        result = { index: -1, pointer };
      }
    } finally {
      if (mapped) call(this.src.context, 'Unmap', this.staging, 0);
      release(res[0]);
      call(this.dupl, 'ReleaseFrame');
    }
    return result;
  }

  close() {
    this.destroyRing();
    release(this.dupl);
    if (this.bounce) destroyDevice(this.dst);
    destroyDevice(this.src);
    release(this.output1);
    release(this.output);
    release(this.targetAdapter);
    release(this.adapter);
    release(this.factory);
    this.dupl = this.output1 = this.output = this.adapter = this.targetAdapter = this.factory = null;
    this.src = this.dst = null;
  }
}

module.exports = { enumAdapters, Duplicator };
