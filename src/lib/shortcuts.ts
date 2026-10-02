/**
 * キーボードの一覧。ヘルプ（⌘/）とフッターの手引きで同じ定義を使う。
 *
 * footer を持つものだけがフッターに並ぶ。画面に手がかりが無くて
 * 気づきにくいキーを選び、幅が限られるので短い言い方にしてある。
 */
export interface Shortcut {
  keys: string;
  label: string;
  /** フッターに出すときの表記。無ければ出さない */
  footer?: { keys?: string; label: string };
}

export const FOCUS_SHORTCUT_CODES = ['Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9'];

export function focusShortcut(index: number): string | null {
  const code = FOCUS_SHORTCUT_CODES[index];
  return code ? `⌥${code.slice(-1)}` : null;
}

export const SHORTCUTS: Shortcut[] = [
  { keys: 'Enter', label: '下に新しい行', footer: { label: '新しい行' } },
  { keys: '↑ / ↓', label: '行を移動' },
  { keys: '→', label: '行末から右へ抜けてメタ欄へ', footer: { label: 'メタ欄へ' } },
  { keys: '← / →', label: 'メタ欄を歩く（← で本文へ戻る）' },
  { keys: 'Tab / ⌘→', label: 'サブタスクにする', footer: { keys: 'Tab', label: 'サブタスク' } },
  { keys: '⇧Tab / ⌘←', label: '1段上げる' },
  { keys: '⌘↑ / ⌘↓', label: '行ごと並べ替え（子も一緒）' },
  { keys: '⌘Enter', label: '完了 / 未完了', footer: { label: '完了' } },
  { keys: '⇧Enter', label: 'メモを開く', footer: { label: 'メモ' } },
  { keys: '⌘I', label: 'タスクの詳細を開く' },
  { keys: '詳細内 Tab / ⇧Tab・↑ / ↓', label: '詳細パネル内を移動（入力欄の上下キーは行の端で移動）' },
  { keys: '⌥T', label: 'today に入れる / 外す', footer: { label: 'today' } },
  { keys: '⌥E', label: '右パネルの作業想定時間へ移動（30 / 45m / 1.5h / 1h30）', footer: { label: '想定時間' } },
  { keys: '⌥M', label: 'クエスト種別（なし→橙→青）/ ラベルの色', footer: { label: '種別 / 色' } },
  { keys: '⌥S', label: 'ラベルを追加' },
  { keys: '⌥C', label: '完了を整理（完了済みへ移す）' },
  { keys: '⌥⇧C', label: '完了を削除' },
  { keys: '⌘⌫ / 空行で ⌫', label: '行を削除', footer: { keys: '⌘⌫', label: '削除' } },
  { keys: '⌘Z', label: '取り消し', footer: { label: '取り消し' } },
  { keys: '⌥1 / ⌥2 / ⌥3', label: 'all / board / today' },
  { keys: '⌥4〜⌥9', label: 'フォーカスを追加した順に切り替える（先頭6件）' },
  { keys: '⌘F', label: '検索を開く' },
  { keys: '⌘K', label: 'tasks ⇄ count を切り替え' },
  { keys: '⌘/', label: 'ヘルプを開く / 閉じる', footer: { label: 'ヘルプ' } },
  { keys: 'Esc', label: '編集をやめる / 検索を閉じる' },
];

export const FOOTER_SHORTCUTS = SHORTCUTS.filter((s) => s.footer).map((s) => ({
  keys: s.footer!.keys ?? s.keys,
  label: s.footer!.label,
}));
