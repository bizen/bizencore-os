export const SETTINGS_PAGES = [
  { id: 'general', label: '一般', description: '生活世界の表示と、日付・時刻の設定。', keywords: '生活世界 All today タイムゾーン 日付 時刻 自動 同期 timezone general' },
  { id: 'appearance', label: '外観', description: '画面のテーマと、チルノのスタイル。', keywords: 'テーマ ブラック ネイビー ホワイト チルノ マット フラット 色 appearance theme' },
  { id: 'notifications', label: '通知', description: 'この端末で受け取る通知を選びます。', keywords: '期限 朝 Today エージェント 完了 プッシュ 時刻 notifications' },
  { id: 'partner', label: 'パートナー', description: 'パートナーとの接続と、ラベルの公開設定。', keywords: '招待 リンク コード 共有 公開 ラベル 接続 partner' },
  { id: 'connections', label: '接続', description: 'このアカウントで利用されたMCP接続元。', keywords: 'MCP 履歴 最終利用 Codex Claude ChatGPT Antigravity connections' },
  { id: 'account', label: 'アカウント', description: 'アカウントと保存データの管理。', keywords: '削除 データ 消去 account delete' },
] as const;

export type SettingsPage = typeof SETTINGS_PAGES[number]['id'];

export function findSettingsPages(query: string) {
  const words = query.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/);
  return SETTINGS_PAGES.filter(page => {
    const text = `${page.label} ${page.description} ${page.keywords}`.normalize('NFKC').toLocaleLowerCase();
    return words.every(word => text.includes(word));
  });
}
