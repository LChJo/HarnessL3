import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { expect } from 'playwright/test'

const base=`http://127.0.0.1:${Number(process.env.PORT??4317)}`,output='.harness-local/context-browser'
await mkdir(output,{recursive:true})
const report={startedAt:new Date().toISOString(),checks:[],errors:[],screenshots:[]}
const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL??'msedge',headless:true})
const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'})
await context.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():route.abort())
const page=await context.newPage();let expectedFailure=false
page.on('pageerror',error=>report.errors.push(String(error)))
page.on('console',message=>{if(message.type()==='error'&&!expectedFailure)report.errors.push(message.text())})
const initial=await(await context.request.get(base+'/api/snapshot')).json()
const selector=()=>page.getByRole('combobox',{name:'当前检索任务'})
const getTask=async()=>{const id=await selector().inputValue();return(await context.request.get(base+'/api/context/tasks/'+id)).json()}
const model=id=>page.locator(`[data-model-id="${id}"]`)
const batch=()=>page.getByRole('button',{name:'批量获取',exact:true})
const chooseBody=title=>page.getByRole('button',{name:`选择${title}正文`,exact:true})
async function check(name,fn){await fn();report.checks.push(name);console.log('PASS '+name)}
async function shot(name){const path=`${output}/${name}.png`;await page.screenshot({path});report.screenshots.push(path)}
async function camera(){return page.locator('.world').evaluate(el=>({x:Number(el.dataset.cameraX),y:Number(el.dataset.cameraY),scale:Number(el.dataset.cameraScale)}))}
try{
  await page.goto(base)
  await check('new root shows actual model and retrieval endpoints without fixed stages or old links',async()=>{
    await expect(page.locator('.model-node:not(.child-node)')).toHaveCount(11)
    await expect(page.locator('.input-card')).toBeVisible();await expect(page.locator('.output-card')).toBeVisible()
    await expect(page.locator('.journey-station,.playback-dock,a')).toHaveCount(0)
    assert.ok((await camera()).scale>=.9)
    await shot('01-current-context')
  })
  await check('start task returns only top-level briefs, records worktree and source',async()=>{
    await selector().selectOption('')
    await page.getByRole('textbox',{name:'任务目的'}).fill('自动浏览器检查：批量检索执行状态与网络边界')
    await page.getByRole('button',{name:'开始检索',exact:true}).click()
    await expect(selector()).not.toHaveValue('')
    const state=await getTask();assert.equal(state.batches.length,1);assert.equal(state.disclosedIds.length,11);assert.equal(state.packet.contexts.length,0)
    assert.equal(state.client,'web');assert.ok(state.worktreeId)
    await expect(page.locator('.origin-label')).toContainText('网页手动选择')
    await page.getByRole('button',{name:'概览全部内容'}).click()
    await shot('02-briefs')
  })
  await check('multiple branches browse independently without implying a read or requesting a batch',async()=>{
    const before=await model('mgrp.business').boundingBox()
    await page.getByRole('button',{name:'展开任务执行',exact:true}).click()
    await page.getByRole('button',{name:'展开网络与平台后端',exact:true}).click()
    await expect(page.locator('.child-node')).toHaveCount(11)
    assert.equal((await getTask()).batches.length,1)
    await expect(model('mgrp.execution.task')).not.toHaveClass(/body-returned/)
    assert.deepEqual(await model('mgrp.business').boundingBox(),before)
    await shot('03-browsing')
  })
  await check('one mixed request expands two directories and reads one parent without all descendants',async()=>{
    await page.getByRole('button',{name:'选择任务执行子层目录',exact:true}).click()
    await page.getByRole('button',{name:'选择网络与平台后端子层目录',exact:true}).click()
    await chooseBody('网络与平台后端').click();await batch().click()
    await expect(page.locator('.output-card')).toHaveAttribute('data-output-count','1')
    const state=await getTask(),last=state.batches.at(-1)
    assert.equal(last.request.expand.length,2);assert.equal(last.request.read.length,1)
    assert.equal(last.result.directories.length,2);assert.equal(last.result.contexts.length,1)
    assert.equal(state.disclosedIds.length,22)
    await expect(model('mgrp.network')).toHaveClass(/body-returned/)
    await expect(model('mgrp.network.manager')).not.toHaveClass(/body-returned/)
    await shot('04-mixed-batch')
  })
  await check('one batch returns three exact child bodies and aggregates a four-item context packet',async()=>{
    for(const title of ['TaskManager','TaskScheduler','ResourceTransferCoordinator'])await chooseBody(title).click()
    await batch().click();await expect(page.locator('.output-card')).toHaveAttribute('data-output-count','4')
    const state=await getTask();assert.equal(state.batches.at(-1).request.read.length,3)
    assert.deepEqual(state.packet.contexts.map(n=>n.id).sort(),['mgrp.network','mgrp.execution.task','mgrp.execution.scheduler','mgrp.execution.transfer'].sort())
    await expect(model('mgrp.execution')).not.toHaveClass(/body-returned/)
    await expect(model('mgrp.execution')).toContainText('含 3 项正文')
    await expect(model('mgrp.execution.artifact')).not.toHaveClass(/body-returned/)
    await shot('05-context-returned')
  })
  await check('context packet preserves evidence/inference and contains no unselected body; copy uses exact packet',async()=>{
    await page.getByRole('button',{name:'查看上下文包',exact:true}).click()
    const text=await page.getByRole('textbox',{name:'上下文包原文'}).inputValue()
    assert.ok(text.includes('mgrp.execution.transfer'));assert.ok(text.includes('inferred'));assert.ok(text.includes('unverified'))
    assert.ok(!text.includes(initial.elements.find(n=>n.id==='mgrp.execution.artifact').description))
    assert.ok(!text.includes(initial.elements.find(n=>n.id==='mgrp.network.manager').description))
    await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copiedContext=text}}}))
    await page.getByRole('button',{name:'复制上下文包',exact:true}).click()
    assert.equal(await page.evaluate(()=>window.__copiedContext),text)
    await shot('06-packet');await page.keyboard.press('Escape')
  })
  await check('context detail opens actual source evidence without changing selected bodies',async()=>{
    await page.getByRole('button',{name:'TaskScheduler详情',exact:true}).click()
    await expect(page.getByRole('dialog')).toContainText('正文已返回')
    await page.getByRole('button',{name:'查看源码证据',exact:true}).click()
    await expect(page.locator('.evidence-excerpt pre')).toContainText('TaskScheduler')
    await shot('07-evidence');await page.keyboard.press('Escape')
    assert.equal((await getTask()).packet.contexts.length,4)
  })
  await check('external same-task request updates the canvas via SSE and preserves per-batch client source',async()=>{
    const id=await selector().inputValue()
    const response=await context.request.post(base+'/api/context/tasks/'+id+'/query',{headers:{'x-harness-client':'test'},data:{read:['not-present','mgrp.base']}})
    assert.equal(response.status(),200);const result=await response.json();assert.equal(result.errors.length,1)
    await expect(page.locator('.output-card')).toHaveAttribute('data-output-count','5')
    await expect(page.locator('.origin-label')).toContainText('多来源')
    await page.getByRole('button',{name:'检索记录',exact:true}).click()
    await expect(page.locator('.batch-record.partial')).toContainText('not-present')
    await shot('08-partial-result');await page.keyboard.press('Escape')
  })
  await check('failed request keeps candidates and does not light a failed target, retry succeeds',async()=>{
    await chooseBody('业务公共支持').click()
    expectedFailure=true
    await page.route('**/api/context/tasks/*/query',route=>route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'自动检查：请求失败'})}))
    await batch().click();await expect(page.locator('.error-banner')).toContainText('请求失败')
    await expect(model('mgrp.common')).not.toHaveClass(/body-returned/)
    await expect(chooseBody('业务公共支持')).toHaveAttribute('aria-pressed','true')
    await page.unroute('**/api/context/tasks/*/query');expectedFailure=false
    await batch().click();await expect(page.locator('.output-card')).toHaveAttribute('data-output-count','6')
  })
  await check('manual collapse remains closed across later batch updates and cached read omits duplicate body',async()=>{
    await page.getByRole('button',{name:'收起任务执行',exact:true}).click()
    const state=await getTask(),id=state.id,body=state.packet.contexts.find(n=>n.id==='mgrp.execution.task')
    const response=await context.request.post(base+'/api/context/tasks/'+id+'/query',{headers:{'x-harness-client':'test'},data:{read:[body.id],known:{[body.id]:body.contentHash}}})
    const result=await response.json();assert.equal(result.contexts.length,0);assert.equal(result.unchanged.length,1)
    await expect(model('mgrp.execution.task')).toHaveCount(0)
    await expect(page.locator('.output-card')).toHaveAttribute('data-output-count','6')
  })
  await check('infinite pan/anchored zoom and overview remain functional',async()=>{
    const before=await camera();await page.mouse.move(50,700);await page.mouse.down();await page.mouse.move(280,650,{steps:8});await page.mouse.up()
    const after=await camera();assert.ok(after.x-before.x>200)
    const point={x:500,y:500-64},world={x:(point.x-after.x)/after.scale,y:(point.y-after.y)/after.scale}
    await page.mouse.move(500,500);await page.mouse.wheel(0,-130)
    await expect.poll(async()=>(await camera()).scale).toBeGreaterThan(after.scale)
    const zoomed=await camera();assert.ok(Math.abs((point.x-zoomed.x)/zoomed.scale-world.x)<1)
    assert.ok(Math.abs((point.y-zoomed.y)/zoomed.scale-world.y)<1)
    await page.getByRole('button',{name:'概览全部内容'}).click()
  })
  await check('preset makes real requests while labelled preset, with no fake timed path',async()=>{
    await page.getByRole('button',{name:'示例选择',exact:true}).click()
    await expect(page.locator('.origin-label')).toContainText('预设选择')
    await expect(page.locator('.output-card')).toHaveAttribute('data-output-count','4')
    assert.equal((await getTask()).batches.length,3)
    await expect(page.locator('.journey-station')).toHaveCount(0)
  })
  await check('mobile has native pinch gestures, normal text scale, and a readable output drawer',async()=>{
    await page.setViewportSize({width:390,height:844});await page.reload()
    await expect(page.locator('.output-card')).toHaveAttribute('data-output-count','4')
    await expect(page.getByRole('button',{name:'任务输入',exact:true})).toBeVisible()
    assert.ok((await camera()).scale>=.9);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
    await shot('09-mobile-input')
    const before=await camera(),cdp=await context.newCDPSession(page)
    await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:2})
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:120,y:315,id:1},{x:260,y:315,id:2}]})
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:80,y:315,id:1},{x:300,y:315,id:2}]})
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach()
    await expect.poll(async()=>(await camera()).scale).toBeGreaterThan(before.scale*1.3)
    await page.getByRole('button',{name:'输出',exact:true}).click()
    await page.getByRole('button',{name:'查看上下文包',exact:true}).click()
    await expect(page.getByRole('textbox',{name:'上下文包原文'})).toHaveValue(/mgrp\.execution\.task/)
    await shot('10-mobile-packet');await page.keyboard.press('Escape')
  })
  await check('fresh real result drives lighting animation under normal motion',async()=>{
    await page.setViewportSize({width:1440,height:1000});await page.emulateMedia({reducedMotion:'no-preference'});await page.reload()
    await expect(page.locator('.output-card')).toHaveAttribute('data-output-count','4')
    await chooseBody('业务公共支持').click();await batch().click()
    await expect(model('mgrp.common')).toHaveClass(/fresh-return/)
    await expect(page.locator('.return-particle')).toHaveCount(1)
    await shot('11-real-lighting')
  })
  await check('model/source remain unchanged and no unexpected page errors occur',async()=>{
    const after=await(await context.request.get(base+'/api/snapshot')).json();assert.equal(after.revision,initial.revision);assert.equal(after.modelStatus,'valid')
    assert.deepEqual(report.errors,[]);report.modelRevision=initial.revision
  })
  report.status='passed'
}catch(error){report.status='failed';report.failure=String(error);console.error(error);await shot('failure').catch(()=>{});process.exitCode=1}
finally{report.completedAt=new Date().toISOString();await writeFile(output+'/report.json',JSON.stringify(report,null,2));await browser.close()}
