import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectContext } from '../src/context-map.ts'
import { layoutMindmap } from '../src/canvas-model.ts'

const object=(id,title)=>({id,title,description:title+' brief',kind:'module',metadata:{source:'source-code',evidence:'e-'+id,path:'src/'+id,status:'source-inspected'}})
const elements=[object('p','Project'),object('p.exec','Execution'),object('p.exec.task','Task'),object('p.exec.scheduler','Scheduler'),object('p.net','Network')]
const relation={id:'r1',source:'p.exec.task',target:'p.net',kind:'inferred',description:'Unverified relation',metadata:{source:'inference',status:'unverified',evidence:'er1'}}
const snapshot={modelStatus:'valid',revision:'r1',elements,relationships:[relation],evidence:[{id:'e-p.exec.task',path:'src/task.h',claim:'Task evidence',startLine:1,endLine:8}],sourceVersion:{branch:'main',commit:'c1'},runtime:{sourceRoot:'test'}}
const body={...elements[2],ancestors:[],relationships:[relation],modelRevision:'r1',sourceVersion:{branch:'main',commit:'c1'},contentHash:'hash',sourceState:{status:'matched',scope:'referenced-evidence-only'}}
const task={id:'task1',title:'task',client:'cli',modelRevision:'r1',worktreeId:'one',disclosedIds:['p.exec','p.net'],batches:[],packet:{contexts:[body]}}
const flatten=items=>items.flatMap(item=>[item,...flatten(item.children)])

test('five information roots exist without inventing reads from the overview',()=>{
  const roots=projectContext(snapshot,null,'p')
  assert.deepEqual(roots.map(n=>n.category),['objects','relations','sources','evidence','versions'])
  assert.ok(flatten(roots).every(n=>!n.hit))
  const layout=layoutMindmap(roots,[])
  assert.equal(layout.nodes.length,5)
  assert.equal(layout.edges.filter(e=>e.kind==='input').length,5)
  assert.equal(layout.edges.filter(e=>e.kind==='output').length,5)
})

test('one returned body lights truthful projections while references and inference retain their scope',()=>{
  const roots=projectContext(snapshot,task,'p'),nodes=flatten(roots)
  assert.ok(roots.every(n=>n.hit),'one response can project into all five categories')
  const exact=nodes.find(n=>n.id==='object:p.exec.task'),parent=nodes.find(n=>n.id==='object:p.exec')
  assert.equal(exact.state,'returned');assert.equal(parent.state,'aggregate')
  assert.equal(nodes.find(n=>n.id==='object:p.net').state,'disclosed','boundary endpoint is not a returned body')
  const inferred=nodes.find(n=>n.kind==='relation'&&n.relation?.id==='r1')
  assert.equal(inferred.hit,true);assert.equal(inferred.relation.metadata.status,'unverified')
  const evidence=nodes.find(n=>n.evidenceId==='e-p.exec.task')
  assert.equal(evidence.state,'reference');assert.equal(evidence.hit,true)
  assert.ok(!nodes.find(n=>n.id==='object:p.exec.scheduler').hit)
})

test('connected mindmap only reveals requested layers and keeps all nodes within one nonoverlapping world',()=>{
  const roots=projectContext(snapshot,task,'p')
  const closed=layoutMindmap(roots,[])
  const opened=layoutMindmap(roots,['category:objects','object:p.exec','category:relations'])
  assert.equal(closed.nodes.length,5)
  assert.ok(opened.nodes.some(n=>n.id==='object:p.exec.task'))
  assert.ok(!opened.nodes.some(n=>n.evidenceId),'unopened evidence branch stays absent')
  assert.ok(opened.edges.some(e=>e.source==='object:p.exec'&&e.target==='object:p.exec.task'))
  const rects=[opened.input,opened.output,...opened.nodes]
  for(let i=0;i<rects.length;i++)for(let j=i+1;j<rects.length;j++){
    const a=rects[i],b=rects[j]
    assert.ok(a.x+a.width<=b.x||b.x+b.width<=a.x||a.y+a.height<=b.y||b.y+b.height<=a.y,`${i} overlaps ${j}`)
  }
  assert.ok(opened.output.x>Math.max(...opened.nodes.map(n=>n.x+n.width)))
})
