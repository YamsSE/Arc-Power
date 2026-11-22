function mediaUrl(value, kind) {
  if (typeof value !== 'string') return value;
  const prefix = `arc-power-media://${kind}/`;
  return value.startsWith(prefix)
    ? `http://arc-power-media.localhost/${kind}/${value.slice(prefix.length)}`
    : value;
}

// Only these two product fields contain playback URLs. User-authored strings,
// profiles and event values must pass through the bridge unchanged.
export function adaptTauriMediaResult(channel, value) {
  if (channel === 'recording-clip-url') return mediaUrl(value, 'clip');
  if (channel === 'recording-clips-list' && Array.isArray(value)) {
    return value.map(clip => clip && typeof clip === 'object'
      && typeof clip.thumbnailUrl === 'string'
      ? { ...clip, thumbnailUrl: mediaUrl(clip.thumbnailUrl, 'thumbnail') }
      : clip);
  }
  return value;
}
