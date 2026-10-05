const DEFAULT_BOUNDS = Object.freeze({ width: 1280, height: 820 });
const MIN_BOUNDS = Object.freeze({ width: 980, height: 640 });

function validRect(rect) {
  return rect && Number.isFinite(rect.x) && Number.isFinite(rect.y)
    && Number.isFinite(rect.width) && Number.isFinite(rect.height)
    && rect.width > 0 && rect.height > 0;
}

function intersectionArea(a, b) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

/** Restores normal bounds fully inside a current display work area. */
export function restoreWindowState(saved, displays, defaults = DEFAULT_BOUNDS) {
  const source = saved?.version === 1 && validRect(saved.normalBounds)
    ? saved.normalBounds
    : { x: 0, y: 0, ...defaults };
  const workAreas = (Array.isArray(displays) ? displays : [])
    .map((display) => display?.workArea)
    .filter(validRect);
  const fallbackArea = workAreas[0] ?? { x: 0, y: 0, width: 1920, height: 1080 };
  const area = workAreas.reduce((best, candidate) =>
    intersectionArea(source, candidate) > intersectionArea(source, best) ? candidate : best, fallbackArea);
  const minWidth = Math.min(MIN_BOUNDS.width, area.width);
  const minHeight = Math.min(MIN_BOUNDS.height, area.height);
  const width = Math.max(minWidth, Math.min(source.width, area.width));
  const height = Math.max(minHeight, Math.min(source.height, area.height));
  const x = Math.max(area.x, Math.min(source.x, area.x + area.width - width));
  const y = Math.max(area.y, Math.min(source.y, area.y + area.height - height));
  return {
    normalBounds: { x, y, width, height },
    maximized: saved?.version === 1 && saved.maximized === true,
  };
}

export function serializeWindowState(normalBounds, maximized) {
  if (!validRect(normalBounds)) return null;
  return {
    version: 1,
    normalBounds: {
      x: Math.round(normalBounds.x),
      y: Math.round(normalBounds.y),
      width: Math.round(normalBounds.width),
      height: Math.round(normalBounds.height),
    },
    maximized: maximized === true,
  };
}
