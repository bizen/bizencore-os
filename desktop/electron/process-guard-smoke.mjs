import assert from 'node:assert/strict';
import { spawn, fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createProcessGuard } from './process-guard.mjs';

const workerFile = fileURLToPath(new URL('./process-guard-worker.mjs', import.meta.url));
const self = fileURLToPath(import.meta.url);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const exists = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pids) {
  for (let i = 0; i < 50; i++) {
    if (pids.every(pid => !exists(pid))) return;
    await delay(100);
  }
  assert.fail(`Owned test processes remain: ${pids.filter(exists).join(', ')}`);
}

async function launch() {
  const guard = await createProcessGuard(workerFile);
  const script = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',"process.on('SIGHUP',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});process.on('SIGHUP',()=>{});console.log(JSON.stringify({worker:c.pid}));setInterval(()=>{},1000);`;
  const agent = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  let text = '';
  const worker = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('Test worker did not start')), 5000);
    agent.stdout.on('data', bytes => {
      text += bytes.toString();
      if (text.includes('\n')) { clearTimeout(timeout); resolve(JSON.parse(text).worker); }
    });
    agent.once('error', error => { clearTimeout(timeout); reject(error); });
  });
  await guard.register(agent.pid);
  return { guard, agent, worker };
}

if (process.argv.includes('--owner')) {
  const { agent, worker } = await launch();
  process.send({ agent: agent.pid, worker });
} else {
  const results = [];
  for (const mode of ['stop', 'cli-crash']) {
    const { guard, agent, worker } = await launch();
    try {
      if (mode === 'stop') await guard.stop(agent.pid);
      else agent.kill('SIGKILL');
      await gone([agent.pid, worker]);
      results.push({ mode, retainedProcesses: 0 });
    } finally {
      guard.close();
      for (const pid of [agent.pid, worker]) try { process.kill(pid, 'SIGKILL'); } catch { /* Gone. */ }
    }
  }
  const owner = fork(self, ['--owner'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let identities;
  try {
    identities = (await Promise.race([once(owner, 'message'), delay(8000).then(() => { throw Error('Test owner did not start'); })]))[0];
    owner.kill('SIGKILL');
    await gone([owner.pid, identities.agent, identities.worker]);
    results.push({ mode: 'owner-crash', retainedProcesses: 0 });
    console.log(JSON.stringify({ results, scope: 'Actual macOS processes, including detached workers ignoring SIGHUP; no AI requests or account access.' }, null, 2));
  } finally {
    for (const pid of [owner.pid, identities?.agent, identities?.worker].filter(Boolean)) try { process.kill(pid, 'SIGKILL'); } catch { /* Gone. */ }
  }
}
