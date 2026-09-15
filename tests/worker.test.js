import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/worker.js';

const env = { GITHUB_TOKEN: 'test-token-not-a-real-secret', UPLOAD_PASSWORD: 'test-password-not-a-real-secret' };
const origin = 'https://sherlockgy.github.io';
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Z9sAAAAASUVORK5CYII=', 'base64'));
let ip = 0;
function request({ id = crypto.randomUUID(), title = '知识图集', count = 1, bytes = png, type = 'image/png', password = env.UPLOAD_PASSWORD, source = origin, date = '2026-09-15' } = {}) {
  const form = new FormData();
  form.set('requestId', id); form.set('title', title); form.set('date', date); form.set('description', '图片说明');
  for (let i = 0; i < count; i++) form.append('images', new File([bytes], '../../unsafe.png', { type }));
  return new Request('https://worker.test/albums', { method: 'POST', headers: { Origin: source, Authorization: `Bearer ${password}`, 'CF-Connecting-IP': `192.0.2.${++ip}` }, body: form });
}
function fakeGit({ conflicts = 0, loseResponse = false } = {}) {
  let head = 'initial', serial = 0;
  const commits = new Map([['initial', { tree: 'initial-tree', manifest: { schemaVersion: 1, albums: [], custom: 'preserve' } }]]);
  const trees = new Map();
  const calls = [];
  const fetch = async (url, options) => {
    const target = new URL(url); assert.equal(target.origin, 'https://api.github.com');
    assert.ok(target.pathname.startsWith('/repos/SherlockGy/SherlockGy.github.io/'));
    assert.equal(options.headers.Authorization, `Bearer ${env.GITHUB_TOKEN}`);
    const path = target.pathname.replace('/repos/SherlockGy/SherlockGy.github.io', '');
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, method: options.method, body });
    const ok = value => Response.json(value);
    if (path === '/git/ref/heads/master') return ok({ object: { sha: head } });
    if (path.startsWith('/git/commits/') && options.method === 'GET') return ok({ tree: { sha: commits.get(path.split('/').pop()).tree } });
    if (path === '/contents/data/albums.json') return ok(commits.get(target.searchParams.get('ref')).manifest);
    if (path === '/git/blobs') { assert.equal(body.encoding, 'base64'); return ok({ sha: `blob-${++serial}` }); }
    if (path === '/git/trees') {
      assert.equal(body.base_tree, commits.get(head).tree);
      const sha = `tree-${++serial}`;
      trees.set(sha, JSON.parse(body.tree.find(entry => entry.path === 'data/albums.json').content));
      return ok({ sha });
    }
    if (path === '/git/commits') {
      assert.equal(body.parents.length, 1);
      const sha = `commit-${++serial}`; commits.set(sha, { tree: body.tree, manifest: trees.get(body.tree) }); return ok({ sha });
    }
    if (path === '/git/refs/heads/master') {
      assert.equal(body.force, false);
      if (conflicts-- > 0) {
        const previous = commits.get(head); head = `concurrent-${++serial}`;
        commits.set(head, { tree: head + '-tree', manifest: { ...previous.manifest, albums: [...previous.manifest.albums, { id: head, title: 'Another upload' }] } });
        return Response.json({ message: 'not a fast forward' }, { status: 422 });
      }
      head = body.sha;
      if (loseResponse) { loseResponse = false; throw new TypeError('Connection lost after committing'); }
      return ok({ object: { sha: head } });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  return { fetch, calls, manifest: () => commits.get(head).manifest };
}

test('CORS preflight, authentication, file validation, atomic commits, retries and idempotency', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const fake = fakeGit(); globalThis.fetch = fake.fetch;
  const preflight = await worker.fetch(new Request('https://worker.test/albums', { method: 'OPTIONS', headers: { Origin: origin } }), env);
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal((await worker.fetch(request({ password: 'incorrect' }), env)).status, 401);
  const denied = await worker.fetch(request({ source: 'https://other.example' }), env);
  assert.equal(denied.status, 403); assert.equal(denied.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await worker.fetch(request(), {})).status, 503);
  assert.equal(fake.calls.length, 0);
  for (const options of [{ date: '2026-02-30' }, { bytes: encoder.encode('<svg onload="alert(1)"></svg>') }, { count: 0 }, { count: 31 }]) {
    assert.equal((await worker.fetch(request(options), env)).status, 400);
  }
  assert.equal(fake.calls.length, 0);
  const id = crypto.randomUUID();
  const response = await worker.fetch(request({ id, count: 2 }), env);
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.status, 'committed'); assert.equal(result.album.title, '知识图集');
  assert.equal(result.album.images.length, 2); assert.equal(result.album.images[0].width, 1);
  assert.match(result.album.images[1].src, /\/002\.png$/); assert.ok(!result.album.images[0].src.includes('unsafe'));
  assert.equal(fake.manifest().custom, 'preserve');
  const blobCount = fake.calls.filter(call => call.path === '/git/blobs').length;
  assert.equal((await worker.fetch(request({ id, count: 2 }), env)).status, 201);
  assert.equal(fake.calls.filter(call => call.path === '/git/blobs').length, blobCount);
  assert.equal(fake.manifest().albums.length, 1);
  assert.equal((await worker.fetch(request({ id, title: 'Changed' }), env)).status, 409);
});
const encoder = new TextEncoder();

test('30 images plus two concurrent updates remain within 50 subrequests and preserve all albums', async t => {
  const old = globalThis.fetch; t.after(() => { globalThis.fetch = old; });
  const fake = fakeGit({ conflicts: 2 }); globalThis.fetch = fake.fetch;
  const response = await worker.fetch(request({ count: 30 }), env);
  assert.equal(response.status, 201);
  assert.equal(fake.manifest().albums.length, 3);
  assert.equal(fake.calls.length, 48);
  assert.equal(fake.calls.filter(call => call.path === '/git/blobs').length, 30);
});

test('a lost commit response is recoverable without duplicating the album', async t => {
  const old = globalThis.fetch; t.after(() => { globalThis.fetch = old; });
  const fake = fakeGit({ loseResponse: true }); globalThis.fetch = fake.fetch;
  const id = crypto.randomUUID();
  assert.equal((await worker.fetch(request({ id }), env)).status, 504);
  assert.equal(fake.manifest().albums.length, 1);
  assert.equal((await worker.fetch(request({ id }), env)).status, 201);
  assert.equal(fake.manifest().albums.length, 1);
});
