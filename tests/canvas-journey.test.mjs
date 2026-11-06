import { test } from 'node:test'
import assert from 'node:assert/strict'
import { zoomAt, fitBounds } from '../src/canvas-model.ts'

test('zoom preserves the world point under the pointer and clamps extreme scales', () => {
  const camera={x:120,y:-80,scale:1.2}, point={x:540,y:360}
  const world={x:(point.x-camera.x)/camera.scale,y:(point.y-camera.y)/camera.scale}
  for(const ratio of [1.6,0.3,100,0.0001]){
    const next=zoomAt(camera,point,ratio)
    assert.ok(next.scale>=0.3&&next.scale<=2)
    assert.ok(Math.abs((point.x-next.x)/next.scale-world.x)<1e-8)
    assert.ok(Math.abs((point.y-next.y)/next.scale-world.y)<1e-8)
  }
})

test('overview fits negative and expanded world coordinates with readable max scale', () => {
  const bounds={x:-420,y:-70,width:2100,height:650}
  const view={width:1400,height:900}
  const next=fitBounds(bounds,view,80)
  assert.ok(next.scale<=1)
  assert.ok(bounds.x*next.scale+next.x>=79)
  assert.ok((bounds.x+bounds.width)*next.scale+next.x<=view.width-79)
  assert.ok(bounds.y*next.scale+next.y>=79)
  assert.ok((bounds.y+bounds.height)*next.scale+next.y<=view.height-79)
})

