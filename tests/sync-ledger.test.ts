import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { db } from '../src/db/db';
import { syncNow, clearCloud } from '../src/db/sync';
import { readSyncControl } from '../src/db/syncControl';
import { enqueue } from '../src/db/outbox';
import { makeOrder, resetDb } from './helpers';
const cfg={url:'http://127.0.0.1:54321',anonKey:'test',ledgerKey:'protocol-only'};
const store=new Map<string,string>(); let epoch:number; let posts: {url:string;body:Record<string,unknown>[];headers:Headers}[];
function caps(){return {protocolVersion:2,conflictTarget:'ledger,id',ledgerScoped:true,clearRpcEnabled:true,clearEpoch:epoch,epochHeader:'x-yh-clear-epoch',epochHeaderRequired:epoch>0};}
beforeEach(async()=>{await resetDb(); await db.syncMeta.clear();store.clear();epoch=0;posts=[];
vi.stubGlobal('navigator',{onLine:true});vi.stubGlobal('localStorage',{getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>store.set(k,String(v)),removeItem:(k:string)=>store.delete(k)});
vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
 if(String(url).includes('/rpc/yh_sync_capabilities'))return Response.json(caps());
 if(String(url).includes('/rpc/yh_clear_ledger')){const op=JSON.parse(String(init?.body));return Response.json({operationId:op.p_operation_id,clearedAt:2000,clearedCount:1,clearEpoch:2000});}
 if(init?.method==='POST'){posts.push({url:String(url),body:JSON.parse(String(init.body)),headers:new Headers(init.headers)});return new Response(null,{status:201});}
 return Response.json([]);
}));});
afterEach(async()=>{vi.unstubAllGlobals();await resetDb();await db.syncMeta.clear();});
it('v2常规同步使用复合冲突键并发送已观察的epoch',async()=>{
 await db.orders.put(makeOrder('x',1000));await enqueue('order','x'); await syncNow(cfg);
 expect(posts).toHaveLength(1);expect(new URL(posts[0].url).searchParams.get('on_conflict')).toBe('ledger,id');
 expect(posts[0].headers.get('x-yh-clear-epoch')).toBe('0');expect(posts[0].body[0].clear_epoch).toBe(0);
});
it('远端清空换代且本地有旧队列时暂停，保留队列和本地数据，不自动换epoch发送',async()=>{
 await syncNow(cfg); await db.orders.put(makeOrder('old',1000));await enqueue('order','old');epoch=2000;
 await expect(syncNow(cfg)).rejects.toThrow(/清空|代际|核对|epoch/);
 expect(posts).toHaveLength(0);expect(await db.outbox.get('order:old')).toBeTruthy();expect(await db.orders.get('old')).toBeTruthy();
 expect((await readSyncControl()).paused).toBe(true);
});
it('clearCloud仅发单个幂等RPC而不发PATCH或业务标记POST',async()=>{
 const receipt=await clearCloud(cfg);
 expect(receipt).toMatchObject({clearEpoch:2000,clearedCount:1});
 const mock=vi.mocked(fetch);expect(mock.mock.calls.some(([,init])=>init?.method==='PATCH')).toBe(false);
 expect(posts).toHaveLength(0);expect((await readSyncControl()).paused).toBe(true);
});
