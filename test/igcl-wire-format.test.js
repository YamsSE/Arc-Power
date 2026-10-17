import test from 'node:test';
import assert from 'node:assert/strict';
import koffi from 'koffi';
import { IgclBackend } from '../src/main/backend/igcl-backend.js';
import {
  decodeWireFormatConfig,
  encodeWireFormatConfig,
} from '../src/main/backend/igcl-bindings.js';

const STRUCT = 'ctl_get_set_wire_format_config_t';
const ENTRY = 'ctl_wire_format_t';

test('wire-format ABI uses the B580 92-byte layout and encodes GET, SET, and RESTORE_DEFAULT', () => {
  assert.equal(koffi.sizeof(ENTRY), 16);
  assert.equal(koffi.offsetof(STRUCT, 'Operation'), 8);
  assert.equal(koffi.offsetof(STRUCT, 'SupportedWireFormat'), 12);
  assert.equal(koffi.offsetof(STRUCT, 'WireFormat'), 76);
  assert.equal(koffi.sizeof(STRUCT), 92);

  for (const operation of [0, 1, 2]) {
    const { buf } = encodeWireFormatConfig({
      operation,
      colorModel: operation === 1 ? 3 : undefined,
      colorDepth: operation === 1 ? 10 : undefined,
    });
    assert.equal(koffi.decode(buf, 0, 'uint32'), 92);
    assert.equal(koffi.decode(buf, 4, 'uint8'), 0);
    assert.equal(koffi.decode(buf, 8, 'int32'), operation);

    for (let i = 0; i < 5; i += 1) {
      const offset = i < 4 ? 12 + (i * 16) : 76;
      assert.equal(koffi.decode(buf, offset, 'uint32'), 16);
      assert.equal(koffi.decode(buf, offset + 4, 'uint8'), 0);
    }

    if (operation === 1) {
      assert.equal(koffi.decode(buf, 84, 'int32'), 3);
      assert.equal(koffi.decode(buf, 88, 'uint32'), 4); // 10bpc flag, not the canonical depth value
    }
  }
});

test('captured B580 wire-format response decodes only usable format/depth pairs', () => {
  // Successful size-92 GET raw bytes captured from the B580 on 2026-10-17.
  const rawB580Response = '5c000000000000000000000010000000000000000000000002000000100000000000000003000000020000001000000000000000000000000000000010000000000000000000000000000000100000000000000000000000020000000000000000000000000000000000000000000000';
  const decoded = decodeWireFormatConfig(Buffer.from(rawB580Response, 'hex'));

  assert.deepEqual(decoded.supported, [
    { model: 'RGB', depth: 8 },
    { model: 'YCBCR_444', depth: 8 },
  ]);
  assert.deepEqual(decoded.supportedModels, ['RGB', 'YCBCR_444']);
  assert.deepEqual(decoded.current, { model: 'RGB', depth: 8 });
  assert.equal(decoded.currentUnavailable, false);
});

test('native wire-format Apply canonicalizes YCbCr read-back and rejects mismatched depth', async () => {
  let current = { model: 0, depthFlag: 2 };
  let forceWrongDepth = false;
  const lib = {
    ctlGetSetWireFormat(_handle, buf) {
      if (koffi.decode(buf, 8, 'uint32') === 1) {
        current = { model: koffi.decode(buf, 84, 'int32'), depthFlag: koffi.decode(buf, 88, 'uint32') };
      } else {
        koffi.encode(buf, 84, 'int32', current.model);
        koffi.encode(buf, 88, 'uint32', forceWrongDepth ? 4 : current.depthFlag);
      }
      return 0;
    },
  };
  const backend = new IgclBackend({ lib });
  backend._device = async () => ({ deviceKey: 'physical-b580', handle: 2n });
  backend._displayOutputsOf = async () => [1n];
  backend._readDisplayOutput = async () => ({ flags: { active: true }, displayKey: 'physical-display', identityVerified: true });
  const request = { deviceKey: 'physical-b580', displayKey: 'physical-display', patch: { wireFormat: { model: 'YCbCr444', depth: 8 } } };
  const good = await backend.setDisplaySettings(0, request);
  assert.equal(good.ok, true);
  assert.equal(good.perControl.wireFormat.readBackEqual, true);
  forceWrongDepth = true;
  const mismatch = await backend.setDisplaySettings(0, request);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.perControl.wireFormat.readBackEqual, false);
});
