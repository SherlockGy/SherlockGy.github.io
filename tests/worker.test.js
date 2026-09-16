import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/worker.js';

const env = { GITHUB_TOKEN: 'test-token-not-a-real-secret', UPLOAD_PASSWORD: 'test-password-not-a-real-secret' };
const origin = 'https://sherlockgy.github.io';
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Z9sAAAAASUVORK5CYII=', 'base64'));
let ip = 0;
beforeEach(t => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
});
function checkRequest(password = env.UPLOAD_PASSWORD) {
  return new Request('https://worker.test/check', { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${password}`, 'CF-Connecting-IP': `192.0.2.${++ip}` } });
}
function request({ id = crypto.randomUUID(), title = '知识图集', count = 1, bytes = png, type = 'image/png', password = env.UPLOAD_PASSWORD, source = origin, date = '2026-09-15' } = {}) {
  const form = new FormData();
  form.set('requestId', id); form.set('title', title); form.set('date', date); form.set('description', '图片说明');
  for (let i = 0; i < count; i++) form.append('images', new File([bytes], '../../unsafe.png', { type }));
  return new Request('https://worker.test/albums', { method: 'POST', headers: { Origin: source, Authorization: `Bearer ${password}`, 'CF-Connecting-IP': `192.0.2.${++ip}` }, body: form });
}
function fakeGit({ conflicts = 0, loseResponse = false, initialManifest, concurrentChange } = {}) {
  let head = 'initial', serial = 0;
  const commits = new Map([['initial', { tree: 'initial-tree', manifest: initialManifest || { schemaVersion: 1, albums: [], custom: 'preserve' } }]]);
  const trees = new Map();
  const calls = [];
  const fetch = async (url, options) => {
    const target = new URL(url); assert.equal(target.origin, 'https://api.github.com');
    assert.ok(target.pathname.startsWith('/repos/SherlockGy/SherlockGy.github.io/'));
    assert.equal(options.headers.Authorization, `Bearer ${env.GITHUB_TOKEN}`);
    assert.equal(options.redirect, 'manual', 'Workers GitHub requests must inspect redirects without following them');
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
        commits.set(head, { tree: head + '-tree', manifest: concurrentChange ? concurrentChange(structuredClone(previous.manifest)) : { ...previous.manifest, albums: [...previous.manifest.albums, { id: head, title: 'Another upload' }] } });
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
  assert.equal((await worker.fetch(request({ id }), env)).status, 502);
  assert.equal(fake.manifest().albums.length, 1);
  assert.equal((await worker.fetch(request({ id }), env)).status, 201);
  assert.equal(fake.manifest().albums.length, 1);
});

test('connection check authenticates, reads the current manifest and never writes to GitHub', async t => {
  const fake = fakeGit(); t.mock.method(globalThis, 'fetch', fake.fetch);
  assert.equal((await worker.fetch(checkRequest('incorrect'), env)).status, 401);
  assert.equal(fake.calls.length, 0);
  const response = await worker.fetch(checkRequest(), { ...env, GITHUB_TOKEN: `\n ${env.GITHUB_TOKEN} \n` });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, 'readable'); assert.equal(result.albumCount, 0);
  assert.equal(result.version, '2026-09-16-series-edit-1'); assert.ok(result.traceId);
  assert.equal(fake.calls.length, 3); assert.ok(fake.calls.every(call => call.method === 'GET'));
  assert.equal(fake.manifest().albums.length, 0);
});

test('connection errors and timeouts are distinguished, staged, and redacted in responses and logs', async t => {
  const logs = [];
  t.mock.method(console, 'error', value => logs.push(value));
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError(`Invalid header ${env.GITHUB_TOKEN} ${env.UPLOAD_PASSWORD} github_pat_exampletoken`); });
  const response = await worker.fetch(checkRequest(), env);
  assert.equal(response.status, 502);
  const data = await response.json();
  assert.equal(data.error.code, 'GITHUB_CONNECTION_ERROR');
  assert.equal(data.error.stage, '读取主分支'); assert.equal(data.error.errorName, 'TypeError');
  assert.ok(data.error.traceId); assert.equal(typeof data.error.elapsedMs, 'number');
  assert.ok(logs.some(item => item.event === 'github.error' && item.traceId === data.error.traceId && item.timedOut === false));
  for (const secret of [env.GITHUB_TOKEN, env.UPLOAD_PASSWORD, 'github_pat_exampletoken']) {
    assert.ok(!JSON.stringify({ data, logs }).includes(secret));
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('Request timed out', 'TimeoutError'); });
  const timeout = await worker.fetch(checkRequest(), env);
  assert.equal(timeout.status, 504);
  const timeoutData = await timeout.json();
  assert.equal(timeoutData.error.code, 'GITHUB_TIMEOUT'); assert.equal(timeoutData.error.timeoutMs, 20000);
  assert.equal(timeoutData.error.stage, '读取主分支');
});

test('GitHub HTTP errors, invalid JSON and malformed tokens are not reported as timeouts', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: 'Bad credentials' }, { status: 401 }));
  const denied = await worker.fetch(checkRequest(), env);
  assert.equal(denied.status, 502);
  const data = await denied.json();
  assert.equal(data.error.code, 'GITHUB_ERROR'); assert.equal(data.error.httpStatus, 401);
  assert.equal(data.error.stage, '读取主分支');
  const invalidUpstream = t.mock.method(globalThis, 'fetch', async () => new Response('<html>Invalid upstream response</html>'));
  const invalid = await worker.fetch(checkRequest(), env);
  assert.equal(invalid.status, 502);
  assert.equal((await invalid.json()).error.code, 'GITHUB_INVALID_RESPONSE');
  const callsBefore = invalidUpstream.mock.callCount();
  const malformed = await worker.fetch(checkRequest(), { ...env, GITHUB_TOKEN: 'test-\ntoken' });
  assert.equal(malformed.status, 503);
  assert.equal((await malformed.json()).error.code, 'GITHUB_TOKEN_FORMAT');
  assert.equal(invalidUpstream.mock.callCount(), callsBefore);
});

test('GitHub redirects stop at the first response without forwarding credentials or reading the redirect body', async t => {
  let upstreamStatus = 301;
  const upstream = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(new URL(url).origin, 'https://api.github.com');
    if (options.redirect === 'error') throw new TypeError('Invalid redirect value, must be one of follow or manual');
    assert.equal(options.redirect, 'manual');
    return new Response('Not JSON: this redirect body must not be parsed', {
      status: upstreamStatus, headers: { Location: `https://untrusted.example/${env.GITHUB_TOKEN}` },
    });
  });
  for (const status of [301, 302, 303, 307, 308]) {
    upstreamStatus = status;
    const before = upstream.mock.callCount();
    const response = await worker.fetch(checkRequest(), env);
    assert.equal(response.status, 502);
    const result = await response.json();
    assert.equal(result.error.code, 'GITHUB_REDIRECT');
    assert.equal(result.error.stage, '读取主分支'); assert.equal(result.error.httpStatus, status);
    assert.ok(result.error.traceId);
    assert.equal(upstream.mock.callCount(), before + 1);
    assert.ok(!JSON.stringify(result).includes(env.GITHUB_TOKEN));
    assert.ok(!JSON.stringify(result).includes('untrusted.example'));
  }
});

const editFixture = () => ({ schemaVersion: 1, custom: 'keep', series: [], albums: [{
  id: 'notes', title: '知识图集', date: '2026-09-15', tags: ['学习'], uploadFingerprint: 'original',
  images: [{ src: './images/test-a.png', alt: '原图说明', width: 1, height: 1 }, { src: './images/test-b.png', alt: '第二张' }],
}] });
function managementRequest(path, body, password = env.UPLOAD_PASSWORD) {
  return new Request(`https://worker.test${path}`, { method: body ? 'POST' : 'GET', body,
    headers: { Origin: origin, Authorization: `Bearer ${password}`, 'CF-Connecting-IP': `192.0.2.${++ip}` } });
}
async function readManagement(path) {
  const response = await worker.fetch(managementRequest(path), env); assert.equal(response.status, 200); return response.json();
}
function editForm(revision, order, count = 0, id = crypto.randomUUID()) {
  const form = new FormData(); form.set('requestId', id); form.set('revision', revision); form.set('order', JSON.stringify(order));
  for (let index = 0; index < count; index++) form.append('images', new File([png], 'new.png', { type: 'image/png' }));
  return form;
}
function libraryForm(revision, series, placements, id = crypto.randomUUID()) {
  const form = new FormData(); form.set('requestId', id); form.set('revision', revision);
  form.set('series', JSON.stringify(series)); form.set('placements', JSON.stringify(placements)); return form;
}
test('management reads authenticate and do not write; pure reorder uploads no image blobs', async t => {
  const fake = fakeGit({ initialManifest: editFixture() }); t.mock.method(globalThis, 'fetch', fake.fetch);
  assert.equal((await worker.fetch(managementRequest('/albums/notes', undefined, 'wrong'), env)).status, 401);
  assert.equal((await worker.fetch(managementRequest('/library', undefined, 'wrong'), env)).status, 401);
  assert.equal(fake.calls.length, 0);
  const current = await readManagement('/albums/notes'); assert.match(current.revision, /^[a-f0-9]{64}$/);
  assert.ok(fake.calls.every(call => call.method === 'GET'));
  const response = await worker.fetch(managementRequest('/albums/notes', editForm(current.revision, [{ existing: 1 }, { existing: 0 }])), env);
  assert.equal(response.status, 200);
  assert.deepEqual(fake.manifest().albums[0].images, editFixture().albums[0].images.toReversed());
  assert.equal(fake.calls.filter(call => call.path === '/git/blobs').length, 0);
  assert.equal(fake.manifest().custom, 'keep'); assert.equal(fake.manifest().albums[0].uploadFingerprint, 'original');
});
test('append and replacement commit together using new paths while retaining all other metadata', async t => {
  const fake = fakeGit({ initialManifest: editFixture() }); t.mock.method(globalThis, 'fetch', fake.fetch);
  const { revision } = await readManagement('/albums/notes');
  const response = await worker.fetch(managementRequest('/albums/notes', editForm(revision, [{ file: 0, replaces: 1 }, { existing: 0 }, { file: 1 }], 2)), env);
  assert.equal(response.status, 200);
  const album = fake.manifest().albums[0]; assert.equal(album.images.length, 3);
  assert.equal(album.images[1].src, './images/test-a.png'); assert.equal(album.images[0].alt, '第二张');
  assert.notEqual(album.images[0].src, './images/test-b.png'); assert.notEqual(album.images[0].src, album.images[2].src);
  assert.deepEqual(album.tags, ['学习']); assert.equal(album.date, '2026-09-15');
  assert.equal(fake.calls.filter(call => call.path === '/git/blobs').length, 2);
  assert.ok(fake.calls.filter(call => call.path === '/git/trees').every(call => call.body.tree.every(entry => entry.sha !== null)));
});
test('invalid edits and stale revisions never write; unchanged drafts do not create commits', async t => {
  const fake = fakeGit({ initialManifest: editFixture() }); t.mock.method(globalThis, 'fetch', fake.fetch);
  const { revision } = await readManagement('/albums/notes');
  for (const [order, count] of [[[{ existing: 0 }], 0], [[{ existing: 0 }, { existing: 0 }], 0],
    [[{ existing: 0 }, { existing: 9 }], 0], [[{ existing: 0 }, { file: 0, replaces: 1 }, { file: 0 }], 1],
    [[{ existing: 0 }, { existing: 1 }], 1], [[{ existing: 0 }, { file: 0, replaces: 1, src: '../bad' }], 1]]) {
    assert.equal((await worker.fetch(managementRequest('/albums/notes', editForm(revision, order, count)), env)).status, 400);
  }
  assert.equal((await worker.fetch(managementRequest('/albums/notes', editForm('0'.repeat(64), [{ existing: 1 }, { existing: 0 }])), env)).status, 409);
  const unchanged = await worker.fetch(managementRequest('/albums/notes', editForm(revision, [{ existing: 0 }, { existing: 1 }])), env);
  assert.equal((await unchanged.json()).status, 'unchanged');
  assert.ok(fake.calls.every(call => call.method === 'GET'));
});
test('lost edit responses can be retried even after a later edit without duplicating images', async t => {
  const fake = fakeGit({ initialManifest: editFixture(), loseResponse: true }); t.mock.method(globalThis, 'fetch', fake.fetch);
  const { revision } = await readManagement('/albums/notes'), id = crypto.randomUUID();
  const order = [{ existing: 0 }, { existing: 1 }, { file: 0 }];
  assert.equal((await worker.fetch(managementRequest('/albums/notes', editForm(revision, order, 1, id)), env)).status, 502);
  const next = await readManagement('/albums/notes');
  assert.equal((await worker.fetch(managementRequest('/albums/notes', editForm(next.revision, [{ existing: 2 }, { existing: 0 }, { existing: 1 }])), env)).status, 200);
  const before = fake.calls.filter(call => call.method === 'POST').length;
  assert.equal((await worker.fetch(managementRequest('/albums/notes', editForm(revision, order, 1, id)), env)).status, 200);
  assert.equal(fake.manifest().albums[0].images.length, 3);
  assert.equal(fake.calls.filter(call => call.method === 'POST').length, before);
  assert.equal((await worker.fetch(managementRequest('/albums/notes', editForm(revision, [{ existing: 1 }, { existing: 0 }, { file: 0 }], 1, id)), env)).status, 409);
});
test('concurrent edits to the same album are rejected; unrelated commits are preserved', async t => {
  for (const sameAlbum of [true, false]) {
    const fake = fakeGit({ initialManifest: editFixture(), conflicts: 1, concurrentChange: manifest => {
      if (sameAlbum) manifest.albums[0].images.reverse(); else manifest.other = 'concurrent change'; return manifest;
    } }); t.mock.method(globalThis, 'fetch', fake.fetch);
    const { revision } = await readManagement('/albums/notes');
    const response = await worker.fetch(managementRequest('/albums/notes', editForm(revision, [{ existing: 0 }, { existing: 1 }, { file: 0 }], 1)), env);
    assert.equal(response.status, sameAlbum ? 409 : 200);
    if (sameAlbum) { assert.equal((await response.json()).error.code, 'ALBUM_CHANGED'); assert.equal(fake.manifest().albums[0].images.length, 2); }
    else { assert.equal(fake.manifest().other, 'concurrent change'); assert.equal(fake.manifest().albums[0].images.length, 3); }
  }
});
const nestedSeries = () => [{ id: 'economics', title: '经济学', parentId: '' }, { id: 'macro', title: '宏观经济学', parentId: 'economics' }, { id: 'policy', title: '货币政策', parentId: 'macro' }];
test('nested series, album placement and sibling ordering save without reuploading pictures', async t => {
  const fake = fakeGit({ initialManifest: editFixture() }); t.mock.method(globalThis, 'fetch', fake.fetch);
  const { revision } = await readManagement('/library');
  const response = await worker.fetch(managementRequest('/library', libraryForm(revision, nestedSeries(), [{ id: 'notes', seriesId: 'policy', date: '2026-09-15' }])), env);
  assert.equal(response.status, 200); assert.deepEqual(fake.manifest().series, nestedSeries());
  assert.equal(fake.manifest().albums[0].seriesId, 'policy'); assert.equal(fake.manifest().albums[0].date, '2026-09-15');
  assert.deepEqual(fake.manifest().albums[0].images, editFixture().albums[0].images);
  assert.equal(fake.calls.filter(call => call.path === '/git/blobs').length, 0);
  const next = await readManagement('/library');
  assert.equal((await worker.fetch(managementRequest('/library', libraryForm(next.revision, nestedSeries(), [{ id: 'notes', seriesId: '', date: '2026-08-12' }])), env)).status, 200);
  assert.equal(fake.manifest().albums[0].seriesId, undefined); assert.equal(fake.manifest().albums[0].date, '2026-08-12');
});
test('cycles, dangling parents, dropped albums, invalid dates and stale library changes are rejected', async t => {
  const fake = fakeGit({ initialManifest: editFixture() }); t.mock.method(globalThis, 'fetch', fake.fetch);
  const { revision } = await readManagement('/library');
  const placement = [{ id: 'notes', seriesId: '', date: '2026-09-15' }];
  for (const [series, placements] of [
    [[{ id: 'a', title: 'A', parentId: 'a' }], placement],
    [[{ id: 'a', title: 'A', parentId: 'b' }, { id: 'b', title: 'B', parentId: 'a' }], placement],
    [[{ id: 'a', title: 'A', parentId: 'missing' }], placement],
    [[], []], [[], [{ ...placement[0], seriesId: 'missing' }]], [[], [{ ...placement[0], date: '' }]],
  ]) assert.equal((await worker.fetch(managementRequest('/library', libraryForm(revision, series, placements)), env)).status, 400);
  assert.equal((await worker.fetch(managementRequest('/library', libraryForm('0'.repeat(64), [], placement)), env)).status, 409);
  assert.ok(fake.calls.every(call => call.method === 'GET'));
});
test('library retries preserve concurrent image edits and lost responses are idempotent', async t => {
  const fake = fakeGit({ initialManifest: editFixture(), conflicts: 1, loseResponse: true, concurrentChange: manifest => {
    manifest.albums[0].images.reverse(); return manifest;
  } }); t.mock.method(globalThis, 'fetch', fake.fetch);
  const { revision } = await readManagement('/library'), id = crypto.randomUUID();
  const placements = [{ id: 'notes', seriesId: 'policy', date: '2026-09-15' }];
  assert.equal((await worker.fetch(managementRequest('/library', libraryForm(revision, nestedSeries(), placements, id)), env)).status, 502);
  assert.deepEqual(fake.manifest().albums[0].images, editFixture().albums[0].images.toReversed());
  const count = fake.calls.length;
  assert.equal((await worker.fetch(managementRequest('/library', libraryForm(revision, nestedSeries(), placements, id)), env)).status, 200);
  assert.ok(fake.calls.slice(count).every(call => call.method === 'GET'));
});
test('new series albums need no date and can subsequently append images', async t => {
  const initial = editFixture(); initial.series = nestedSeries();
  const fake = fakeGit({ initialManifest: initial }); t.mock.method(globalThis, 'fetch', fake.fetch);
  const form = new FormData(); form.set('title', '货币政策笔记'); form.set('seriesId', 'policy'); form.set('requestId', crypto.randomUUID());
  form.append('images', new File([png], 'note.png', { type: 'image/png' }));
  const response = await worker.fetch(managementRequest('/albums', form), env); assert.equal(response.status, 201);
  const { album } = await response.json(); assert.equal(album.date, undefined); assert.equal(album.seriesId, 'policy');
  assert.match(album.images[0].src, /^\.\/images\/series\//);
  const { revision } = await readManagement(`/albums/${album.id}`);
  assert.equal((await worker.fetch(managementRequest(`/albums/${album.id}`, editForm(revision, [{ existing: 0 }, { file: 0 }], 1)), env)).status, 200);
});

test('manual order and parent changes persist without changing image order or dropping sibling series', async t => {
  const initial = editFixture(); initial.series = nestedSeries();
  initial.series.push({ id: 'micro', title: '微观经济学', parentId: 'economics' });
  initial.albums.push({ ...structuredClone(initial.albums[0]), id: 'second', seriesId: 'macro' });
  initial.albums[0].seriesId = 'macro';
  const fake = fakeGit({ initialManifest: initial }); t.mock.method(globalThis, 'fetch', fake.fetch);
  const { revision } = await readManagement('/library');
  const series = [initial.series[0], initial.series[3], initial.series[1], { ...initial.series[2], parentId: 'micro' }];
  const placements = [{ id: 'second', seriesId: 'macro', date: '2026-09-15' }, { id: 'notes', seriesId: 'macro', date: '2026-09-15' }];
  assert.equal((await worker.fetch(managementRequest('/library', libraryForm(revision, series, placements)), env)).status, 200);
  assert.deepEqual(fake.manifest().albums.map(item => item.id), ['second', 'notes']);
  assert.deepEqual(fake.manifest().series.filter(item => item.parentId === 'economics').map(item => item.id), ['micro', 'macro']);
  assert.equal(fake.manifest().series.find(item => item.id === 'policy').parentId, 'micro');
  assert.deepEqual(fake.manifest().albums[0].images, initial.albums[0].images);
  const next = await readManagement('/library');
  assert.equal((await worker.fetch(managementRequest('/library', libraryForm(next.revision, series.slice(1), placements)), env)).status, 400);
});
test('editing cannot exceed 30 images and series destinations must exist', async t => {
  const initial = editFixture(); initial.albums[0].images = Array.from({ length: 30 }, () => ({ ...initial.albums[0].images[0] }));
  const fake = fakeGit({ initialManifest: initial }); t.mock.method(globalThis, 'fetch', fake.fetch);
  const { revision } = await readManagement('/albums/notes');
  const order = [...Array.from({ length: 30 }, (_, existing) => ({ existing })), { file: 0 }];
  assert.equal((await worker.fetch(managementRequest('/albums/notes', editForm(revision, order, 1)), env)).status, 400);
  const form = new FormData(); form.set('title', '图集'); form.set('seriesId', 'missing'); form.set('requestId', crypto.randomUUID());
  form.append('images', new File([png], 'note.png', { type: 'image/png' }));
  assert.equal((await worker.fetch(managementRequest('/albums', form), env)).status, 400);
  assert.ok(fake.calls.every(call => call.method === 'GET'));
});
