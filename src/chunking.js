export function chunkTelegramText(text, limit = 3900) {
  const value = String(text ?? '');
  if (value.length <= limit) return value ? [value] : [];

  const chunks = [];
  let remaining = value;
  while (remaining.length > limit) {
    const slice = remaining.slice(0, limit);
    const breakAt = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
    const cut = breakAt > limit * 0.6 ? breakAt : limit;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
