// Standalone settings preview: actual components, sample account, no backend or native actions.
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const directory = process.argv[2];
if (!directory) throw Error('Pass a temporary output directory.');
const { outputFiles } = await build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { SettingsPanel } from './src/components/SettingsPanel';
    import { applyTheme } from './src/lib/theme';
    window.bizencoreDesktop = { notifyTask: async () => false };
    window.fixture = { calls: [], timeZone: {timeZone:'Australia/Melbourne', automatic:true}, preferences:{deadline:false,morning:false,morningTime:'09:00',completion:false}, revision:0, listeners:new Set() };
    window.fixtureNotify = () => {window.fixture.revision++;window.fixture.listeners.forEach(fn=>fn());};
    applyTheme('black');
    function Fixture() {
      const [open,setOpen]=useState(false),[theme,setTheme]=useState('black');
      return <><button id="open-settings" onClick={()=>setOpen(true)}>設定を開く</button>
        {open?<SettingsPanel onClose={()=>setOpen(false)} theme={theme} onThemeChange={next=>{setTheme(next);applyTheme(next);}}/>:null}</>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  ` },
  bundle: true, write: false, format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': JSON.stringify({ VITE_CONVEX_URL: 'https://fixture.convex.cloud', VITE_CLERK_PUBLISHABLE_KEY: 'fixture' }) },
  plugins: [{ name: 'settings-fixture', setup(builder) {
    builder.onResolve({ filter: /^(@clerk\/clerk-react|convex\/react)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'jsx', resolveDir: process.cwd(), contents: args.path === 'convex/react' ? `
      import { useSyncExternalStore } from 'react';
      import { getFunctionName } from 'convex/server';
      export function useQuery(ref,args) {
        useSyncExternalStore(fn=>{window.fixture.listeners.add(fn);return()=>window.fixture.listeners.delete(fn);},()=>window.fixture.revision);
        const name=getFunctionName(ref); if(args==='skip')return undefined;
        if(name==='sync:getTimeZone')return window.fixture.timeZone;
        if(name==='notifications:state')return {preferences:window.fixture.preferences,webPushReady:false};
        if(name==='partners:state')return {accountId:'fixture-user',partner:null,labels:[],sharedLabelIds:[],invite:null};
        if(name==='accountDeletion:status')return {userId:'fixture-user',phase:'active',available:true};
        if(name==='sync:listMcpConnections')return [{clientId:'desktop-codex',clientName:'Codex',lastUsedAt:1792800000000},{clientId:'https://claude.ai/oauth/mcp-oauth-client-metadata',lastUsedAt:1792790000000}];
        return null;
      }
      export function useMutation(ref){return async args=>{
        const name=getFunctionName(ref);window.fixture.calls.push({name,args});
        if(name==='sync:setTimeZone')window.fixture.timeZone=args;
        if(name==='notifications:save')window.fixture.preferences=args.preferences;
        if(name==='partners:createInvite')throw Error('Preview does not create invitations');
        window.fixtureNotify();
      };}
      export function useAction(){return async()=>{throw Error('Preview never deletes accounts');};}
    ` : `
      export const useAuth=()=>({isSignedIn:true,userId:'fixture-user'});
      export const SignedIn=({children})=>children;
      export const SignedOut=()=>null;
      export const SignInButton=({children})=>children;
    ` }));
  } }],
});
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'app.js'), outputFiles[0].text);
await writeFile(path.join(directory, 'app.css'), await readFile('src/index.css'));
await writeFile(path.join(directory, 'index.html'), '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Terminal settings — isolated preview</title><link rel="stylesheet" href="app.css"></head><body><div id="root"></div><script src="app.js"></script></body></html>');
await writeFile(path.join(directory, 'mobile.html'), '<!doctype html><html><head><meta charset="utf-8"><title>Settings mobile preview</title><style>body{margin:0;background:#ddd}iframe{display:block;width:390px;height:100vh;border:0;margin:auto}</style></head><body><iframe src="index.html" title="390px設定プレビュー"></iframe></body></html>');
console.log(`Built isolated settings preview: ${directory}`);
