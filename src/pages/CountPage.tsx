import { useAuth } from '@clerk/clerk-react';
import { useMutation, useQuery } from 'convex/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { isCloudConfigured } from '../lib/cloudConfig';

const STORAGE_KEY = 'chrct.count.text';
const STOCKS_KEY = 'chrct.count.stocks';
const MAX_STOCKS = 80;

type StockEntry = {
  id: string;
  text: string;
  savedAt: number;
};

function loadStocks(): StockEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STOCKS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (x): x is StockEntry =>
          typeof x === 'object' &&
          x !== null &&
          typeof (x as StockEntry).id === 'string' &&
          typeof (x as StockEntry).text === 'string' &&
          typeof (x as StockEntry).savedAt === 'number'
      )
      .slice(0, MAX_STOCKS);
  } catch {
    return [];
  }
}

function saveStocks(entries: StockEntry[]) {
  try {
    localStorage.setItem(STOCKS_KEY, JSON.stringify(entries.slice(0, MAX_STOCKS)));
  } catch {
    // ignore
  }
}

function newStockId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function previewText(text: string, max = 72): string {
  const first = (text.split(/\r?\n/)[0] ?? '').trim();
  if (first.length === 0) return '（空）';
  if (first.length <= max) return first;
  return `${first.slice(0, max)}…`;
}

export function CountPage() {
  if (!isCloudConfigured) {
    return <CountPageLocal />;
  }
  return <CountPageCloud />;
}

/** Convex / Clerk 未設定時（hooks を使わない） */
function CountPageLocal() {
  const [text, setText] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    return localStorage.getItem(STORAGE_KEY) ?? '';
  });

  const [localStocks, setLocalStocks] = useState<StockEntry[]>(() => loadStocks());

  const stats = useMemo(() => computeStats(text), [text]);

  const persistText = useCallback((v: string) => {
    setText(v);
    try {
      localStorage.setItem(STORAGE_KEY, v);
    } catch {
      // ignore
    }
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    persistText(e.target.value);
  };

  const clear = () => {
    persistText('');
  };

  const stockCurrent = () => {
    const t = text;
    if (!t.trim()) return;
    const entry: StockEntry = {
      id: newStockId(),
      text: t,
      savedAt: Date.now(),
    };
    const next = [entry, ...localStocks.filter((s) => s.text !== t)].slice(0, MAX_STOCKS);
    setLocalStocks(next);
    saveStocks(next);
  };

  const restoreStock = (entry: StockEntry) => {
    persistText(entry.text);
  };

  const removeStock = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const next = localStocks.filter((s) => s.id !== id);
    setLocalStocks(next);
    saveStocks(next);
  };

  return (
    <CountPageLayout
      text={text}
      onTextChange={handleChange}
      stats={stats}
      headerActions={
        <button type="button" className="ghost-btn" onClick={clear} disabled={text.length === 0}>
          clear
        </button>
      }
      stocks={localStocks}
      stocksLoading={false}
      stockCurrent={stockCurrent}
      restoreStock={restoreStock}
      removeStock={removeStock}
    />
  );
}

function CountPageCloud() {
  const { isSignedIn, isLoaded } = useAuth();
  const useCloud = isLoaded && isSignedIn === true;

  const [text, setText] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    return localStorage.getItem(STORAGE_KEY) ?? '';
  });

  const [localStocks, setLocalStocks] = useState<StockEntry[]>(() => loadStocks());

  const cloudDocs = useQuery(api.countStocks.list, useCloud ? {} : 'skip');
  const addCloudStock = useMutation(api.countStocks.add);
  const removeCloudStock = useMutation(api.countStocks.remove);
  const mergeLocalStocks = useMutation(api.countStocks.mergeLocalStocks);

  const stocks: StockEntry[] = useCloud
    ? (cloudDocs ?? []).map((d) => ({
        id: d._id,
        text: d.text,
        savedAt: d.savedAt,
      }))
    : localStocks;

  const stocksLoading = useCloud && cloudDocs === undefined;

  useEffect(() => {
    if (!useCloud) return;
    const local = loadStocks();
    if (local.length === 0) return;
    void mergeLocalStocks({
      entries: local.map((s) => ({ text: s.text, savedAt: s.savedAt })),
    })
      .then(() => {
        saveStocks([]);
        setLocalStocks([]);
      })
      .catch(() => {});
  }, [useCloud, mergeLocalStocks]);

  const stats = useMemo(() => computeStats(text), [text]);

  const persistText = useCallback((v: string) => {
    setText(v);
    try {
      localStorage.setItem(STORAGE_KEY, v);
    } catch {
      // ignore
    }
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    persistText(e.target.value);
  };

  const clear = () => {
    persistText('');
  };

  const stockCurrent = () => {
    const t = text;
    if (!t.trim()) return;
    if (useCloud) {
      void addCloudStock({ text: t });
      return;
    }
    const entry: StockEntry = {
      id: newStockId(),
      text: t,
      savedAt: Date.now(),
    };
    const next = [entry, ...localStocks.filter((s) => s.text !== t)].slice(0, MAX_STOCKS);
    setLocalStocks(next);
    saveStocks(next);
  };

  const restoreStock = (entry: StockEntry) => {
    persistText(entry.text);
  };

  const removeStock = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (useCloud) {
      void removeCloudStock({ id: id as Id<'countStocks'> });
      return;
    }
    const next = localStocks.filter((s) => s.id !== id);
    setLocalStocks(next);
    saveStocks(next);
  };

  return (
    <CountPageLayout
      text={text}
      onTextChange={handleChange}
      stats={stats}
      headerActions={
        <button type="button" className="ghost-btn" onClick={clear} disabled={text.length === 0}>
          clear
        </button>
      }
      stocks={stocks}
      stocksLoading={stocksLoading}
      stockCurrent={stockCurrent}
      restoreStock={restoreStock}
      removeStock={removeStock}
    />
  );
}

function computeStats(text: string) {
  const chars = [...text].length;
  const charsNoSpace = [...text.replace(/\s/g, '')].length;
  const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
  const lines = text.length === 0 ? 0 : text.split(/\r?\n/).length;
  return { chars, charsNoSpace, words, lines };
}

type CountPageLayoutProps = {
  text: string;
  onTextChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  stats: ReturnType<typeof computeStats>;
  headerActions: React.ReactNode;
  stocks: StockEntry[];
  stocksLoading: boolean;
  stockCurrent: () => void;
  restoreStock: (entry: StockEntry) => void;
  removeStock: (id: string, e: React.MouseEvent) => void;
};

function CountPageLayout({
  text,
  onTextChange,
  stats,
  headerActions,
  stocks,
  stocksLoading,
  stockCurrent,
  restoreStock,
  removeStock,
}: CountPageLayoutProps) {
  return (
    <section className="page">
      <div className="page-header">
        <h1 className="page-title">character count</h1>
        <div className="page-header-actions">{headerActions}</div>
      </div>

      <div className="stat-row">
        <Stat label="characters" value={stats.chars} />
        <Stat label="no spaces" value={stats.charsNoSpace} />
        <Stat label="words" value={stats.words} />
        <Stat label="lines" value={stats.lines} />
      </div>

      <textarea
        className="count-textarea"
        data-reload-storage-key={STORAGE_KEY}
        placeholder="ここに文字を入力..."
        value={text}
        onChange={onTextChange}
      />

      <section className="count-stocks" aria-label="ストック一覧">
        {stocksLoading ? (
          <p className="muted count-stocks-loading">loading...</p>
        ) : (
          <ul className="count-stock-list">
            {stocks.map((s) => (
              <li key={s.id} className="count-stock-item">
                <div className="count-stock-row">
                  <button
                    type="button"
                    className="count-stock-restore"
                    onClick={() => restoreStock(s)}
                  >
                    <span className="count-stock-preview">{previewText(s.text)}</span>
                    <span className="count-stock-meta muted">
                      {[...s.text].length.toLocaleString()} 字 ·{' '}
                      {new Date(s.savedAt).toLocaleString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="ストックから削除"
                    onClick={(e) => removeStock(s.id, e)}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="count-stock-actions">
          <button
            type="button"
            className="ghost-btn count-stock-save-btn"
            onClick={stockCurrent}
            disabled={text.trim().length === 0 || stocksLoading}
          >
            ストック
          </button>
        </div>
      </section>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <div className="stat-value">{value.toLocaleString()}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
