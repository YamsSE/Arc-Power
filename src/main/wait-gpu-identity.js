// Wait briefly for startup inventory enrichment, without guessing a GPU from
// an ordinal or from an alias shared by another row.
export async function waitForWritableGpuIdentity(listDevices, keys = [], { timeoutMs = 5000, pollMs = 250 } = {}) {
  if (typeof listDevices !== 'function') return false;
  const requested = [...new Set(keys.filter((key) => typeof key === 'string' && key.length > 0))];
  const deadline = Date.now() + timeoutMs;
  const writable = (row) => row && row.synthetic !== true && row.backendKind !== 'os' && row.identityAmbiguous !== true;
  while (Date.now() < deadline) {
    let timer;
    let rows;
    try {
      rows = await Promise.race([
        Promise.resolve().then(() => listDevices()).catch(() => null),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), Math.max(1, deadline - Date.now())); }),
      ]);
    } finally { clearTimeout(timer); }
    if (Array.isArray(rows)) {
      const ready = requested.length === 0 ? rows.some(writable) : requested.every((key) => {
        const matches = rows.filter((row) => row?.deviceKey === key || row?.deviceKeys?.includes?.(key));
        return matches.length === 1 && writable(matches[0]);
      });
      if (ready) return true;
    }
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remaining)));
  }
  return false;
}
