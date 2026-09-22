import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectSysinfo, isDegradedSysinfo, resetSysinfoCache } from '../src/main/sysinfo.js';

const RICH_CIM = JSON.stringify({
  cpu: { Name: 'Intel(R) Core(TM) i7-5775C CPU', NumberOfCores: 4, NumberOfLogicalProcessors: 8, MaxClockSpeed: 3300, Manufacturer: 'GenuineIntel' },
  computerSystem: { TotalPhysicalMemory: 34359738368 },
  systemEnclosure: { ChassisTypes: [3] },
  physicalMemory: { Manufacturer: '0420', ConfiguredClockSpeed: 2400, SMBIOSMemoryType: 24, PartNumber: 'F3-2400C11-8GXM' },
  baseboard: { Manufacturer: 'ASUSTeK COMPUTER INC.', Product: 'MAXIMUS VII RANGER' },
  videoControllers: [{ Name: 'Intel(R) Arc(TM) B580 Graphics', AdapterRAM: 4294967295, PNPDeviceID: 'PCI\\VEN_8086&DEV_E20B&SUBSYS_00000000', DriverVersion: '32.0.101.8861' }],
  registryMemory: [],
  allocatedBar: [],
});

test('real sysinfo boot retry recovers a degraded first CIM result once', async () => {
  resetSysinfoCache();
  let calls = 0;
  const execFile = async () => {
    calls += 1;
    return { stdout: calls === 1 ? 'transient startup output' : RICH_CIM };
  };
  try {
    const result = await collectSysinfo({ execFile, retryOnDegraded: true, retryDelayMs: 0, retryTimeoutMs: 2500 });
    assert.equal(calls, 2);
    assert.equal(isDegradedSysinfo(result), false);
    assert.equal(result.baseboard.product, 'MAXIMUS VII RANGER');
    assert.equal(result.videoControllers.length, 1);
  } finally {
    resetSysinfoCache();
  }
});

test('normal sysinfo callers still cache a degraded result after one query', async () => {
  resetSysinfoCache();
  let calls = 0;
  const execFile = async () => {
    calls += 1;
    return { stdout: 'transient startup output' };
  };
  try {
    const first = await collectSysinfo({ execFile });
    const second = await collectSysinfo({ execFile });
    assert.equal(calls, 1);
    assert.equal(first, second);
    assert.equal(isDegradedSysinfo(first), true);
  } finally {
    resetSysinfoCache();
  }
});

test('a failed recovery keeps the exact returned fallback in the module cache', async () => {
  resetSysinfoCache();
  let calls = 0;
  const execFile = async () => {
    calls += 1;
    return { stdout: 'still unavailable' };
  };
  try {
    const result = await collectSysinfo({ execFile, retryOnDegraded: true, retryDelayMs: 0, retryTimeoutMs: 2500 });
    const cached = await collectSysinfo({ execFile });
    assert.equal(calls, 2);
    assert.equal(cached, result);
  } finally {
    resetSysinfoCache();
  }
});
