import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, mkdir } from 'node:fs/promises'
const execute=promisify(execFile),base=`http://127.0.0.1:${Number(process.env.PORT??4317)}`
const run=async args=>JSON.parse((await execute(process.execPath,['scripts/context.mjs',...args,'--json'])).stdout)
const report={startedAt:new Date().toISOString(),checks:[]}
async function check(name,fn){await fn();report.checks.push(name);console.log('PASS '+name)}
const snapshot=await(await fetch(base+'/api/snapshot')).json()
let start
await check('CLI starts a real worktree/version-bound task and returns only 11 top briefs',async()=>{
  start=await run(['start','--title','自动CLI检查：批量渐进披露读取'])
  assert.equal(start.task.client,'cli');assert.equal(start.task.modelRevision,snapshot.revision)
  assert.equal(start.result.directories[0].items.length,11);assert.equal(start.result.contexts.length,0)
})
await check('CLI expands two parent directories in one batch with no per-node model calls',async()=>{
  const result=await run(['query',start.task.id,'--expand','mgrp.execution,mgrp.network,mgrp.execution'])
  assert.equal(result.directories.length,2);assert.equal(result.directories.flatMap(d=>d.items).length,11)
})
await check('one CLI request returns exact bodies, retains inference/source version, and reports partial failure',async()=>{
  const result=await run(['query',start.task.id,'--read','mgrp.execution.task,mgrp.execution.scheduler,mgrp.execution.transfer,mgrp.network,missing'])
  assert.equal(result.contexts.length,4);assert.equal(result.errors.length,1)
  assert.ok(result.contexts.every(body=>body.modelRevision===snapshot.revision&&body.sourceVersion.commit===snapshot.sourceVersion.commit))
  const relation=result.contexts.find(body=>body.id==='mgrp.execution.transfer').relationships.find(r=>r.kind==='inferred')
  assert.equal(relation.metadata.status,'unverified')
  const state=await run(['show',start.task.id]);assert.equal(state.batches.at(-1).status,'partial')
  assert.equal(state.packet.contexts.length,4)
  report.taskId=start.task.id;report.worktreeId=state.worktreeId;report.modelRevision=state.modelRevision
})
await check('CLI stale-revision request fails without altering the prior packet',async()=>{
  await assert.rejects(execute(process.execPath,['scripts/context.mjs','query',start.task.id,'--read','mgrp.base','--revision','invalid-revision']),error=>error.code===1&&/版本/.test(error.stderr))
  assert.equal((await run(['show',start.task.id])).packet.contexts.length,4)
})
await check('HTTP rejects bad task IDs, empty/unsupported query shapes and malformed JSON',async()=>{
  assert.equal((await fetch(base+'/api/context/tasks/invalid')).status,404)
  const url=base+'/api/context/tasks/'+start.task.id+'/query'
  for(const body of ['{}','{"read":["mgrp"],"subtree":true}','{bad-json']){
    assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body})).status,400)
  }
})
await check('Markdown CLI output preserves provenance rather than a fabricated final task answer',async()=>{
  const {stdout}=await execute(process.execPath,['scripts/context.mjs','show',start.task.id])
  assert.ok(stdout.includes('source-inspected'));assert.ok(stdout.includes('unverified'));assert.ok(stdout.includes('inferred'))
  assert.ok(!stdout.includes(snapshot.elements.find(n=>n.id==='mgrp.execution.artifact').description))
})
report.status='passed';report.completedAt=new Date().toISOString()
await mkdir('.harness-local',{recursive:true});await writeFile('.harness-local/context-check.json',JSON.stringify(report,null,2))
