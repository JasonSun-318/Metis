import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { build } from 'esbuild';
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = await mkdtemp(join(tmpdir(), 'metis-schedules-'));
const bundle = join(directory, 'fixture.js');
await build({ stdin: { resolveDir: desktop, loader: 'tsx', contents: String.raw`
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ScheduledTasksPanel } from './src/renderer/components/ScheduledTasksPanel.tsx';
import { ScheduleStore } from './src/renderer/store/schedule-store.ts';
import { setLocale } from './src/renderer/i18n.ts';
await setLocale('zh-CN');
const tasks = ['每日项目简报', '检查依赖与安全更新', '整理本周研发进展及下一阶段项目交付安排', '每月工作总结'].map((name, i) => ({
 id: 'task-'+i, name, description: ['汇总代码变更、待处理事项与关键进展。', '检查依赖更新，整理需要关注的兼容性问题。', '整理本周研发进展、重要决定以及下周需要推进的事项。', ''][i],
 instruction: '阅读项目最近的变更记录，整理已完成事项和仍需处理的问题。\n\n请按以下顺序输出：\n1. 今日关键进展\n2. 待处理的问题与风险\n3. 下一步建议\n\n报告使用简洁的中文，附上相关文件的位置。',
 model: { provider: 'openai', modelId: 'project-review-model-with-a-long-identifier' }, schedule: { kind: 'daily', time: '09:00' }, timezone: 'Asia/Shanghai',
 target: { kind: 'general', workspace: 'fixed', cwd: '/Users/jason/Projects/Metis/very-long-project-directory-for-responsive-layout' },
 status: i === 1 ? 'paused' : i === 3 ? 'completed' : 'active', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-09T01:00:00Z',
 nextRunAt: i === 1 || i === 3 ? null : '2026-09-10T01:00:00Z', unreadCount: i === 0 ? 2 : 0,
 lastRun: { id: 'run-'+i, status: i === 1 ? 'failed' : 'succeeded' }
}));
const runs = ['succeeded','failed','succeeded'].map((status,i) => ({ id:'run-'+i, taskId:'task-0', status, trigger:'scheduled', createdAt:'2026-09-0'+(9-i)+'T01:00:00Z', completedAt:'2026-09-0'+(9-i)+'T01:03:00Z', unread:i===0, sessionId:'session-'+i, resultPreview:i===1?'网络连接中断，请稍后重试。':'已整理项目变更与待处理事项。' }));
const store=new ScheduleStore();
store.applySnapshot({serverEpoch:'test', tasks, unreadCount:2, cursor:0});
window.calls=[];
const current=()=>store.getSnapshot().tasksById.get('task-0');
const api={
 listModels:async()=>({models:[{provider:'openai',modelId:tasks[0].model.modelId,name:'Project model'}]}),
 listSchedules:async({query})=>({tasks:[...store.getSnapshot().tasksById.values()].filter(t=>!query||t.name.includes(query)),nextAfterTaskId:null,unreadCount:2}),
 listScheduleRuns:async()=>({runs,nextBeforeRunId:null}),
 getScheduleRun:async({runId})=>({run:runs.find(r=>r.id===runId)}), markScheduleRunRead:async()=>{window.calls.push('read');return{}},
 pauseSchedule:async()=>{window.calls.push('pause');return{task:{...current(),status:'paused'}}},
 resumeSchedule:async()=>{window.calls.push('resume');return{task:{...current(),status:'active'}}},
 runScheduleNow:async()=>{window.calls.push('run');return{run:runs[0]}},getSchedule:async()=>({task:current()}),
 setScheduleKeepAwake:async()=>{},
};
function Fixture(){const [selected,setSelected]=useState(null);return <ScheduledTasksPanel api={api} onCreateWithMetis={async()=>{}} onOpenSession={id=>window.calls.push(id)} onSelectTask={setSelected} selectedTaskId={selected} serverReady sessions={[]} store={store}/>;}
window.setLocale=setLocale;
createRoot(document.getElementById('root')).render(<Fixture/>);
` }, outfile:bundle, bundle:true, format:'esm', platform:'browser', jsx:'automatic', loader:{'.svg':'dataurl'}, logLevel:'silent' });
const server=createServer(async(req,res)=>{
 const files={'/fixture.js':[bundle,'text/javascript'],'/app.css':[join(desktop,'src/renderer/styles/app.css'),'text/css'],'/tokens.css':[join(desktop,'src/renderer/styles/tokens.css'),'text/css']};
 const file=files[req.url];
 if(file){res.setHeader('Content-Type',file[1]);res.end(await readFile(file[0]));return;}
 res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><link rel="stylesheet" href="/tokens.css"><link rel="stylesheet" href="/app.css"><style>body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui}#root{height:100vh;display:flex;min-width:0}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({channel:process.env.PREVIEW_BROWSER_CHANNEL||'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1100,height:800},deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto('http://127.0.0.1:'+server.address().port);
 await expect(page.locator('.scheduled-task-card')).toHaveCount(4);
 await page.screenshot({path:join(directory,'01-cards-dark.png')});
 await page.locator('.scheduled-task-card').first().click();
 await expect(page.locator('.scheduled-task-history button')).toHaveCount(3);
 await page.screenshot({path:join(directory,'02-detail-dark.png')});
 for(const width of [760,460]){
  await page.setViewportSize({width,height:800});
  await page.locator('.scheduled-task-detail').evaluate(el=>{el.scrollTop=0});
  await page.screenshot({path:join(directory,'03-detail-'+width+'.png')});
  if(!process.env.SCHEDULE_BASELINE) {
   assert.ok(await page.locator('.scheduled-task-detail').evaluate(el=>el.scrollWidth<=el.clientWidth), 'Detail must not overflow at '+width);
   const header=await page.locator('.scheduled-task-detail > header').boundingBox();
   assert.ok(header.height<230, 'Narrow header must not grow an empty flex-basis gap');
  }
 }
 await page.setViewportSize({width:1100,height:800});
 await page.evaluate(()=>document.documentElement.dataset.theme='light');
 await page.screenshot({path:join(directory,'04-detail-light.png')});
 if(!process.env.SCHEDULE_BASELINE){
  await page.locator('.scheduled-task-permissions summary').click();
  await expect(page.locator('.scheduled-task-permissions p')).toBeVisible();
  await page.locator('.scheduled-task-permissions summary').click();
 }
 await page.locator('.scheduled-task-status-line [role="switch"]').click();
 await expect.poll(()=>page.evaluate(()=>window.calls.includes('pause'))).toBe(true);
 await page.locator('.scheduled-task-status-line [role="switch"]').click();
 await expect.poll(()=>page.evaluate(()=>window.calls.includes('resume'))).toBe(true);
 await page.locator('.scheduled-task-run-now').click();
 await expect.poll(()=>page.evaluate(()=>window.calls.includes('run'))).toBe(true);
 await page.locator('.scheduled-task-history button').first().click();
 await expect.poll(()=>page.evaluate(()=>window.calls.includes('session-0')&&window.calls.includes('read'))).toBe(true);
 await page.getByRole('button',{name:'Edit task',exact:true}).or(page.getByRole('button',{name:'编辑任务',exact:true})).click();
 await expect(page.locator('.scheduled-task-dialog')).toBeVisible();
 await page.keyboard.press('Escape');
 await expect(page.locator('.scheduled-task-dialog')).not.toBeVisible();
 await page.getByRole('button',{name:'Delete task',exact:true}).or(page.getByRole('button',{name:'删除任务',exact:true})).click();
 await expect(page.locator('.scheduled-task-delete-dialog')).toBeVisible();
 await page.keyboard.press('Escape');
 await page.locator('.scheduled-task-breadcrumb button').click();
 await expect(page.locator('.scheduled-task-card')).toHaveCount(4);
 await page.setViewportSize({width:460,height:800});
 await page.screenshot({path:join(directory,'05-cards-narrow-light.png')});
 if(!process.env.SCHEDULE_BASELINE) assert.ok(await page.locator('.scheduled-tasks-panel').evaluate(el=>el.scrollWidth<=el.clientWidth),'Cards must not overflow');
 assert.deepEqual(errors,[]);
 console.log('PASS cards → detail → pause/resume → run → history → edit/delete dialogs → back; dark/light, 1100/760/460px');
}finally{console.log('Screenshots:',directory);await browser.close();await new Promise(resolve=>server.close(resolve));}
