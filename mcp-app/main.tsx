import { createRoot } from 'react-dom/client';
import { App } from '@modelcontextprotocol/ext-apps';
import { Picker, type Page, type Detail, type PickerClient } from './Picker';
import { pickerHeight } from './model';
import '../src/index.css';
import './style.css';

const app = new App({ name: 'bizencore task picker', version: '2.0.0' });
// Use negotiated dimensions rather than iframe vh, which can shrink on every auto-resize.
function sizeFromHost() {
  document.documentElement.style.setProperty('--picker-height', `${pickerHeight(app.getHostContext()?.containerDimensions)}px`);
}
app.onhostcontextchanged = sizeFromHost;
async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = await app.callServerTool({ name, arguments: args });
  const content = result.content?.find((item) => item.type === 'text');
  if (result.isError || !content || content.type !== 'text') throw new Error(content?.text ?? '読み込めませんでした。');
  return JSON.parse(content.text) as T;
}
const client: PickerClient = {
  connect: async () => { await app.connect(); sizeFromHost(); },
  page: (offset) => call<Page>('get_task_view', { offset }),
  detail: async (id) => (await call<{ task: Detail }>('get_task', { task_id: id })).task,
  send: async (text) => {
    const result = await app.sendMessage({ role: 'user', content: [{ type: 'text', text }] });
    if (result.isError) throw new Error('このクライアントでは会話へ送信できませんでした。');
  },
};
createRoot(document.getElementById('root')!).render(<Picker client={client} />);
