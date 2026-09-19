import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/worker.js';
import { createUploadClient } from '../assets/upload.js';

const env = { GITHUB_TOKEN: 'test-token-not-a-real-secret', UPLOAD_PASSWORD: 'test-password-not-a-real-secret' };
const origin = 'https://sherlockgy.github.io';
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6Z9sAAAAASUVORK5CYII=', 'base64'));
let ip = 0;
const isRead = call => call.method === 'GET' || call.path === '/graphql';
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
    assert.ok(target.pathname === '/graphql' || target.pathname.startsWith('/repos/SherlockGy/SherlockGy.github.io/'));
    assert.equal(options.headers.Authorization, `Bearer ${env.GITHUB_TOKEN}`);
    assert.equal(options.redirect, 'manual', 'Workers GitHub requests must inspect redirects without following them');
    const path = target.pathname.replace('/repos/SherlockGy/SherlockGy.github.io', '');
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, method: options.method, body });
    const ok = value => Response.json(value);
    if (path === '/graphql') {
      assert.match(body.query, /^query AtlasSnapshot/);
      assert.deepEqual(body.variables, { owner: 'SherlockGy', name: 'SherlockGy.github.io', ref: 'refs/heads/master', path: 'data/albums.json' });
      const value = commits.get(head);
      return ok({ data: { repository: { ref: { target: { oid: head, tree: { oid: value.tree },
        file: { object: { text: JSON.stringify(value.manifest), isTruncated: false } } } } } } });
    }
    if (path === '/git/ref/heads/master') return ok({ object: { sha: head } });
    if (path.startsWith('/git/commits/') && options.method === 'GET') return ok({ tree: { sha: commits.get(path.split('/').pop()).tree } });
    if (path === '/contents/data/albums.json') return ok(commits.get(target.searchParams.get('ref')).manifest);
    if (path === '/git/blobs') { assert.equal(body.encoding, 'base64'); return ok({ sha: (++serial).toString(16).padStart(40, '0') }); }
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
  assert.equal(fake.calls.length, 42);
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
  assert.equal(result.version, '2026-09-19-description-1'); assert.ok(result.traceId);
  assert.equal(fake.calls.length, 1); assert.ok(fake.calls.every(isRead));
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
  assert.equal(data.error.stage, '读取仓库快照'); assert.equal(data.error.errorName, 'TypeError');
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
  assert.equal(timeoutData.error.stage, '读取仓库快照');
});

test('GitHub HTTP errors, invalid JSON and malformed tokens are not reported as timeouts', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ message: 'Bad credentials' }, { status: 401 }));
  const denied = await worker.fetch(checkRequest(), env);
  assert.equal(denied.status, 502);
  const data = await denied.json();
  assert.equal(data.error.code, 'GITHUB_ERROR'); assert.equal(data.error.httpStatus, 401);
  assert.equal(data.error.stage, '读取仓库快照');
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
    assert.equal(result.error.stage, '读取仓库快照'); assert.equal(result.error.httpStatus, status);
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
  assert.ok(fake.calls.every(isRead));
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
  assert.ok(fake.calls.every(isRead));
});
test('lost edit responses can be retried even after a later edit without duplicating images', async t => {
  const fake = fakeGit({ initialManifest: editFixture(), loseResponse: true }); t.mock.method(globalThis, 'fetch', fake.fetch);
  const { revision } = await readManagement('/albums/notes'), id = crypto.randomUUID();
  const order = [{ existing: 0 }, { existing: 1 }, { file: 0 }];
  assert.equal((await worker.fetch(managementRequest('/albums/notes', editForm(revision, order, 1, id)), env)).status, 502);
  const next = await readManagement('/albums/notes');
  assert.equal((await worker.fetch(managementRequest('/albums/notes', editForm(next.revision, [{ existing: 2 }, { existing: 0 }, { existing: 1 }])), env)).status, 200);
  const before = fake.calls.filter(call => call.method === 'POST' && !isRead(call)).length;
  assert.equal((await worker.fetch(managementRequest('/albums/notes', editForm(revision, order, 1, id)), env)).status, 200);
  assert.equal(fake.manifest().albums[0].images.length, 3);
  assert.equal(fake.calls.filter(call => call.method === 'POST' && !isRead(call)).length, before);
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
  assert.ok(fake.calls.every(isRead));
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
  assert.ok(fake.calls.slice(count).every(isRead));
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
  assert.ok(fake.calls.every(isRead));
});

function stagedRequest(id, index, bytes = png, scope = '/albums', address) {
  return new Request(`https://worker.test/uploads/${id}/${index}?scope=${encodeURIComponent(scope)}`, {
    method: 'POST', body: bytes, headers: { Origin: origin, Authorization: `Bearer ${env.UPLOAD_PASSWORD}`, 'CF-Connecting-IP': address || `192.0.2.${++ip}` },
  });
}
async function stage(id, index = 0, scope = '/albums', bytes = png) {
  const response = await worker.fetch(stagedRequest(id, index, bytes, scope), env);
  assert.equal(response.status, 201); return (await response.json()).receipt;
}
function finalForm(id, receipts) {
  const form = new FormData(); form.set('requestId', id); form.set('title', '流水图集'); form.set('date', '2026-09-17');
  form.set('receipts', JSON.stringify(receipts)); return form;
}
function browserFetch(intercept, runtime = env) {
  const address = `192.0.2.${++ip}`;
  return async (url, options) => {
    const request = new Request(url, { ...options, headers: { ...options.headers, Origin: origin, 'CF-Connecting-IP': address } });
    return intercept ? intercept(request, () => worker.fetch(request, runtime)) : worker.fetch(request, runtime);
  };
}
function browserForm(id, count = 3) {
  const form = new FormData(); form.set('requestId', id); form.set('title', '流水图集'); form.set('date', '2026-09-17');
  for (let index = 0; index < count; index++) form.append('images', new File([png], `${index}.png`, { type: 'image/png', lastModified: 1 }));
  return form;
}

test('staged images do not change the branch; signed receipts commit the complete ordered album once', async t => {
  const fake = fakeGit(); t.mock.method(globalThis, 'fetch', fake.fetch);
  const id = crypto.randomUUID();
  const second = await stage(id, 1), first = await stage(id, 0);
  assert.equal(fake.manifest().albums.length, 0);
  assert.ok(fake.calls.every(call => call.path === '/git/blobs'));
  const response = await worker.fetch(managementRequest('/albums', finalForm(id, [first, second])), env);
  assert.equal(response.status, 201);
  const entries = fake.calls.find(call => call.path === '/git/trees').body.tree;
  assert.equal(entries[0].sha, JSON.parse(first.data).sha); assert.equal(entries[1].sha, JSON.parse(second.data).sha);
  assert.equal(fake.calls.filter(call => call.path === '/git/blobs').length, 2);
  assert.equal(fake.calls.filter(call => call.path === '/git/refs/heads/master').length, 1);
  assert.equal(fake.manifest().albums[0].images.length, 2);
});

test('tampered, reordered, cross-draft, cross-album, expired and mixed receipts cannot write a branch', async t => {
  const fake = fakeGit(); t.mock.method(globalThis, 'fetch', fake.fetch);
  const id = crypto.randomUUID(), receipt = await stage(id), other = await stage(id, 1);
  const forged = { ...receipt, data: receipt.data.replace('"size":68', '"size":1') + ' ' };
  const invalidForms = [finalForm(id, [forged]), finalForm(id, [other, receipt]), finalForm(crypto.randomUUID(), [receipt]),
    finalForm(id, [await stage(id, 0, '/albums/notes')])];
  const mixed = finalForm(id, [receipt]); mixed.append('images', new File([png], 'extra.png')); invalidForms.push(mixed);
  for (const form of invalidForms) assert.equal((await worker.fetch(managementRequest('/albums', form), env)).status, 400);
  t.mock.method(Date, 'now', () => JSON.parse(receipt.data).expiresAt + 1);
  const expired = await worker.fetch(managementRequest('/albums', finalForm(id, [receipt])), env);
  assert.equal(expired.status, 409); assert.equal((await expired.json()).error.code, 'RECEIPT_EXPIRED');
  assert.ok(fake.calls.every(call => call.path === '/git/blobs'));
});

test('30 staged images from one browser do not exhaust the ordinary operation throttle', async t => {
  const fake = fakeGit(); t.mock.method(globalThis, 'fetch', fake.fetch);
  const address = `192.0.2.${++ip}`, id = crypto.randomUUID(), receipts = [];
  for (let index = 0; index < 30; index++) {
    const result = await worker.fetch(stagedRequest(id, index, png, '/albums', address), env);
    assert.equal(result.status, 201); receipts.push((await result.json()).receipt);
  }
  const form = finalForm(id, receipts);
  const response = await worker.fetch(new Request('https://worker.test/albums', { method: 'POST', body: form,
    headers: { Origin: origin, Authorization: `Bearer ${env.UPLOAD_PASSWORD}`, 'CF-Connecting-IP': address } }), env);
  assert.equal(response.status, 201); assert.equal(fake.manifest().albums[0].images.length, 30);
});

test('knowing the upload password cannot forge a receipt or a repository snapshot', async t => {
  const fake = fakeGit(); t.mock.method(globalThis, 'fetch', fake.fetch);
  const id = crypto.randomUUID(), receipt = await stage(id);
  const prepare = new FormData(); prepare.set('requestId', id); prepare.set('scope', '/albums');
  const { snapshot } = await (await worker.fetch(managementRequest('/uploads/prepare', prepare), env)).json();
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`atlas-upload-receipt-v1\nSherlockGy/SherlockGy.github.io\n${env.UPLOAD_PASSWORD}`),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const forge = async original => ({ ...original, signature: Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(original.data))).toString('hex') });
  const forgedFile = finalForm(id, [await forge(receipt)]);
  assert.equal((await worker.fetch(managementRequest('/albums', forgedFile), env)).status, 400);
  const forgedSnapshot = finalForm(id, [receipt]); forgedSnapshot.set('snapshot', JSON.stringify(await forge(snapshot)));
  assert.equal((await worker.fetch(managementRequest('/albums', forgedSnapshot), env)).status, 400);
  assert.ok(!fake.calls.some(call => call.path === '/git/trees'));
  assert.equal(fake.manifest().albums.length, 0);
});

test('staging enforces raw byte limits and finalization rejects excessive signed totals before committing', async t => {
  const fake = fakeGit(); t.mock.method(globalThis, 'fetch', fake.fetch);
  const id = crypto.randomUUID(), bytes = new Uint8Array(8 * 1024 * 1024), receipts = [];
  bytes.set(png);
  for (let index = 0; index < 4; index++) receipts.push(await stage(id, index, '/albums', bytes));
  const total = await worker.fetch(managementRequest('/albums', finalForm(id, receipts)), env);
  assert.equal(total.status, 413); assert.equal((await total.json()).error.code, 'TOO_LARGE');
  const oversized = await worker.fetch(stagedRequest(id, 4, new Uint8Array(10 * 1024 * 1024 + 1)), env);
  assert.equal(oversized.status, 413);
  const tooMany = await worker.fetch(managementRequest('/albums', finalForm(id, Array(31).fill(receipts[0]))), env);
  assert.equal(tooMany.status, 400); assert.equal((await tooMany.json()).error.code, 'FILE_COUNT');
  assert.equal(fake.calls.length, 4); assert.ok(fake.calls.every(call => call.path === '/git/blobs'));
});

test('browser and Worker overlap transfers and snapshot reads, then commit without rereading the snapshot', async t => {
  const fake = fakeGit(); let firstStarted;
  const started = new Promise(resolve => { firstStarted = resolve; });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (new URL(url).pathname === '/graphql') await started;
    return fake.fetch(url, options);
  });
  let releaseFirst, active = 0, peak = 0;
  const wait = new Promise(resolve => { releaseFirst = resolve; });
  const client = createUploadClient({ fetch: browserFetch(async (request, proceed) => {
    const path = new URL(request.url).pathname;
    if (!/^\/uploads\/[a-f0-9-]+\/\d+$/.test(path)) return proceed();
    firstStarted(); peak = Math.max(peak, ++active);
    try {
      if (path.endsWith('/0')) await wait;
      const result = await proceed();
      if (path.endsWith('/1')) releaseFirst();
      return result;
    } finally { active--; }
  }) });
  const result = await client.save({ endpoint: 'https://worker.test/albums', password: env.UPLOAD_PASSWORD, body: browserForm(crypto.randomUUID(), 5) });
  assert.equal(result.status, 'committed'); assert.equal(peak, 2);
  assert.equal(fake.calls.filter(call => call.path === '/graphql').length, 1);
  assert.equal(fake.calls.length, 9, '5 image writes + 1 read + 3 final writes');
  assert.deepEqual(fake.manifest().albums[0].images.map(item => item.src.split('/').pop()), ['001.png', '002.png', '003.png', '004.png', '005.png']);
});

test('partial transfer failure never commits; a rebuilt FormData retry reuses completed image receipts', async t => {
  const fake = fakeGit(); t.mock.method(globalThis, 'fetch', fake.fetch);
  let failSecond = true; const sent = [];
  const client = createUploadClient({ fetch: browserFetch(async (request, proceed) => {
    const path = new URL(request.url).pathname;
    if (/^\/uploads\/[a-f0-9-]+\/\d+$/.test(path)) {
      sent.push(path);
      if (path.endsWith('/1') && failSecond) { failSecond = false; throw new TypeError('connection failed'); }
    }
    return proceed();
  }) });
  const id = crypto.randomUUID(), save = () => client.save({ endpoint: 'https://worker.test/albums', password: env.UPLOAD_PASSWORD, body: browserForm(id) });
  await assert.rejects(save(), /原样重试/);
  assert.equal(fake.manifest().albums.length, 0); assert.ok(!fake.calls.some(call => call.path === '/git/commits'));
  await save();
  assert.equal(sent.filter(path => path.endsWith('/0')).length, 1);
  assert.equal(sent.filter(path => path.endsWith('/1')).length, 2);
  assert.equal(fake.manifest().albums.length, 1); assert.equal(fake.manifest().albums[0].images.length, 3);
});

test('a lost final response is confirmed by request ID without reuploading or creating a second commit', async t => {
  const fake = fakeGit({ loseResponse: true }); t.mock.method(globalThis, 'fetch', fake.fetch);
  const client = createUploadClient({ fetch: browserFetch() });
  const result = await client.save({ endpoint: 'https://worker.test/albums', password: env.UPLOAD_PASSWORD, body: browserForm(crypto.randomUUID()) });
  assert.equal(result.status, 'committed'); assert.equal(fake.manifest().albums.length, 1);
  assert.equal(fake.calls.filter(call => call.path === '/git/blobs').length, 3);
  assert.equal(fake.calls.filter(call => call.path === '/git/commits').length, 1);
});

test('staged edits retain revision checks, preserve concurrent changes and replace with new paths', async t => {
  const fake = fakeGit({ initialManifest: editFixture(), conflicts: 1, concurrentChange: manifest => { manifest.other = 'keep'; return manifest; } });
  t.mock.method(globalThis, 'fetch', fake.fetch);
  const { revision } = await readManagement('/albums/notes'), id = crypto.randomUUID();
  const receipt = await stage(id, 0, '/albums/notes');
  const form = editForm(revision, [{ file: 0, replaces: 1 }, { existing: 0 }], 0, id); form.set('receipts', JSON.stringify([receipt]));
  assert.equal((await worker.fetch(managementRequest('/albums/notes', form), env)).status, 200);
  assert.equal(fake.manifest().other, 'keep'); assert.equal(fake.manifest().albums[0].images[0].alt, '第二张');
  assert.equal(fake.calls.filter(call => call.path === '/git/blobs').length, 1);
});

test('signed snapshots reject client modifications and expired snapshots reload the latest branch', async t => {
  const fake = fakeGit(); t.mock.method(globalThis, 'fetch', fake.fetch);
  const id = crypto.randomUUID(), receipt = await stage(id);
  const prepare = new FormData(); prepare.set('requestId', id); prepare.set('scope', '/albums');
  const response = await worker.fetch(managementRequest('/uploads/prepare', prepare), env);
  const { snapshot } = await response.json();
  const tampered = finalForm(id, [receipt]); tampered.set('snapshot', JSON.stringify({ ...snapshot, data: snapshot.data + ' ' }));
  assert.equal((await worker.fetch(managementRequest('/albums', tampered), env)).status, 400);
  assert.equal(fake.manifest().albums.length, 0);
  t.mock.method(Date, 'now', () => JSON.parse(snapshot.data).expiresAt + 1);
  const valid = finalForm(id, [receipt]); valid.set('snapshot', JSON.stringify(snapshot));
  assert.equal((await worker.fetch(managementRequest('/albums', valid), env)).status, 201);
  assert.equal(fake.calls.filter(call => call.path === '/graphql').length, 2);
});

test('GraphQL partial or truncated snapshots stop writes; REST compatibility mode remains functional', async t => {
  const fake = fakeGit();
  const mock = t.mock.method(globalThis, 'fetch', async () => Response.json({ data: { repository: { ref: { target: { oid: 'head', tree: { oid: 'tree' }, file: { object: { text: '{}', isTruncated: true } } } } } } }));
  assert.equal((await worker.fetch(request(), env)).status, 502); assert.equal(mock.mock.callCount(), 1);
  t.mock.method(globalThis, 'fetch', fake.fetch);
  assert.equal((await worker.fetch(request(), { ...env, GITHUB_READ_MODE: 'rest' })).status, 201);
  assert.equal(fake.calls.filter(call => isRead(call)).length, 3); assert.ok(!fake.calls.some(call => call.path === '/graphql'));
});

test('upstream rate limits preserve retry timing and never advance the branch', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({}, { status: 403, headers: { 'Retry-After': '120' } }));
  const result = await worker.fetch(stagedRequest(crypto.randomUUID(), 0), env);
  assert.equal(result.status, 429);
  const data = await result.json(); assert.equal(data.error.code, 'GITHUB_RATE_LIMITED'); assert.equal(data.error.retryAfterSeconds, 120);
});

test('new album descriptions preserve long text up to the advertised limit', async t => {
  const fake = fakeGit(); t.mock.method(globalThis, 'fetch', fake.fetch);
  const health = await (await worker.fetch(new Request('https://worker.test/health'), env)).json();
  assert.equal(health.capabilities.maxDescriptionLength, 10000);
  const description = '参考资料\n'.repeat(1999) + '末'.repeat(5);
  assert.equal(description.length, 10000);
  const form = await request().formData(); form.set('description', description.trim());
  const response = await worker.fetch(managementRequest('/albums', form), env);
  assert.equal(response.status, 201);
  assert.equal(fake.manifest().albums[0].description, description.trim());
});

test('editing an imported long description supports appending, boundary length, clearing and omission', async t => {
  const initial = editFixture(); initial.albums[0].description = '文'.repeat(1737);
  const fake = fakeGit({ initialManifest: initial }); t.mock.method(globalThis, 'fetch', fake.fetch);
  for (const description of ['文'.repeat(1737) + '\n新增说明 https://example.com/source', '字'.repeat(10000), undefined, '']) {
    const current = await readManagement('/albums/notes');
    assert.equal(current.capabilities.maxDescriptionLength, 10000);
    const body = editForm(current.revision, [{ existing: 0 }, { existing: 1 }]);
    if (description !== undefined) body.set('description', description);
    const response = await worker.fetch(managementRequest('/albums/notes', body), env);
    assert.equal(response.status, 200);
    assert.equal(fake.manifest().albums[0].description, description ?? current.album.description);
    assert.deepEqual(fake.manifest().albums[0].images, initial.albums[0].images);
  }
  assert.equal(fake.calls.filter(call => call.path === '/git/blobs').length, 0);
});

test('oversized descriptions are rejected before any GitHub access on create and edit', async t => {
  const fake = fakeGit({ initialManifest: editFixture() }); t.mock.method(globalThis, 'fetch', fake.fetch);
  const create = await request().formData(); create.set('description', '字'.repeat(10001));
  const edit = editForm('a'.repeat(64), [{ existing: 0 }, { existing: 1 }]); edit.set('description', '字'.repeat(10001));
  for (const [path, form] of [['/albums', create], ['/albums/notes', edit]]) {
    const response = await worker.fetch(managementRequest(path, form), env);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_FIELD');
  }
  assert.equal(fake.calls.length, 0);
});

test('multiline requests committed before newline normalization remain safe to retry', async t => {
  const digest = async value => Buffer.from(await crypto.subtle.digest('SHA-256', value)).toString('hex');
  const description = '第一行\n第二行';
  const wireDescription = description.replaceAll('\n', '\r\n');
  const id = crypto.randomUUID();
  const uploadFingerprint = await digest(encoder.encode(JSON.stringify(['知识图集', '2026-09-15', wireDescription, [await digest(png)]])));
  const existing = { ...editFixture().albums[0], id: `album-${id}`, description: wireDescription, uploadFingerprint };
  let fake = fakeGit({ initialManifest: { schemaVersion: 1, albums: [existing] } });
  t.mock.method(globalThis, 'fetch', (...args) => fake.fetch(...args));
  const form = await request({ id }).formData(); form.set('description', description);
  const uploaded = await worker.fetch(managementRequest('/albums', form), env);
  assert.equal(uploaded.status, 201);
  assert.ok(fake.calls.every(isRead), 'Retry must not create another commit');
  const revision = 'a'.repeat(64), requestId = crypto.randomUUID(), order = [{ existing: 0 }, { existing: 1 }];
  const fingerprint = await digest(encoder.encode(JSON.stringify(['notes', revision, order, [], { description: wireDescription }])));
  const initial = editFixture(); initial.albums[0].description = wireDescription;
  initial.albums[0].editHistory = [{ requestId, fingerprint }];
  fake = fakeGit({ initialManifest: initial });
  const edit = editForm(revision, order, 0, requestId); edit.set('description', description);
  const edited = await worker.fetch(managementRequest('/albums/notes', edit), env);
  assert.equal(edited.status, 200);
  assert.ok(fake.calls.every(isRead), 'Edit retry must not write or fail on the old revision');
  edit.set('description', description + '不同内容');
  const changed = await worker.fetch(managementRequest('/albums/notes', edit), env);
  assert.equal(changed.status, 409);
  assert.equal((await changed.json()).error.code, 'REQUEST_REUSED');
});
