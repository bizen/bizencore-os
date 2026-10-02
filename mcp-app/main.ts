import { App } from '@modelcontextprotocol/ext-apps';
import './style.css';

type Task = {
  id: string;
  text: string;
  label?: string;
  parent_task?: string;
  due_date?: string;
};

type TaskPage = {
  labels: string[];
  tasks: Task[];
  next_offset?: number;
};

const app = new App({ name: 'bizencore task picker', version: '1.0.0' });
const label = document.querySelector<HTMLSelectElement>('#label')!;
const due = document.querySelector<HTMLSelectElement>('#due')!;
const today = document.querySelector<HTMLInputElement>('#today')!;
const query = document.querySelector<HTMLInputElement>('#query')!;
const status = document.querySelector<HTMLElement>('#status')!;
const tasks = document.querySelector<HTMLElement>('#tasks')!;

let allTasks: Task[] = [];
let loadId = 0;
let searchTimer: ReturnType<typeof setTimeout> | undefined;

function readPage(result: Awaited<ReturnType<typeof app.callServerTool>>): TaskPage {
  if (result.isError) throw new Error('タスクを読み込めませんでした。');
  const content = result.content?.find((item) => item.type === 'text');
  if (!content || content.type !== 'text') throw new Error('タスクを読み込めませんでした。');
  const page = JSON.parse(content.text) as TaskPage;
  if (!Array.isArray(page.tasks) || !Array.isArray(page.labels)) throw new Error('タスクの形式が正しくありません。');
  return page;
}

function matchesDue(task: Task): boolean {
  if (due.value === 'all') return true;
  if (!task.due_date) return false;
  if (due.value === 'dated') return true;
  const current = new Date();
  const day = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}-${String(current.getDate()).padStart(2, '0')}`;
  if (due.value === 'overdue') return task.due_date < day;
  const week = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 7);
  const end = `${week.getFullYear()}-${String(week.getMonth() + 1).padStart(2, '0')}-${String(week.getDate()).padStart(2, '0')}`;
  return task.due_date >= day && task.due_date <= end;
}

function render() {
  tasks.replaceChildren();
  const visible = allTasks.filter(matchesDue);
  status.textContent = `${visible.length}件`;
  if (!visible.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '該当するタスクはありません。';
    tasks.append(empty);
    return;
  }

  for (const task of visible) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'task';
    const title = document.createElement('span');
    title.className = 'task-title';
    title.textContent = task.text;
    const meta = document.createElement('span');
    meta.className = 'task-meta';
    meta.textContent = [task.parent_task, task.label, task.due_date].filter(Boolean).join(' · ');
    button.append(title, meta);
    button.addEventListener('click', async () => {
      button.disabled = true;
      status.textContent = '会話に送信しています…';
      try {
        const result = await app.sendMessage({
          role: 'user',
          content: [{ type: 'text', text: `bizencore のタスクに着手してください。タスクID: ${task.id}\nまず bizencore MCP の work_on_task をこの task_id で呼び、最新情報を読んでください。情報が足りなければ相談し、分かったら同じ会話で作業を続け、検証済みの完了または途中経過を記録してください。` }],
        });
        if (result.isError) throw new Error('このクライアントでは会話へ送信できませんでした。');
        status.textContent = '選んだタスクを会話に送りました。';
      } catch (error) {
        status.textContent = `${error instanceof Error ? error.message : '送信に失敗しました。'} タスクID: ${task.id}`;
        button.disabled = false;
      }
    });
    tasks.append(button);
  }
}

async function load() {
  const currentLoad = ++loadId;
  tasks.replaceChildren();
  status.textContent = '読み込み中…';
  try {
    const found: Task[] = [];
    let offset: number | undefined = 0;
    let labels: string[] = [];
    while (offset !== undefined && found.length < 1000) {
      const result = await app.callServerTool({
        name: 'list_tasks',
        arguments: {
          label: label.value || undefined,
          today: today.checked || undefined,
          query: query.value.trim().slice(0, 200) || undefined,
          include_subtasks: true,
          limit: 100,
          offset,
        },
      });
      if (currentLoad !== loadId) return;
      const page = readPage(result);
      labels = page.labels;
      found.push(...page.tasks);
      offset = page.next_offset;
    }
    const selected = label.value;
    label.replaceChildren(new Option('すべて', ''));
    for (const name of labels) label.add(new Option(name, name));
    label.value = selected;
    allTasks = found;
    render();
    if (offset !== undefined) status.textContent = '件数が多いため、検索を絞ってください。';
  } catch (error) {
    if (currentLoad !== loadId) return;
    status.textContent = error instanceof Error ? error.message : '読み込みに失敗しました。';
  }
}

label.addEventListener('change', load);
today.addEventListener('change', load);
due.addEventListener('change', render);
query.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(load, 250);
});

app.connect().then(load).catch(() => {
  status.textContent = 'ホストに接続できませんでした。';
});
