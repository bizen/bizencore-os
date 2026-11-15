import { useState } from 'react';
import { countBackup, type CountStock } from '../lib/countBackup';

export function CountExport({ text, stocks, disabled = false }: { text: string; stocks: CountStock[]; disabled?: boolean }) {
  const [error, setError] = useState('');
  return <>
    <button type="button" className="ghost-btn" disabled={disabled} onClick={() => {
      let url: string | undefined;
      try {
        url = URL.createObjectURL(new Blob([JSON.stringify(countBackup(text, stocks), null, 2)], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url; link.download = `chrct-backup-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.append(link); link.click(); link.remove(); setError('');
      } catch { setError('バックアップを保存できませんでした。'); }
      finally { if (url) { const created = url; window.setTimeout(() => URL.revokeObjectURL(created), 1000); } }
    }}>バックアップ</button>
    {error ? <span role="alert">{error}</span> : null}
  </>;
}
