import test from 'node:test';
import assert from 'node:assert/strict';
import { runUploadQueue, createUploadClient } from '../assets/upload.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('queue overlaps work, bounds bytes, and preserves input indices despite reversed completion', async () => {
  const gates = Array.from({ length: 4 }, deferred), started = [], completed = [];
  const files = [8, 4, 8, 4].map(size => ({ size }));
  const run = runUploadQueue(files, async (_, index) => {
    started.push(index); await gates[index].promise; completed.push(index);
  }, { concurrency: 3, maxBytes: 12 });
  await new Promise(setImmediate);
  assert.deepEqual(started, [0, 1]);
  gates[1].resolve(); await new Promise(setImmediate);
  assert.deepEqual(started, [0, 1], 'another 8-byte job would exceed the budget');
  gates[0].resolve(); await new Promise(setImmediate);
  assert.deepEqual(started, [0, 1, 2, 3]);
  gates[3].resolve(); gates[2].resolve(); await run;
  assert.deepEqual(completed, [1, 0, 3, 2]);
});

test('queue stops scheduling after a failure and drains active uploads before returning', async () => {
  const gate = deferred(), started = [], completed = [];
  const run = runUploadQueue([{ size: 1 }, { size: 1 }, { size: 1 }], async (_, index) => {
    started.push(index);
    if (index === 0) throw new Error('network failed');
    await gate.promise; completed.push(index);
  });
  const assertion = assert.rejects(run, /network failed/);
  await new Promise(setImmediate);
  assert.deepEqual(started, [0, 1]); assert.deepEqual(completed, []);
  gate.resolve(); await assertion; assert.deepEqual(completed, [1]);
});

test('an individual file larger than the queue budget runs alone without deadlock', async () => {
  let active = 0, peak = 0;
  await runUploadQueue([{ size: 20 }, { size: 2 }], async () => {
    peak = Math.max(peak, ++active); await new Promise(setImmediate); active--;
  }, { concurrency: 2, maxBytes: 12 });
  assert.equal(peak, 1);
});

test('an old Worker uses the legacy endpoint and never attempts staged uploads', async () => {
  const calls = [];
  const client = createUploadClient({ fetch: async (url, options) => {
    calls.push(new URL(url).pathname);
    if (new URL(url).pathname === '/health') return Response.json({ ready: true, version: 'old' });
    assert.equal(options.body.getAll('images').length, 1);
    return Response.json({ status: 'committed', commitSha: 'saved', album: { id: 'one' } });
  } });
  const body = new FormData(); body.set('requestId', crypto.randomUUID()); body.append('images', new File(['image'], 'one.png'));
  const result = await client.save({ endpoint: 'https://worker.test/albums', password: 'password', body });
  assert.equal(result.commitSha, 'saved'); assert.deepEqual(calls, ['/health', '/albums']);
});
