import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageWindow } from '../assets/preload.js';

const images = Array.from({ length: 26 }, (_, index) => ({ src: `https://example.com/${index + 1}.png` }));
function setup(album = images) {
  const mounted = new Map(), created = [], released = [];
  const window = createImageWindow(album, (index, entry) => {
    mounted.set(index, entry);
    return () => { released.push(index); mounted.delete(index); };
  }, () => {
    let finish, fail;
    const promise = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    const image = { decode: () => promise, finish, fail,
      removeAttribute(name) { if (name === 'src') delete this.src; } };
    created.push(image); return image;
  });
  return { window, mounted, created, released, pages: () => [...mounted.keys()].sort((a, b) => a - b) };
}

test('continuous reading requests the current original first and only two pages on each side', () => {
  const { window, created, pages } = setup();
  window.select(12);
  assert.deepEqual(pages(), [10, 11, 12, 13, 14]);
  assert.deepEqual(created.map(image => image.src), [12, 13, 11, 14, 10].map(index => images[index].src));
  assert.equal(created[0].fetchPriority, 'high');
  assert.ok(created.slice(1).every(image => image.fetchPriority === 'low'));
  window.clear();
});

test('scrolling retains overlapping images and releases originals leaving the window', async () => {
  const { window, mounted, created, released, pages } = setup();
  window.select(0);
  const old = mounted.get(0), next = mounted.get(1);
  old.image.finish(); assert.equal(await old.promise, true);
  window.select(1);
  assert.equal(mounted.get(1), next); assert.equal(next.image.fetchPriority, 'high');
  window.select(3);
  assert.deepEqual(pages(), [1, 2, 3, 4, 5]);
  assert.deepEqual(released, [0]); assert.equal(old.image.src, undefined);
  assert.equal(mounted.get(1), next);
  window.select(3); assert.equal(created.length, 6, 'repeated scroll events never restart requests');
  window.clear();
});

test('jumping directly to the last page skips intervening originals and cancels obsolete decoding', async () => {
  const { window, mounted, created, pages } = setup();
  window.select(0); const old = mounted.get(0);
  window.select(25);
  assert.deepEqual(pages(), [23, 24, 25]); assert.equal(created.length, 6);
  old.image.finish(); assert.equal(await old.promise, false);
  assert.equal(old.image.src, undefined);
  window.select(0); assert.notEqual(mounted.get(0), old, 'returning to a released page loads it again');
  window.clear();
});

test('a failed image stays failed until explicit retry and only that page is replaced', async () => {
  const { window, mounted, created } = setup();
  window.select(3);
  const failed = mounted.get(3), neighbor = mounted.get(4);
  failed.image.fail(new Error('Network failure'));
  assert.equal(await failed.promise, false);
  window.select(3); assert.equal(created.length, 5);
  window.retry(3);
  assert.equal(created.length, 6); assert.equal(mounted.get(4), neighbor);
  assert.equal(failed.image.src, undefined); assert.notEqual(mounted.get(3), failed);
  window.retry(25); assert.equal(created.length, 6, 'an evicted page cannot be retried by a stale control');
  window.clear();
});

test('closing releases every mounted source, including completed originals, and ignores late results', async () => {
  const { window, mounted, created } = setup();
  window.select(0);
  const entries = [...mounted.values()];
  entries[0].image.finish(); await entries[0].promise;
  window.clear(); window.clear();
  assert.equal(mounted.size, 0); assert.ok(created.every(image => image.src === undefined));
  entries[1].image.finish(); assert.equal(await entries[1].promise, false);
  assert.equal(created.length, 3);
});

test('single-image albums stay bounded and repeated URLs have separate DOM images', () => {
  const single = setup([images[0]]); single.window.select(0);
  assert.equal(single.created.length, 1); single.window.clear();
  const repeated = setup(Array(6).fill(images[0])); repeated.window.select(2);
  assert.equal(repeated.mounted.size, 5);
  assert.equal(new Set([...repeated.mounted.values()].map(entry => entry.image)).size, 5);
  repeated.window.clear();
});
