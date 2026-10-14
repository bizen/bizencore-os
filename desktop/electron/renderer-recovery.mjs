export function installRendererRecovery({ window, cancelAuthentication, revokeAccess, showMessageBox, quit }) {
  let recovering = false;
  const alive = () => !window.isDestroyed() && !window.webContents.isDestroyed();
  const recover = async (_event, details) => {
    cancelAuthentication();
    revokeAccess();
    if (recovering || !alive() || details.reason === 'clean-exit') return;
    recovering = true;
    try {
      const { response } = await showMessageBox(window, {
        type: 'error',
        title: 'bizencore terminal',
        message: '画面が予期せず終了しました',
        detail: 'エージェントを停止しました。画面を復旧した後、作業内容を確認してから再開してください。',
        buttons: ['再読み込み', '終了'], defaultId: 0, cancelId: 1, noLink: true,
      });
      if (!alive()) return;
      if (response === 0) window.webContents.reload();
      else quit();
    } catch {
      if (alive()) quit();
    } finally {
      recovering = false;
    }
  };
  window.webContents.on('render-process-gone', recover);
  return recover;
}
