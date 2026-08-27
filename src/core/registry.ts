export function reserveMapEntry<K, V>(
  entries: Map<K, V>,
  key: K,
  value: V,
  accept: () => boolean
): boolean {
  if (entries.has(key)) return false;
  entries.set(key, value);
  const accepted = accept();
  if (!accepted && entries.get(key) === value) entries.delete(key);
  return accepted;
}
