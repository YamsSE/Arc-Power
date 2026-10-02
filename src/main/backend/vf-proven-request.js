// Keep requested displacement from STOCK; ignore common native origin motion.
function key(points, origin = points?.[0]?.Voltage) {
  if (!Array.isArray(points) || points.length < 2 || !Number.isInteger(origin)
    || !points.every((p) => Number.isInteger(p?.Voltage) && Number.isInteger(p?.Frequency))) return null;
  return JSON.stringify(points.map((p) => [p.Voltage - origin, p.Frequency]));
}
export function provenVfRequest(requested, stock, effective) {
  const request = key(requested, stock?.[0]?.Voltage);
  const source = key(stock);
  const live = key(effective, stock?.[0]?.Voltage);
  return request && source && live ? { request, source, live } : null;
}
export function matchesProvenVfRequest(proven, requested, stock, live) {
  const current = provenVfRequest(requested, stock, live);
  return !!proven && !!current && proven.request === current.request
    && proven.source === current.source && proven.live === current.live;
}
