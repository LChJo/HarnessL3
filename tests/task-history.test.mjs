import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContextReader } from '../server/context-reader.mjs'

const DAY=86400000
const node=(id,title)=>({id,title,description:title+' old description',kind:'module',metadata:{source:'source-code',evidence:'e-'+id,path:'src/'+id,status:'source-inspected'}})
const makeSnapshot=()=>({modelStatus:'valid',revision:'r1',elements:[node('p','Project'),node('p.a','A'),node('p.a.x','X'),node('p.b','B')],relationships:[],source:{status:'matched',evidence:[]},sourceVersion:{branch:'main',commit:'c1'},data:{views:{index:{id:'index',title:'Old diagram',bounds:{x:0,y:0,width:100,height:100},nodes:[],edges:[]}}}})
async function setup(){let now=Date.parse('2026-01-01T12:00:00Z'),snapshot=makeSnapshot();const dir=await mkdtemp(join(tmpdir(),'harness-history-'));const opts={getSnapshot:()=>snapshot,stateDir:dir,worktreeId:'one',projectId:'p',sourceRoot:'source',now:()=>new Date(now)};return{dir,opts,reader:await createContextReader(opts),advance:days=>{now+=days*DAY},setSnapshot:value=>{snapshot=value}}}

test('60-day history is based on recorded activity, viewing never renews it, and expired files are preserved',async()=>{
  const h=await setup(),{task}=await h.reader.startTask({title:'retention',client:'test'})
  const before=(await h.reader.getTask(task.id)).updatedAt
  h.advance(60)
  assert.equal(h.reader.history().total,1,'exactly 60 days remains available')
  await h.reader.getTask(task.id);assert.equal((await h.reader.getTask(task.id)).updatedAt,before)
  h.advance(1/DAY)
  assert.equal(h.reader.history().total,0)
  const archived=await h.reader.getTask(task.id);assert.equal(archived.history.expired,true)
  await assert.rejects(h.reader.query(task.id,{read:['p.a']}),/60|过期/)
  assert.ok(await readFile(join(h.dir,'context-tasks',task.id+'.json'),'utf8'))
})

test('search and pagination make every retained task reachable beyond the old 50-task cap',async()=>{
  const h=await setup();await Promise.all(Array.from({length:55},(_,i)=>h.reader.startTask({title:'History '+i,client:'test'})))
  const first=h.reader.history({limit:20}),second=h.reader.history({offset:20,limit:20}),third=h.reader.history({offset:40,limit:20})
  assert.equal(first.total,55);assert.equal(new Set([...first.tasks,...second.tasks,...third.tasks].map(t=>t.id)).size,55)
  assert.equal(h.reader.history({query:'History 54'}).total,1)
  assert.equal(h.reader.history({from:'2026-01-02'}).total,0)
  assert.throws(()=>h.reader.history({limit:0}),/limit|分页/)
})

test('historical context and C4 are immutable and survive restart/model changes without future objects',async()=>{
  const h=await setup(),{task}=await h.reader.startTask({title:'frozen',client:'test'})
  await h.reader.query(task.id,{expand:['p.a'],read:['p.a.x']})
  const prior=await h.reader.getTaskSnapshot(task.id)
  h.setSnapshot({...makeSnapshot(),revision:'r2',elements:[node('p','New project'),node('p.future','FUTURE SECRET')],data:{views:{index:{id:'index',title:'Future diagram'}}}})
  const restarted=await createContextReader(h.opts),after=await restarted.getTaskSnapshot(task.id)
  assert.equal((await restarted.getTask(task.id)).outdated,true)
  assert.equal(after.snapshot.revision,'r1');assert.deepEqual(after.snapshot,prior.snapshot)
  assert.equal(after.snapshot.c4Views[0].title,'Old diagram')
  assert.ok(!JSON.stringify(after).includes('FUTURE SECRET'))
})

test('batch history reconstructs cumulative output at that point without later contexts',async()=>{
  const h=await setup(),{task,result}=await h.reader.startTask({title:'timeline',client:'test'})
  const a=await h.reader.query(task.id,{read:['p.a.x']}),b=await h.reader.query(task.id,{read:['p.b']})
  assert.equal((await h.reader.getTask(task.id,{batchId:result.batchId})).packet.contexts.length,0)
  assert.deepEqual((await h.reader.getTask(task.id,{batchId:a.batchId})).packet.contexts.map(n=>n.id),['p.a.x'])
  assert.equal((await h.reader.getTask(task.id,{batchId:b.batchId})).packet.contexts.length,2)
  assert.equal((await h.reader.getTask(task.id)).batches.length,3)
  await assert.rejects(h.reader.getTask(task.id,{batchId:'unknown'}),/批次/)
})

test('legacy tasks without archives disclose partial coverage rather than borrowing the current model',async()=>{
  const h=await setup(),{task}=await h.reader.startTask({title:'legacy',client:'test'});await h.reader.query(task.id,{read:['p.a.x']})
  const path=join(h.dir,'context-tasks',task.id+'.json'),record=JSON.parse(await readFile(path,'utf8'))
  delete record.initialSnapshotId;for(const batch of record.batches){delete batch.snapshotId;if(batch.result)delete batch.result.snapshotId}
  await writeFile(path,JSON.stringify(record));h.setSnapshot({...makeSnapshot(),revision:'r2',elements:[node('p.future','FUTURE SECRET')]})
  const restarted=await createContextReader(h.opts),restored=await restarted.getTaskSnapshot(task.id)
  assert.equal(restored.status,'partial');assert.equal(restored.snapshot.c4Views.length,0)
  assert.ok(!JSON.stringify(restored).includes('FUTURE SECRET'));assert.ok(restored.snapshot.elements.some(n=>n.id==='p.a.x'))
})
