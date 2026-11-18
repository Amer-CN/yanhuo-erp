import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../src/db/db';
import { syncNow } from '../src/db/sync';
import { pauseSync, readSyncControl, resumeSync } from '../src/db/syncControl';
import { enqueue } from '../src/db/outbox';
import { makeOrder, resetDb, T0 } from './helpers';
const cfg = { url: 'http://127.0.0.1:54321', anonKey: 'test', ledgerKey: 'generation-test' };
const store = new Map<string,string>();
function gate<T>() { let resolve!: (v:T)=>void; const promise = new Promise<T>(r=>{resolve=r;}); return {promise,resolve}; }
let releases: (()=>void)[];
let runs: Promise<unknown>[];
beforeEach(async()=>{
  await resetDb(); await db.syncMeta.clear(); store.clear(); releases=[]; runs=[];
  vi.stubGlobal('navigator',{onLine:true});
  vi.stubGlobal('localStorage',{getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>store.set(k,String(v)),removeItem:(k:string)=>store.delete(k)});
});
afterEach(async()=>{ releases.forEach(r=>r()); await Promise.allSettled(runs); vi.restoreAllMocks(); vi.unstubAllGlobals(); await resetDb(); await db.syncMeta.clear(); });
it('旧GET在pause、新同步开始之后才返回，不能借用新租约写账或推进水位',async()=>{
  const entered=gate<void>(), release=gate<void>(), secondEntered=gate<void>(), secondRelease=gate<void>();
  releases.push(()=>release.resolve(),()=>secondRelease.resolve()); let gets=0;
  vi.stubGlobal('fetch',vi.fn(async(_url:string,init?:RequestInit)=>{
    if (String(_url).includes('/rpc/yh_sync_capabilities')) return Response.json({ code: 'PGRST202' }, { status: 404 });
    if (init?.method==='POST') return new Response(null,{status:201});
    gets++;
    if(gets===1){ entered.resolve(); await release.promise; return Response.json([{id:'order:stale',record_id:'stale',kind:'order',data:makeOrder('stale',1000),updated_at:1000,deleted:false}]); }
    if(gets===2){ secondEntered.resolve(); await secondRelease.promise; }
    return Response.json([]);
  }));
  const old=syncNow(cfg); void old.catch(()=>{}); runs.push(old); await entered.promise;
  const paused=await pauseSync('restore'); await resumeSync(paused.generation);
  const newer=syncNow(cfg); void newer.catch(()=>{}); runs.push(newer); await secondEntered.promise;
  release.resolve(); await expect(old).rejects.toThrow(/失效|lease/i);
  expect(await db.orders.get('stale')).toBeUndefined(); expect(store.get('yh-sync-last-pull')).toBeUndefined();
  secondRelease.resolve(); await newer;
  expect((await readSyncControl()).paused).toBe(false);
});
it('pause使扣住的POST确认失效，队列不会被迟到ACK清除',async()=>{
  await db.orders.put(makeOrder('x',1000,'s1',{updatedAt:T0})); await enqueue('order','x');
  const entered=gate<void>(),release=gate<void>(); releases.push(()=>release.resolve());
  vi.stubGlobal('fetch',vi.fn(async(_url:string,init?:RequestInit)=>{
    if (String(_url).includes('/rpc/yh_sync_capabilities')) return Response.json({ code: 'PGRST202' }, { status: 404 });
    if(init?.method==='POST'){ entered.resolve(); await release.promise; return new Response(null,{status:201}); }
    return Response.json([]);
  }));
  const pending=syncNow(cfg); void pending.catch(()=>{}); runs.push(pending); await entered.promise;
  await pauseSync('restore'); release.resolve(); await expect(pending).rejects.toThrow(/失效|lease/i);
  expect(await db.outbox.get('order:x')).toBeTruthy(); expect(store.get('yh-sync-last-sync')).toBeUndefined();
});
