/**
 * 行のメタ欄（種別 / today / 期限 / 削除）をカーソルのように歩くための DOM 操作。
 *
 * 本文の行末で → を押すと入ってきて、先頭で ← を押すと本文へ戻る。
 * ボタンは `data-meta="<種類>"` で見つける。上下移動では同じ種類のボタンへ移る。
 */
import type { KeyboardEvent } from 'react';

function metaButtonsOf(row: Element | null | undefined): HTMLElement[] {
  return row
    ? Array.from(row.querySelectorAll<HTMLElement>('[data-meta]')).filter((button) => button.getClientRects().length > 0)
    : [];
}

function focusTitleEnd(row: Element | null | undefined): boolean {
  const el = row?.querySelector<HTMLTextAreaElement>('.row-title');
  if (!el) return false;
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
  return true;
}

export function focusFirstMeta(row: Element | null | undefined): boolean {
  const first = metaButtonsOf(row)[0];
  if (!first) return false;
  first.focus();
  return true;
}

export function handleMetaKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
  const button = event.currentTarget;
  const row = button.closest('.row');
  const buttons = metaButtonsOf(row);
  const index = buttons.indexOf(button);

  if (event.key === 'ArrowRight') {
    const next = buttons[index + 1];
    if (!next) return;
    event.preventDefault();
    next.focus();
    return;
  }

  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    const prev = buttons[index - 1];
    if (prev) prev.focus();
    else focusTitleEnd(row);
    return;
  }

  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    const sibling =
      event.key === 'ArrowUp' ? row?.previousElementSibling : row?.nextElementSibling;
    if (!sibling) return;
    event.preventDefault();
    const siblingButtons = metaButtonsOf(sibling);
    const sameKind = siblingButtons.find((el) => el.dataset.meta === button.dataset.meta);
    const target = sameKind ?? siblingButtons[siblingButtons.length - 1];
    if (target) target.focus();
    else focusTitleEnd(sibling);
    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    focusTitleEnd(row);
  }
}
