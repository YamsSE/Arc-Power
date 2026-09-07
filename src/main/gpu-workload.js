// A small, bounded D3D11 workload for Stability Lab. The workload is kept in
// the main process so the selected physical adapter is resolved from the same
// DXGI identity used by telemetry; it never falls back to adapter ordinal 0.
import koffi from 'koffi';

const DXGI_ERROR_NOT_FOUND = 0x887A0002;
const D3D_DRIVER_TYPE_UNKNOWN = 0;
const D3D11_SDK_VERSION = 7;
const DXGI_FORMAT_R8G8B8A8_UNORM = 28;
const D3D11_BIND_RENDER_TARGET = 0x20;
const TEXTURE_WIDTH = 3072;
const TEXTURE_HEIGHT = 1728;
const TEXTURE_COUNT = 3;
// The stability run should spend its time on the selected GPU. Repeated
// Clear calls alone are often serviced by a fast-path and can report almost
// no engine work. Pair a clear pass with repeated full-surface uploads/copies
// so Stability Lab produces measurable GPU memory traffic on the selected
// adapter while remaining bounded by the caller's duration.
const CLEARS_PER_TICK = 12;
const UPDATES_PER_TICK = 8;
const COPIES_PER_TICK = 24;
const TICK_MS = 16;
const D3D11_QUERY_EVENT = 0;
const D3D11_ASYNC_GETDATA_DONOTFLUSH = 1;

const HR_ENUM = koffi.proto('int32', ['void*', 'uint32', 'void**']);
const HR_DESC = koffi.proto('int32', ['void*', 'void*']);
const HR_CREATE_TEXTURE = koffi.proto('int32', ['void*', 'void*', 'void*', 'void**']);
const HR_CREATE_VIEW = koffi.proto('int32', ['void*', 'void*', 'void*', 'void**']);
const HR_CREATE_QUERY = koffi.proto('int32', ['void*', 'void*', 'void**']);
const VOID_CLEAR = koffi.proto('void', ['void*', 'void*', 'void*']);
const VOID_COPY_RESOURCE = koffi.proto('void', ['void*', 'void*', 'void*']);
const VOID_UPDATE_SUBRESOURCE = koffi.proto('void', ['void*', 'void*', 'uint32', 'void*', 'void*', 'uint32', 'uint32']);
const VOID_END = koffi.proto('void', ['void*', 'void*']);
const HR_GET_DATA = koffi.proto('int32', ['void*', 'void*', 'void*', 'uint32', 'uint32']);
const VOID_FLUSH = koffi.proto('void', ['void*']);
const RELEASE = koffi.proto('uint32', ['void*']);
// ID3D11DeviceContext inherits the four ID3D11DeviceChild methods and then
// exposes the full command list. These are zero-based COM vtable slots. A
// wrong slot is not recoverable: koffi will call a different native method
// with the Clear/Flush arguments and Windows can terminate the host process
// before JavaScript gets a chance to catch the error.
const CONTEXT_COPY_RESOURCE = 47;
const CONTEXT_UPDATE_SUBRESOURCE = 48;
const CONTEXT_CLEAR_RENDER_TARGET = 50;
const CONTEXT_FLUSH = 55;

const IID_IDXGIFACTORY1 = [
  0x78, 0xae, 0x0a, 0x77, 0x6f, 0xf2, 0xba, 0x4d,
  0xa8, 0x29, 0x25, 0x3c, 0x83, 0xd1, 0xb3, 0x87,
];

function callSlot(object, index, proto, ...args) {
  const vtable = koffi.decode(object, 0, 'void*');
  const functionPointer = koffi.decode(vtable, index * 8, 'void*');
  return koffi.call(functionPointer, proto, ...args);
}

function writeU32(buffer, offset, value) {
  koffi.encode(buffer, offset, 'uint32', value >>> 0);
}

function normalizePciId(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value & 0xffff;
  if (typeof value !== 'string') return null;
  const text = value.trim().replace(/^0x/i, '');
  return /^[0-9a-f]{1,8}$/i.test(text) ? Number.parseInt(text, 16) & 0xffff : null;
}

function normalizeLuid(value) {
  if (typeof value === 'string') {
    const match = value.trim().match(/^(\d+):(\d+)$/);
    if (match) return { high: Number(match[1]) >>> 0, low: Number(match[2]) >>> 0 };
    return null;
  }
  if (Array.isArray(value) && value.length >= 2) {
    const low = Number(value[0]);
    const high = Number(value[1]);
    return Number.isSafeInteger(low) && Number.isSafeInteger(high)
      ? { high: high >>> 0, low: low >>> 0 } : null;
  }
  if (!value || typeof value !== 'object') return null;
  const low = Number(value.low ?? value.LowPart ?? value.lowPart);
  const high = Number(value.high ?? value.HighPart ?? value.highPart);
  return Number.isSafeInteger(low) && Number.isSafeInteger(high)
    ? { high: high >>> 0, low: low >>> 0 } : null;
}

function luidKey(value) {
  const luid = normalizeLuid(value);
  return luid ? `${luid.high}:${luid.low}` : null;
}

function adapterIdentityOf(target) {
  const physical = target?.physicalTarget && typeof target.physicalTarget === 'object' ? target.physicalTarget : target;
  return {
    luid: luidKey(physical?.osLuid ?? physical?.controllerLuid ?? physical?.luid ?? physical?.adapterLuid ?? physical?.adapter_luid),
    vendorId: normalizePciId(physical?.pciVendorId ?? physical?.vendorId),
    deviceId: normalizePciId(physical?.pciDeviceId ?? physical?.deviceId),
  };
}

function adapterDescOf(desc) {
  return {
    vendorId: koffi.decode(desc, 256, 'uint32') & 0xffff,
    deviceId: koffi.decode(desc, 260, 'uint32') & 0xffff,
    // DXGI_ADAPTER_DESC1 stores DedicatedVideoMemory, DedicatedSystemMemory,
    // and SharedSystemMemory before AdapterLuid: LowPart at 296 and HighPart
    // at 300. Flags follows at 304.
    luid: `${koffi.decode(desc, 300, 'int32') >>> 0}:${koffi.decode(desc, 296, 'uint32') >>> 0}`,
  };
}

function textureDesc() {
  const desc = koffi.alloc('uint8', 44);
  writeU32(desc, 0, TEXTURE_WIDTH);
  writeU32(desc, 4, TEXTURE_HEIGHT);
  writeU32(desc, 8, 1); // MipLevels
  writeU32(desc, 12, 1); // ArraySize
  writeU32(desc, 16, DXGI_FORMAT_R8G8B8A8_UNORM);
  writeU32(desc, 20, 1); // DXGI_SAMPLE_DESC.Count
  writeU32(desc, 24, 0); // DXGI_SAMPLE_DESC.Quality
  writeU32(desc, 28, 0); // D3D11_USAGE_DEFAULT
  writeU32(desc, 32, D3D11_BIND_RENDER_TARGET);
  writeU32(desc, 36, 0); // CPUAccessFlags
  writeU32(desc, 40, 0); // MiscFlags
  return desc;
}

function queryDesc() {
  const desc = koffi.alloc('uint8', 8);
  writeU32(desc, 0, D3D11_QUERY_EVENT);
  writeU32(desc, 4, 0);
  return desc;
}

function releaseObject(object) {
  if (!object) return;
  try { callSlot(object, 2, RELEASE, object); } catch { /* best effort */ }
}

function enumerateAdapters(load) {
  const dxgi = load('dxgi.dll');
  const createFactory = dxgi.func('CreateDXGIFactory1', 'int32', ['void*', 'void**']);
  const iid = koffi.alloc('uint8', 16);
  IID_IDXGIFACTORY1.forEach((value, index) => koffi.encode(iid, index, 'uint8', value));
  const factoryBuffer = koffi.alloc('void*', 1);
  const factoryHr = createFactory(iid, factoryBuffer);
  if (factoryHr < 0) throw new Error(`DXGI factory creation failed (0x${factoryHr >>> 0})`);
  const factory = koffi.decode(factoryBuffer, 0, 'void*');
  const adapterBuffer = koffi.alloc('void*', 1);
  const desc = koffi.alloc('uint8', 312);
  const adapters = [];
  try {
    for (let index = 0; index < 32; index += 1) {
      koffi.encode(adapterBuffer, 'void*', 0);
      const hr = callSlot(factory, 12, HR_ENUM, factory, index, adapterBuffer);
      if ((hr >>> 0) === DXGI_ERROR_NOT_FOUND) break;
      if (hr < 0) continue;
      const adapter = koffi.decode(adapterBuffer, 0, 'void*');
      const descHr = callSlot(adapter, 10, HR_DESC, adapter, desc);
      if (descHr >= 0) adapters.push({ adapter, identity: adapterDescOf(desc) });
      else releaseObject(adapter);
    }
    if (!adapters.length) throw new Error('DXGI did not enumerate a graphics adapter');
    return { factory, adapters };
  } catch (error) {
    releaseObject(factory);
    for (const entry of adapters) releaseObject(entry.adapter);
    throw error;
  }
}

function chooseAdapter(adapters, target) {
  const wanted = adapterIdentityOf(target);
  if (!wanted.luid && (wanted.vendorId === null || wanted.deviceId === null)) {
    throw new Error('the selected GPU has no stable DXGI identity');
  }
  const exact = wanted.luid ? adapters.filter((entry) => entry.identity.luid === wanted.luid) : [];
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error('the selected GPU identity is ambiguous');
  if (wanted.vendorId !== null && wanted.deviceId !== null) {
    const pci = adapters.filter((entry) => entry.identity.vendorId === wanted.vendorId && entry.identity.deviceId === wanted.deviceId);
    if (pci.length === 1) return pci[0];
  }
  throw new Error('DXGI could not match the selected GPU');
}

export function createGpuWorkloadController({ load = (name) => koffi.load(name), setInterval: setTimer = (fn, ms) => setInterval(fn, ms), clearInterval: clearTimer = (id) => clearInterval(id) } = {}) {
  let active = null;

  const stop = async () => {
    const run = active;
    active = null;
    if (!run) return;
    if (run.timer !== null) clearTimer(run.timer);
    releaseObject(run.query);
    for (const view of run.views) releaseObject(view);
    for (const texture of run.textures) releaseObject(texture);
    releaseObject(run.context);
    releaseObject(run.device);
    for (const entry of run.adapters) releaseObject(entry.adapter);
    releaseObject(run.factory);
  };

  return {
    async start(target) {
      await stop();
      let enumerated = null;
      let device = null;
      let context = null;
      try {
        enumerated = enumerateAdapters(load);
        const selected = chooseAdapter(enumerated.adapters, target);
        const d3d11 = load('d3d11.dll');
        const createDevice = d3d11.func('D3D11CreateDevice', 'int32', [
          'void*', 'int32', 'void*', 'uint32', 'void*', 'uint32', 'uint32', 'void**', 'void*', 'void**',
        ]);
        const deviceBuffer = koffi.alloc('void*', 1);
        const contextBuffer = koffi.alloc('void*', 1);
        const hr = createDevice(selected.adapter, D3D_DRIVER_TYPE_UNKNOWN, null, 0, null, 0, D3D11_SDK_VERSION, deviceBuffer, null, contextBuffer);
        if (hr < 0) throw new Error(`D3D11 device creation failed (0x${hr >>> 0})`);
        device = koffi.decode(deviceBuffer, 0, 'void*');
        context = koffi.decode(contextBuffer, 0, 'void*');
        const desc = textureDesc();
        const queryBuffer = koffi.alloc('void*', 1);
        const queryHr = callSlot(device, 24, HR_CREATE_QUERY, device, queryDesc(), queryBuffer);
        if (queryHr < 0) throw new Error(`D3D11 event query creation failed (0x${queryHr >>> 0})`);
        const query = koffi.decode(queryBuffer, 0, 'void*');
          const color = Buffer.allocUnsafe(16);
          [0.2, 0.36, 0.62, 1].forEach((value, index) => color.writeFloatLE(value, index * 4));
          const upload = UPDATES_PER_TICK > 0 ? Buffer.alloc(TEXTURE_WIDTH * TEXTURE_HEIGHT * 4, 0x7f) : null;
        const textures = [];
        const views = [];
        try {
          for (let index = 0; index < TEXTURE_COUNT; index += 1) {
            const textureBuffer = koffi.alloc('void*', 1);
            const textureHr = callSlot(device, 5, HR_CREATE_TEXTURE, device, desc, null, textureBuffer);
            if (textureHr < 0) throw new Error(`D3D11 render target creation failed (0x${textureHr >>> 0})`);
            const texture = koffi.decode(textureBuffer, 0, 'void*');
            const viewBuffer = koffi.alloc('void*', 1);
            const viewHr = callSlot(device, 9, HR_CREATE_VIEW, device, texture, null, viewBuffer);
            if (viewHr < 0) {
              releaseObject(texture);
              throw new Error(`D3D11 render view creation failed (0x${viewHr >>> 0})`);
            }
            const view = koffi.decode(viewBuffer, 0, 'void*');
            textures.push(texture);
            views.push(view);
          }
          const run = { factory: enumerated.factory, adapters: enumerated.adapters, adapterLuid: selected.identity.luid, device, context, query, queryPending: false, textures, views, timer: null, color, tick: 0 };
          const tick = () => {
            if (active !== run) return;
            // Do not queue another large upload while the previous batch is
            // still on the GPU. This event fence keeps the workload GPU-bound
            // instead of growing a CPU-side command backlog or consuming
            // unbounded memory during a long stability run.
            try {
              if (run.queryPending) {
                const ready = callSlot(context, 29, HR_GET_DATA, context, run.query, null, 0, D3D11_ASYNC_GETDATA_DONOTFLUSH);
                if (ready !== 0) return;
                run.queryPending = false;
              }
              for (let pass = 0; pass < UPDATES_PER_TICK; pass += 1) {
                const texture = textures[(pass + run.tick) % textures.length];
                callSlot(context, CONTEXT_UPDATE_SUBRESOURCE, VOID_UPDATE_SUBRESOURCE, context, texture, 0, null, upload, TEXTURE_WIDTH * 4, 0);
              }
              for (let pass = 0; pass < COPIES_PER_TICK; pass += 1) {
                const source = textures[(pass + run.tick) % textures.length];
                const destination = textures[(pass + run.tick + 1) % textures.length];
                callSlot(context, CONTEXT_COPY_RESOURCE, VOID_COPY_RESOURCE, context, destination, source);
              }
              for (let pass = 0; pass < CLEARS_PER_TICK; pass += 1) {
                const view = views[(pass + run.tick) % views.length];
                callSlot(context, CONTEXT_CLEAR_RENDER_TARGET, VOID_CLEAR, context, view, color);
              }
              callSlot(context, 28, VOID_END, context, run.query);
              callSlot(context, CONTEXT_FLUSH, VOID_FLUSH, context);
              run.queryPending = true;
              run.tick += 1;
            } catch {
              void stop();
            }
          };
          active = run;
          run.timer = setTimer(tick, TICK_MS);
          // Let the timer own the first native submission so callers receive
          // a successful start response before the driver does any work.
          if (typeof run.timer === 'undefined') tick();
          return { started: true, adapterLuid: selected.identity.luid, deviceKey: target?.deviceKey ?? null };
        } catch (error) {
          for (const view of views) releaseObject(view);
          for (const texture of textures) releaseObject(texture);
          releaseObject(query);
          releaseObject(context);
          releaseObject(device);
          device = null;
          context = null;
          throw error;
        }
      } catch (error) {
        releaseObject(context);
        releaseObject(device);
        if (enumerated) {
          for (const entry of enumerated.adapters) releaseObject(entry.adapter);
          releaseObject(enumerated.factory);
        }
        return { started: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
    stop,
    status: () => active ? { active: true, adapterLuid: active.adapterLuid, tick: active.tick } : { active: false },
  };
}

export { adapterIdentityOf, chooseAdapter, normalizeLuid, CONTEXT_COPY_RESOURCE, CONTEXT_CLEAR_RENDER_TARGET, CONTEXT_FLUSH, D3D11_ASYNC_GETDATA_DONOTFLUSH };
