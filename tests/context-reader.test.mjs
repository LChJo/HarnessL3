import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContextReader } from '../server/context-reader.mjs'

const node=(id,title,description)=>({id,title,description,kind:'module',metadata:{source:'source-code',evidence:'e-'+id,path:'src/'+id,status:'source-inspected'}})
const elements=[node('p','Project','ROOT BODY'),node('p.a','A','A brief'),node('p.b','B','B brief'),node('p.a.x','X','X BODY'),node('p.a.y','Y','SECRET SIBLING BODY'),node('p.b.z','Z','Z BODY')]
const snapshot=()=>({modelStatus:'valid',revision:'r1',elements,relationships:[{id:'r',source:'p.a.x',target:'p.a.y',kind:'calls',description:'boundary only',metadata:{evidence:'er'}}]})
async function setup(worktreeId='one',dir){return createContextReader({getSnapshot:snapshot,stateDir:dir??await mkdtemp(join(tmpdir(),'harness-context-')),worktreeId,projectId:'p'})}

test('batch expands several directories and reads only exact selected objects, de-duplicated',async()=>{
  const reader=await setup(),start=await reader.startTask({title:'look up',client:'test'})
  assert.equal(start.result.directories[0].items.length,2)
  assert.ok(!JSON.stringify(start.result).includes('X BODY'))
  const result=await reader.query(start.task.id,{expand:['p.a','p.b','p.a'],read:['p.a.x','p.b','p.a.x']})
  assert.equal(result.directories.length,2)
  assert.deepEqual(result.contexts.map(c=>c.id),['p.a.x','p.b'])
  assert.ok(!JSON.stringify(result.contexts).includes('SECRET SIBLING BODY'),'explicitly requested child briefs are separate from selected bodies')
  assert.equal(result.contexts[0].relationships[0].target,'p.a.y')
  assert.equal(result.contexts[0].metadata.evidence,'e-p.a.x')
  const state=await reader.getTask(start.task.id)
  assert.equal(state.packet.contexts.length,2)
  assert.equal(state.batches.at(-1).status,'complete')
})
test('unknown targets remain per-item errors; no known hash can silently erase a first body',async()=>{
  const reader=await setup(),{task}=await reader.startTask({title:'partial',client:'test'})
  const result=await reader.query(task.id,{read:['missing','p.a.x']})
  assert.equal(result.errors.length,1);assert.equal(result.contexts.length,1)
  assert.equal((await reader.getTask(task.id)).batches.at(-1).status,'partial')
  const hash=result.contexts[0].contentHash
  const next=await reader.query(task.id,{read:['p.a.x'],known:{'p.a.x':hash}})
  assert.equal(next.contexts.length,0);assert.equal(next.unchanged.length,1)
  const fresh=await reader.startTask({title:'new task',client:'test'})
  const first=await reader.query(fresh.task.id,{read:['p.a.x'],known:{'p.a.x':hash}})
  assert.equal(first.contexts.length,1,'only task-retained content can be omitted')
})
test('task binds worktree/model revision and persists result before reporting completion',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'harness-context-')),reader=await setup('one',dir)
  const {task}=await reader.startTask({title:'saved',client:'test'})
  await reader.query(task.id,{read:['p.a.x']})
  const restored=await setup('one',dir)
  assert.equal((await restored.getTask(task.id)).packet.contexts[0].description,'X BODY')
  const other=await setup('other',dir)
  await assert.rejects(other.getTask(task.id),/worktree|工作区/)
  const stale=await createContextReader({getSnapshot:()=>({...snapshot(),revision:'r2'}),stateDir:dir,worktreeId:'one',projectId:'p'})
  await assert.rejects(stale.query(task.id,{read:['p.b']}),/revision|快照|版本/)
  assert.equal((await stale.getTask(task.id)).packet.contexts.length,1)
})
test('parallel requests merge their independently completed packets and publish actual states',async()=>{
  const reader=await setup(),updates=[];reader.onChange(e=>updates.push(e))
  const {task}=await reader.startTask({title:'parallel',client:'test'})
  await Promise.all([reader.query(task.id,{read:['p.a.x']}),reader.query(task.id,{read:['p.b.z']})])
  const state=await reader.getTask(task.id)
  assert.deepEqual(state.packet.contexts.map(n=>n.id).sort(),['p.a.x','p.b.z'])
  assert.ok(updates.some(e=>e.phase==='requested'))
  assert.ok(updates.some(e=>e.phase==='completed'))
})
test('caller provenance is per batch and interrupted reads resume as unknown, not returned bodies',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'harness-context-')),reader=await setup('one',dir)
  const updates=[];reader.onChange(event=>updates.push(event))
  const {task}=await reader.startTask({title:'restart',client:'web'})
  await reader.query(task.id,{read:['p.a.x']},'cli')
  const state=await reader.getTask(task.id)
  assert.deepEqual(state.clients,['web','cli'])
  assert.equal(updates.at(-1).client,'cli','live event must identify this caller rather than the task creator')
  const file=join(dir,'context-tasks',task.id+'.json'),record=JSON.parse(await readFile(file,'utf8'))
  record.batches.push({id:'interrupted',status:'requested',request:{expand:[],read:['p.b.z']},client:'cli'})
  await writeFile(file,JSON.stringify(record))
  const restored=await setup('one',dir),after=await restored.getTask(task.id)
  assert.equal(after.batches.at(-1).status,'unknown')
  assert.deepEqual(after.packet.contexts.map(c=>c.id),['p.a.x'])
  await assert.rejects(restored.query(task.id,{read:['p.a.x'],subtree:true}),/支持/)
})
test('derived cache invalidates on evidence freshness changes without falsely claiming the prior source state',async()=>{
  let sourceStatus='matched'
  const reader=await createContextReader({getSnapshot:()=>({...snapshot(),source:{status:sourceStatus}}),stateDir:await mkdtemp(join(tmpdir(),'harness-context-')),worktreeId:'one',projectId:'p'})
  const {task}=await reader.startTask({title:'freshness',client:'test'})
  const first=await reader.query(task.id,{read:['p.a.x']})
  sourceStatus='changed'
  const next=await reader.query(task.id,{read:['p.a.x'],known:{'p.a.x':first.contexts[0].contentHash}})
  assert.equal(next.contexts.length,1)
  assert.equal(next.contexts[0].sourceState.status,'changed')
  assert.notEqual(first.contexts[0].contentHash,next.contexts[0].contentHash)
  // Change freshness while the first request is yielding to persistence and launch another read.
  sourceStatus='matched'
  let concurrent
  const stop=reader.onChange(event=>{
    if(event.phase==='requested'&&!concurrent){sourceStatus='changed';concurrent=reader.query(task.id,{read:['p.a.x']})}
  })
  const prior=await reader.query(task.id,{read:['p.a.x']})
  const later=await concurrent;stop()
  assert.equal(prior.contexts[0].sourceState.status,'matched')
  assert.equal(later.contexts[0].sourceState.status,'changed','interleaved requests must each use their captured snapshot cache')
})
