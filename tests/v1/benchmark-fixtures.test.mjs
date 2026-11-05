import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateDataset, writeDataset, summarizeSamples } from '../../scripts/v1/benchmark.mjs';

test('benchmark generator is deterministic, layered and matches all declared scales', () => {
  for (const objects of [40, 100, 1000, 10000]) {
    const first = generateDataset({ objects, seed: 54261105 });
    const second = generateDataset({ objects, seed: 54261105 });
    assert.deepEqual(first, second);
    assert.equal(first.kind, objects === 40 ? 'synthetic-mgrp-scale' : 'synthetic-layered-scale');
    assert.equal(first.meta.objects, objects);
    assert.equal(first.meta.relationships, Math.floor(objects * 0.8));
    assert.equal(first.meta.views, 5);
    assert.equal(first.nodes.length, objects);
    assert.equal(new Set(first.nodes.map(node => node.id)).size, objects);
    assert.ok(first.nodes.some(node => node.depth >= 2));
    assert.ok(first.views.every(view => view.included.length <= 12));
    assert.ok(first.nodes.every((node, i) => i === 0 || first.nodes.some(parent => parent.id === node.parentId)));
    assert.equal(first.meta.evidence, Math.ceil(objects / 16));
    assert.equal(first.meta.skills, 20);
    assert.ok(!JSON.stringify(first).includes('I:\\AI'));
  }
});

test('seed controls fixture identity and invalid sizes are rejected', () => {
  assert.notEqual(generateDataset({ objects: 40, seed: 1 }).nodes[0].id, generateDataset({ objects: 40, seed: 2 }).nodes[0].id);
  for (const objects of [0, -1, 2.5, Number.NaN, 100001]) assert.throws(() => generateDataset({ objects }));
  for (const seed of [-1, Number.NaN, 1.5, 4294967296]) assert.throws(() => generateDataset({ objects: 40, seed }));
});

test('fixture files are written only below the explicit temporary root', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'harnessl3-benchmark-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = generateDataset({ objects: 40, seed: 7 });
  await writeDataset(root, data);
  const dsl = await readFile(path.join(root, '.harness', 'model', 'main.c4'), 'utf8');
  assert.equal((dsl.match(/harness_id/g) ?? []).length, 72);
  assert.equal((dsl.match(/view bench_/g) ?? []).length, 5);
  const evidence = JSON.parse(await readFile(path.join(root, '.harness', 'evidence.json'), 'utf8'));
  assert.equal(evidence.evidence.length, 3);
  await assert.rejects(writeDataset(root, { ...data, files: { '../outside.txt': 'escape' } }));
});

test('statistics preserve failed raw samples and use transparent nearest-rank percentiles', () => {
  const samples = [{ ok: true, ms: 10, peakRSSBytes: 20 }, { ok: true, ms: 100, peakRSSBytes: 30 }, { ok: false, ms: 1000, peakRSSBytes: 40, errorCode: 'TIMEOUT' }];
  const result = summarizeSamples(samples);
  assert.equal(result.sampleCount, 3);
  assert.equal(result.successCount, 2);
  assert.equal(result.failureRate, 1 / 3);
  assert.equal(result.p50Ms, 10);
  assert.equal(result.p95Ms, 100);
  assert.equal(result.peakRSSBytes, 40);
});

test('the synthetic MGRP-sized fixture is accepted by the actual LikeC4 model loader', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'harnessl3-benchmark-model-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeDataset(root, generateDataset({ objects: 40 }));
  const { loadModel } = await import('../../build/core/model.js');
  const model = await loadModel(root);
  assert.equal(model.entities.filter(item => item.entityType === 'object').length, 40);
  assert.equal(model.entities.filter(item => item.entityType === 'relation').length, 32);
  assert.equal(model.views.length, 5);
  assert.equal(model.evidence.length, 3);
});
