import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const mock = `import {useSyncExternalStore} from 'react'; import {getFunctionName} from 'convex/server';
export const useAuth=()=>({userId:'alice'});export const SignedIn=({children})=>children;
export const useQuery=(ref,args)=>{const name=getFunctionName(ref); useSyncExternalStore(cb=>{window.listeners.add(cb);return()=>window.listeners.delete(cb)},()=>window.revision); if(args==='skip')return undefined;return name==='notifications:pending'?window.pending:window.saved;};
export const useMutation=ref=>async args=>{const name=getFunctionName(ref);window.calls.push({name,args});if(window.failSave)throw Error('保存失敗');if(name==='notifications:acknowledge'){if(window.failAck)throw Error('ack retry');window.pending=window.pending.filter(n=>n.id!==args.id);}else window.saved={...window.saved,registered:true,preferences:args.preferences};window.revision++;window.listeners.forEach(cb=>cb());};`;
const { outputFiles } = await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
import {createRoot} from 'react-dom/client';import {NotificationSettings} from './src/components/NotificationSettings';import {TaskNotificationBridge} from './src/components/TaskNotificationBridge';
window.listeners=new Set();window.revision=0;window.calls=[];window.pending=window.desktopMode?[{id:'delivery123',title:'タスク完了',body:'確認する',taskId:'task123'}]:[];
window.saved={preferences:{deadline:false,morning:false,completion:false,morningTime:'09:00'},registered:false,publicKey:'AQ',webPushReady:true};
createRoot(document.getElementById('root')).render(<>{window.desktopMode?<TaskNotificationBridge/>:null}<NotificationSettings/></>);` }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: {'process.env.NODE_ENV':'"production"','import.meta.env.VITE_CONVEX_URL':'"https://fixture.convex.cloud"','import.meta.env.VITE_CLERK_PUBLISHABLE_KEY':'"pk_fixture"'},
plugins:[{name:'mock-auth-and-server',setup(build){build.onResolve({filter:/^(@clerk\/clerk-react|convex\/react)$/},()=>({path:'mock',namespace:'notification-mock'}));build.onLoad({filter:/.*/,namespace:'notification-mock'},()=>({contents:mock,loader:'js',resolveDir:process.cwd()}));}}] });
const browser = await chromium.launch();
try {
 const page = await browser.newPage({viewport:{width:390,height:844}});
 await page.route('https://notification.test/**', route => route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));
 await page.goto('https://notification.test/');
 await page.addStyleTag({content:await readFile('src/index.css','utf8')});
 await page.evaluate(()=>{
  window.permissionRequests=0;window.subscribed=0;window.unsubscribed=0;
  window.Notification={permission:'default',requestPermission:async()=>{window.permissionRequests++;return 'granted'}};
  window.PushManager=function(){};
  const sub={toJSON:()=>({endpoint:'https://web.push.apple.com/test',keys:{p256dh:'a'.repeat(87),auth:'b'.repeat(22)}}),unsubscribe:async()=>{window.unsubscribed++;return true}};
  const registration={pushManager:{getSubscription:async()=>window.subscribed?sub:null,subscribe:async()=>{window.subscribed++;return sub}}};
  Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{register:async()=>registration,ready:Promise.resolve(registration),getRegistration:async()=>registration}});
 });
 await page.addScriptTag({content:outputFiles[0].text});
 assert.equal(await page.getByRole('checkbox',{checked:false}).count(),3);
 assert.equal(await page.evaluate(()=>window.permissionRequests),0,'no unsolicited permission prompt');
 await page.getByRole('checkbox',{name:/朝のToday/}).check();await page.getByLabel('朝の通知時刻').fill('08:30');
 await page.getByRole('button',{name:'この端末に保存'}).click();await page.getByRole('status').filter({hasText:'保存しました'}).waitFor();
 assert.equal(await page.evaluate(()=>window.permissionRequests),1);
 assert.equal(await page.evaluate(()=>window.calls[0].args.preferences.morningTime),'08:30');
 assert.equal(await page.evaluate(()=>window.calls[0].args.platform),'web');
 await page.getByRole('checkbox',{name:/朝のToday/}).uncheck();await page.getByRole('button',{name:'この端末に保存'}).click();
 await page.waitForFunction(()=>window.unsubscribed===1);
 await page.evaluate(()=>{window.Notification.permission='denied';window.Notification.requestPermission=async()=>'denied'});
 await page.getByRole('checkbox',{name:/エージェント/}).check();await page.getByRole('button',{name:'この端末に保存'}).click();
 await page.getByRole('status').filter({hasText:'通知が許可されていません'}).waitFor();
 assert.equal(await page.evaluate(()=>window.calls.length),2,'denial never registers a device');
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 const desktopPage = await browser.newPage();
 await desktopPage.clock.install();
 await desktopPage.route('https://desktop-notification.test/**',route=>route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));
 await desktopPage.goto('https://desktop-notification.test/');
 await desktopPage.evaluate(()=>{window.desktopMode=true;window.failAck=true;window.nativeNotices=[];window.bizencoreDesktop={notifyTask:async value=>{window.nativeNotices.push(value);return true}};});
 await desktopPage.addScriptTag({content:outputFiles[0].text});
 await desktopPage.waitForFunction(()=>window.nativeNotices.length===1&&window.calls.length>=1);
 await desktopPage.evaluate(()=>{window.failAck=false});
 await desktopPage.clock.fastForward(15001);
 await desktopPage.waitForFunction(()=>window.pending.length===0);
 assert.equal(await desktopPage.evaluate(()=>window.nativeNotices.length),1,'failed receipt acknowledgement never duplicates a native popup');
 await desktopPage.close();
 console.log('Notification settings: opt-in, device-scoped save, morning time, mobile subscription, disable/unsubscribe and permission denial verified.');
}finally{await browser.close();}

const handlers={}, shown=[], opened=[];
const worker={location:{origin:'https://app.bizencore.com'},addEventListener:(name,fn)=>{handlers[name]=fn},registration:{showNotification:async(title,options)=>shown.push({title,...options})},clients:{matchAll:async()=>[],openWindow:async url=>opened.push(url)}};
vm.runInNewContext(await readFile('public/notifications-sw.js','utf8'),{self:worker,URL});
const fire=async(name,data)=>{let work;handlers[name]({...data,waitUntil:p=>{work=p}});await work;};
await fire('push',{data:{json:()=>({title:'Today',body:'最初は確認する',tag:'morning:day',path:'/?view=today'})}});
assert.equal(shown[0].body,'最初は確認する');
await fire('push',{data:{json:()=>({title:'evil',body:'evil',tag:'x',path:'https://evil.test/'})}});assert.equal(shown.length,1);
await fire('notificationclick',{notification:{data:{url:'https://app.bizencore.com/?task=abc'},close(){}}});
assert.deepEqual(opened,['https://app.bizencore.com/?task=abc']);
console.log('Service worker: visible notification and same-origin task/Today navigation verified; cross-origin links rejected.');
