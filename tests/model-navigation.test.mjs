import { test } from 'node:test'
import assert from 'node:assert/strict'
import { relationsForScope } from '../src/model-navigation.ts'

test('module navigation preserves child relationship evidence and endpoints', () => {
  const relations = [
    { id: 'incoming', source: 'mgrp.api.capi', target: 'mgrp.business.download', evidence: 'e1' },
    { id: 'outgoing', source: 'mgrp.business.download', target: 'mgrp.execution.task', evidence: 'e2' },
    { id: 'internal', source: 'mgrp.business.download', target: 'mgrp.business.resource', evidence: 'e3' },
    { id: 'sibling', source: 'mgrp.network.manager', target: 'mgrp.network.backend', evidence: 'e4' },
    { id: 'different-prefix', source: 'mgrp.businessOther.a', target: 'mgrp.base', evidence: 'e5' }
  ]
  const selected = relationsForScope(relations, 'mgrp.business')
  assert.deepEqual(selected.map(r => r.id), ['incoming', 'outgoing', 'internal'])
  assert.equal(selected[0], relations[0])
  assert.equal(selected[1].evidence, 'e2')
  assert.deepEqual(relationsForScope(relations, 'mgrp.business.resource').map(r => r.id), ['internal'])
})
