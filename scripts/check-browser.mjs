import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import { expect } from 'playwright/test'

const base=`http://127.0.0.1:${Number(process.env.PORT??4317)}`,output='.harness-local/mindmap-browser'
await mkdir(output,{recursive:true})
const report={startedAt:new Date().toISOString(),checks:[],errors:[],screenshots:[]}
const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL??'msedge',headless:true})
const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'})
await context.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():route.abort())
const page=await context.newPage();let expectedFailure=false
page.on('pageerror',error=>report.errors.push(String(error)))
page.on('console',message=>{if(message.type()==='error'&&!expectedFailure)report.errors.push(message.text())})
const initial=await(await context.request.get(base+'/api/context/overview')).json()
const selector=()=>page.getByRole('combobox',{name:'当前检索任务'})
const node=id=>page.locator(`[data-map-id="${id}"]`)
const model=id=>node('object:'+id)
const getTask=async()=>{const id=await selector().inputValue();return(await context.request.get(base+'/api/context/tasks/'+id)).json()}
const fit=async()=>{await page.getByRole('button',{name:'概览全部内容'}).click()}
const choose=title=>page.getByRole('button',{name:`选择${title}正文`,exact:true})
const batch=()=>page.getByRole('button',{name:'批量获取',exact:true})
async function check(name,fn){await fn();report.checks.push(name);console.log('PASS '+name)}
async function shot(name){const path=`${output}/${name}.png`;await page.screenshot({path});report.screenshots.push(path)}
async function camera(){return page.locator('.world').evaluate(el=>({x:Number(el.dataset.cameraX),y:Number(el.dataset.cameraY),scale:Number(el.dataset.cameraScale)}))}
async function open(id){await node(id).locator('.map-main').click();await fit()}
async function collapseAll(){await page.getByRole('button',{name:'收起全部层级'}).click()}
try{
  await page.goto(base)
  await check('root starts with five information categories and connects input/output inside the same world',async()=>{
    await expect(page.locator('.map-node')).toHaveCount(5)
    assert.deepEqual(await page.locator('.category-node .map-title strong').allTextContents(),['对象','关系','来源','证据','版本'])
    await expect(page.locator('.world .input-card,.world .output-card')).toHaveCount(2)
    await expect(page.locator('[data-edge-kind="input"]')).toHaveCount(5);await expect(page.locator('[data-edge-kind="output"]')).toHaveCount(5)
    await expect(page.locator('a,.journey-station')).toHaveCount(0)
    await expect(page.locator('[data-skill-selector]')).toBeInViewport();await expect(page.locator('[data-skill-plan]')).toBeInViewport()
    const titleSize=await page.locator('.category-node .map-title strong').first().evaluate(element=>parseFloat(getComputedStyle(element).fontSize))
    assert.ok(titleSize*(await camera()).scale>=12,'initial overview retains readable category headings with both lanes visible')
    await shot('01-five-roots')
  })
  await check('pan and zoom transform input, categories and output together',async()=>{
    const cards=()=>Promise.all(['.input-card','.category-node','.output-card'].map(s=>page.locator(s).first().boundingBox()))
    const before=await cards();await page.mouse.move(1000,220);await page.mouse.down();await page.mouse.move(1100,270,{steps:5});await page.mouse.up()
    const after=await cards();for(let i=0;i<3;i++){assert.ok(Math.abs(after[i].x-before[i].x-100)<2);assert.ok(Math.abs(after[i].y-before[i].y-50)<2)}
    const widths=after.map(b=>b.width);await page.getByRole('button',{name:'放大画布'}).click();const zoomed=await cards();for(let i=0;i<3;i++)assert.ok(zoomed[i].width>widths[i]*1.19)
    await fit()
  })
  await check('new real task remains collapsed and only exposes top briefs',async()=>{
    await selector().selectOption('');await page.getByRole('textbox',{name:'任务目的'}).fill('自动脑图检查：执行状态与网络取消')
    await page.getByRole('button',{name:'开始检索',exact:true}).click();await expect(selector()).not.toHaveValue('')
    const task=await getTask();assert.equal(task.batches.length,1);assert.equal(task.packet.contexts.length,0);assert.equal(task.disclosedIds.length,11)
    await expect(page.locator('.map-node')).toHaveCount(5);await expect(node('category:objects')).not.toHaveClass(/is-hit/)
  })
  await check('object branch reveals one layer at a time without generating read requests',async()=>{
    const before=await node('category:objects').boundingBox();await node('category:objects').locator('.map-main').click();const after=await node('category:objects').boundingBox();assert.ok(Math.abs(before.x-after.x)<1&&Math.abs(before.y-after.y)<1,'expanding preserves the clicked root position');await fit();await expect(page.locator('.map-node[data-depth="2"]')).toHaveCount(11)
    await expect(model('mgrp.execution.task')).toHaveCount(0)
    await open('object:mgrp.execution');await expect(model('mgrp.execution.task')).toBeVisible();assert.equal((await getTask()).batches.length,1)
    await expect(model('mgrp.execution.task')).not.toHaveClass(/body-returned/);await shot('02-object-layers')
  })
  await check('one mixed batch returns selected body and two directories without auto expanding categories',async()=>{
    let releaseLists;const blocked=new Promise(resolve=>{releaseLists=resolve})
    const holdLists=async route=>{if(route.request().method()==='GET')await blocked;await route.continue()}
    await page.route('**/api/context/tasks',holdLists)
    try{
      await page.getByRole('button',{name:'选择任务执行子层目录',exact:true}).click();await page.getByRole('button',{name:'选择网络与平台后端子层目录',exact:true}).click();await choose('网络与平台后端').click();await batch().click()
      await expect(page.locator('.output-card')).toHaveAttribute('data-output-count','1')
      await expect(choose('TaskManager')).toBeDisabled()
    }finally{releaseLists();await page.unrouteAll({behavior:'wait'})}
    await expect(choose('TaskManager')).toBeEnabled()
    const task=await getTask();assert.equal(task.batches.at(-1).request.expand.length,2);assert.equal(task.batches.at(-1).result.contexts.length,1)
    await expect(model('mgrp.network')).toHaveClass(/body-returned/);await expect(node('category:relations').locator('.map-main')).toHaveAttribute('aria-expanded','false')
  })
  await check('batch of three exact bodies projects actual returned information into all five roots',async()=>{
    for(const title of ['TaskManager','TaskScheduler','ResourceTransferCoordinator'])await choose(title).click()
    await batch().click();await expect(page.locator('.output-card')).toHaveAttribute('data-output-count','4')
    await expect(page.locator('.category-node.is-hit')).toHaveCount(5);await expect(model('mgrp.execution')).toHaveAttribute('data-state','aggregate')
    await expect(model('mgrp.execution.artifact')).not.toHaveClass(/is-hit/);await shot('03-returned-context')
  })
  await check('collapse hides descendants and retains category aggregates across an external SSE result',async()=>{
    await collapseAll();await expect(page.locator('.map-node')).toHaveCount(5)
    const task=await getTask();await context.request.post(base+'/api/context/tasks/'+task.id+'/query',{headers:{'x-harness-client':'test'},data:{read:['mgrp.execution.task','missing-object']}})
    await expect(page.locator('.origin-label')).toContainText('多来源请求');await expect(page.locator('.map-node')).toHaveCount(5)
    const after=await getTask();assert.equal(after.batches.at(-1).status,'partial');assert.equal(after.batches.at(-1).client,'test')
  })
  await check('relation projection preserves inferred and unverified scope',async()=>{
    await open('category:relations');await open('relations:mgrp.execution')
    const snapshot=await(await context.request.get(base+'/api/context/overview')).json(),relation=snapshot.relationships.find(r=>r.metadata.source==='inference')
    assert.ok(relation);const item=node('relation:'+relation.id)
    await item.getByRole('button',{name:/来源详情/}).click();await expect(page.locator('.detail-panel')).toContainText('unverified');await expect(page.locator('.detail-panel')).toContainText('inference')
    await shot('04-relation-scope');await page.keyboard.press('Escape')
  })
  await check('evidence projection says reference returned and separately previews actual source',async()=>{
    await collapseAll();await open('category:evidence');await open('evidence:mgrp.execution')
    const item=node('evidence:e-mgrp-execution-task');await expect(item).toHaveAttribute('data-state','reference')
    await item.locator('.map-main').click();await expect(page.locator('.detail-panel')).toContainText('不等于源码片段已读取')
    await page.getByRole('button',{name:'查看源码证据',exact:true}).click();await expect(page.locator('.evidence-excerpt')).toContainText('task_manager.h');await shot('05-evidence');await page.keyboard.press('Escape')
  })
  await check('sources and versions disclose real groups through clicks',async()=>{
    await collapseAll();for(const id of ['category:sources','category:versions'])await open(id)
    await expect(node('sources:source-code')).toBeVisible();await expect(node('sources:inference')).toBeVisible();await expect(node('versions:model')).toBeVisible();await expect(node('versions:source')).toBeVisible();await expect(node('versions:worktree')).toBeVisible()
    await open('versions:model');assert.ok(await page.locator('.map-node[data-category="versions"][data-depth="3"]').count()>0);await shot('06-five-information-branches')
  })
  await check('packet and copy preserve exact bodies, source version and unverified inference',async()=>{
    await page.getByRole('button',{name:'定位上下文输出'}).click();await page.getByRole('button',{name:'查看上下文包',exact:true}).click()
    const packet=await page.getByRole('textbox',{name:'上下文包原文'}).inputValue();assert.ok(packet.includes('mgrp.execution.task'));assert.ok(packet.includes('unverified'));assert.ok(packet.includes('057f0b3'));assert.ok(!packet.includes('## ResourceArtifactStore'))
    await page.evaluate(()=>{window.__copied='';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copied=text}}})})
    await page.getByRole('button',{name:'复制上下文包',exact:true}).click();assert.equal(await page.evaluate(()=>window.__copied),packet);await shot('07-packet');await page.keyboard.press('Escape')
  })
  await check('failed HTTP keeps selection and cached retry does not duplicate the packet',async()=>{
    await collapseAll();await open('category:objects');await choose('业务公共支持').click()
    expectedFailure=true;await page.route('**/api/context/tasks/*/query',route=>route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'检查失败：保留候选'})}));await batch().click()
    await expect(page.locator('.error-banner')).toContainText('保留候选');await expect(choose('业务公共支持')).toHaveAttribute('aria-pressed','true');await expect(model('mgrp.common')).not.toHaveClass(/body-returned/)
    await page.unroute('**/api/context/tasks/*/query');expectedFailure=false;await batch().click();await expect(page.locator('.output-card')).toHaveAttribute('data-output-count','5')
    await choose('业务公共支持').click()
    const completed=page.waitForResponse(response=>response.request().method()==='POST'&&/\/api\/context\/tasks\/[^/]+\/query$/.test(new URL(response.url()).pathname))
    await batch().click();const response=await completed;assert.equal(response.status(),200)
    const result=await response.json(),task=await getTask();assert.equal(task.batches.at(-1).id,result.batchId);assert.equal(result.unchanged.length,1);assert.equal(task.packet.contexts.length,5)
  })
  await check('preset uses real requests and leaves the initial five categories collapsed',async()=>{
    await page.getByRole('button',{name:'运行示例',exact:true}).click();await expect(page.locator('.origin-label')).toContainText('预设选择');await expect(page.locator('.output-card')).toHaveAttribute('data-output-count','4');await expect(page.locator('.map-node')).toHaveCount(5)
    assert.equal((await getTask()).batches.length,3);await fit();await shot('08-connected-overview')
  })
  await check('mobile supports native pinch on the same world and a readable output drawer',async()=>{
    await page.setViewportSize({width:390,height:844});await page.reload();await expect(page.locator('.map-node')).toHaveCount(5)
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await shot('09-mobile')
    const before=await camera(),cdp=await context.newCDPSession(page);await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:2})
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:80,y:315,id:1},{x:290,y:315,id:2}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:40,y:315,id:1},{x:330,y:315,id:2}]});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach()
    await expect.poll(async()=>(await camera()).scale).toBeGreaterThan(before.scale*1.3)
    await expect(page.locator('.map-node')).toHaveCount(5)
    await page.getByRole('button',{name:'输出',exact:true}).click();await page.getByRole('button',{name:'查看上下文包',exact:true}).click();await expect(page.getByRole('textbox',{name:'上下文包原文'})).toHaveValue(/mgrp\.execution\.task/);await shot('10-mobile-packet');await page.keyboard.press('Escape')
  })
  await check('normal-motion real response lights collapsed category routes without auto-opening children',async()=>{
    await page.setViewportSize({width:1440,height:1000});await page.emulateMedia({reducedMotion:'no-preference'});await page.reload();await expect(page.locator('.map-node')).toHaveCount(5)
    const task=await getTask();await context.request.post(base+'/api/context/tasks/'+task.id+'/query',{headers:{'x-harness-client':'test'},data:{read:['mgrp.common']}})
    await expect(node('category:objects')).toHaveClass(/fresh-return/);await expect(page.locator('.map-node')).toHaveCount(5);assert.ok(await page.locator('.return-particle').count()>0);await shot('11-real-lighting')
  })
  await check('model revision is unchanged and the browser has no unexpected errors',async()=>{
    const after=await(await context.request.get(base+'/api/context/overview')).json();assert.equal(after.revision,initial.revision);assert.equal(after.modelStatus,'valid');assert.deepEqual(report.errors,[]);report.modelRevision=initial.revision
  })
  report.status='passed'
}catch(error){report.status='failed';report.failure=String(error);console.error(error);await shot('failure').catch(()=>{});process.exitCode=1}
finally{report.completedAt=new Date().toISOString();await writeFile(output+'/report.json',JSON.stringify(report,null,2));await browser.close()}
