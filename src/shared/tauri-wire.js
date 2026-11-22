// JSON transport values without JSON's undefined/nonfinite/bigint loss.
export const TAURI_WIRE_MAX_DEPTH = 64;
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
function shape(o, fields) {
  if (!o || typeof o !== 'object' || Array.isArray(o)
    || Object.keys(o).some((k) => !fields.includes(k))) throw new TypeError('Invalid wire value');
}
export function encodeTauriWire(value) {
  const seen = new Set();
  function encode(v, depth) {
    if (depth > TAURI_WIRE_MAX_DEPTH) throw new TypeError('Wire nesting limit exceeded');
    if (v === undefined) return { t: 'undefined' };
    if (v === null) return { t: 'null' };
    if (typeof v === 'string' || typeof v === 'boolean') return { t: typeof v, v };
    if (typeof v === 'number') return { t: 'number', v: Object.is(v, -0) ? '-0' : Number.isFinite(v) ? v : String(v) };
    if (typeof v === 'bigint') return { t: 'bigint', v: String(v) };
    if (typeof v !== 'object') throw new TypeError('Unsupported wire value');
    if (seen.has(v)) throw new TypeError('Cyclic wire value');
    seen.add(v);
    try {
      if (Array.isArray(v)) return { t: 'array', v: Array.from(v, (item) => encode(item, depth + 1)) };
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new TypeError('Wire objects must be plain');
      if (Object.getOwnPropertySymbols(v).length) throw new TypeError('Symbol wire keys are unsupported');
      return { t: 'object', v: Object.keys(v).map((k) => {
        if (forbidden.has(k)) throw new TypeError('Unsafe wire key');
        const descriptor = Object.getOwnPropertyDescriptor(v, k);
        if (!own(descriptor, 'value')) throw new TypeError('Wire accessors are unsupported');
        return [k, encode(descriptor.value, depth + 1)];
      }) };
    } finally { seen.delete(v); }
  }
  return encode(value, 0);
}
export function decodeTauriWire(value) {
  function decode(o, depth) {
    if (depth > TAURI_WIRE_MAX_DEPTH) throw new TypeError('Wire nesting limit exceeded');
    shape(o, ['t', 'v']);
    if (!own(o, 't') || typeof o.t !== 'string') throw new TypeError('Missing wire tag');
    if (o.t === 'undefined' || o.t === 'null') {
      if (own(o, 'v')) throw new TypeError('Unexpected wire payload');
      return o.t === 'null' ? null : undefined;
    }
    if (!own(o, 'v')) throw new TypeError('Missing wire payload');
    if ((o.t === 'boolean' || o.t === 'string') && typeof o.v === o.t) return o.v;
    if (o.t === 'number') {
      if (typeof o.v === 'number' && Number.isFinite(o.v)) return o.v;
      if (['NaN', 'Infinity', '-Infinity', '-0'].includes(o.v)) return o.v === '-0' ? -0 : Number(o.v);
    }
    if (o.t === 'bigint' && typeof o.v === 'string' && /^-?(0|[1-9][0-9]*)$/.test(o.v)) return BigInt(o.v);
    if (o.t === 'array' && Array.isArray(o.v)) return o.v.map((v) => decode(v, depth + 1));
    if (o.t === 'object' && Array.isArray(o.v)) {
      const result = {};
      for (const entry of o.v) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string'
          || forbidden.has(entry[0]) || own(result, entry[0])) throw new TypeError('Invalid wire object key');
        result[entry[0]] = decode(entry[1], depth + 1);
      }
      return result;
    }
    throw new TypeError('Invalid wire payload');
  }
  return decode(value, 0);
}
export const encodeWire = encodeTauriWire;
export const decodeWire = decodeTauriWire;
