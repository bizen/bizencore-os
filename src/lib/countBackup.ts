export type CountStock = { id: string; text: string; savedAt: number };
export type CountBackup = { format: 'chrct-count'; version: 1; text: string; stocks: CountStock[] };
export const COUNT_TEXT_KEY = 'chrct.count.text';
export const COUNT_STOCKS_KEY = 'chrct.count.stocks';

export function countBackup(text: string, stocks: CountStock[]): CountBackup {
  const unique = new Map<string, CountStock>();
  for (const stock of stocks) {
    if (!unique.has(stock.text) || unique.get(stock.text)!.savedAt < stock.savedAt) unique.set(stock.text, stock);
  }
  return { format: 'chrct-count', version: 1, text, stocks: [...unique.values()].sort((a, b) => b.savedAt - a.savedAt) };
}

export function parseCountBackup(raw: string): CountBackup {
  const value = JSON.parse(raw);
  if (!value || value.format !== 'chrct-count' || value.version !== 1 || typeof value.text !== 'string' ||
      !Array.isArray(value.stocks) || value.stocks.length > 160 || value.stocks.some((s: CountStock) =>
        !s || typeof s.id !== 'string' || typeof s.text !== 'string' || typeof s.savedAt !== 'number' || !Number.isFinite(s.savedAt) || s.savedAt < 0)) {
    throw new Error('chrctのバックアップファイルではありません。');
  }
  return countBackup(value.text, value.stocks);
}

export function mergeCountBackup(current: CountBackup, incoming: CountBackup, now: number): CountBackup {
  const text = current.text || incoming.text;
  const extra = current.text && incoming.text && current.text !== incoming.text
    ? [{ id: crypto.randomUUID(), text: incoming.text, savedAt: now }] : [];
  const merged = countBackup(text, [...current.stocks, ...incoming.stocks, ...extra]);
  if (merged.stocks.length > 80) throw new Error('ストックが80件を超えるため取り込めません。先にバックアップして整理してください。');
  merged.stocks = merged.stocks.map(stock => ({ ...stock, id: crypto.randomUUID() }));
  return merged;
}

export function storeCountBackup(storage: Storage, backup: CountBackup): void {
  const previous = [storage.getItem(COUNT_TEXT_KEY), storage.getItem(COUNT_STOCKS_KEY)];
  try {
    storage.setItem(COUNT_TEXT_KEY, backup.text);
    storage.setItem(COUNT_STOCKS_KEY, JSON.stringify(backup.stocks));
  } catch (error) {
    for (const [index, key] of [COUNT_TEXT_KEY, COUNT_STOCKS_KEY].entries()) {
      try { if (previous[index] === null) storage.removeItem(key); else storage.setItem(key, previous[index]!); } catch { /* Preserve the original storage error. */ }
    }
    throw error;
  }
}
