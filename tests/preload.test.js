import test from 'node:test';
import assert from 'node:assert/strict';
import { createImagePreloader } from '../assets/preload.js';

const images = Array.from({ length: 26 }, (_, index) => ({ src: `https://example.com/${index + 1}.png` }));
const settle = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  const created = [];
  const loader = createImagePreloader(() => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    const image = { decode: () => promise, finish: resolve, fail: reject,
      removeAttribute(name) { if (name === 'src') this.cancelled = true; } };
    created.push(image); return image;
  });
  return { loader, created, sources: () => created.map(image => image.src) };
}

test('preloading waits for the current original to decode, then loads next two and previous serially', async () => {
  const { loader, created, sources } = setup();
  const current = loader.select(images, 2);
  assert.deepEqual(sources(), [images[2].src]);
  assert.equal(current.image.fetchPriority, 'high'); assert.equal(current.ready, false);
  current.image.finish(); await settle();
  assert.equal(current.ready, true);
  assert.deepEqual(sources(), [images[2].src, images[3].src]);
  assert.equal(created[1].fetchPriority, 'low');
  created[1].finish(); await settle();
  assert.deepEqual(sources(), [images[2].src, images[3].src, images[4].src]);
  created[2].finish(); await settle(); created[3].finish(); await settle();
  assert.deepEqual(sources(), [images[2].src, images[3].src, images[4].src, images[1].src]);
  loader.clear();
});

test('turning to a decoded neighbor reuses the image immediately without resetting its source', async () => {
  const { loader, created } = setup();
  loader.select(images, 0).image.finish(); await settle();
  const next = created[1]; next.finish(); await settle();
  const selected = loader.select(images, 1);
  assert.equal(selected.image, next); assert.equal(selected.ready, true);
  assert.equal(created.filter(image => image.src === images[1].src).length, 1);
  assert.equal(selected.image.fetchPriority, 'high'); loader.clear();
});

test('turning before preload completes promotes the same request and waits before loading more', async () => {
  const { loader, created } = setup();
  loader.select(images, 0).image.finish(); await settle();
  const next = created[1];
  const selected = loader.select(images, 1);
  assert.equal(selected.image, next); assert.equal(selected.ready, false);
  assert.equal(next.fetchPriority, 'high'); assert.equal(created.length, 2);
  next.finish(); await settle();
  assert.equal(created.length, 3); assert.equal(created[2].src, images[2].src); loader.clear();
});

test('jumping elsewhere cancels obsolete loads and a late completion does not fetch their neighbors', async () => {
  const { loader, created, sources } = setup();
  const first = loader.select(images, 0);
  const jumped = loader.select(images, 12);
  assert.equal(first.image.cancelled, true);
  first.image.finish(); await settle();
  assert.equal(await first.promise, false); assert.equal(created.length, 2);
  jumped.image.finish(); await settle();
  assert.deepEqual(sources(), [images[0].src, images[12].src, images[13].src]); loader.clear();
});

test('closing cancels the background request and prevents later downloads', async () => {
  const { loader, created } = setup();
  loader.select(images, 0).image.finish(); await settle();
  const pending = created[1]; loader.clear();
  assert.equal(pending.cancelled, true);
  pending.finish(); await settle(); assert.equal(created.length, 2);
  const reopened = loader.select(images, 0);
  assert.notEqual(reopened.image, created[0]); loader.clear();
});

test('decoded images outside the four-page window are released', async () => {
  const { loader, created } = setup();
  const old = loader.select(images, 0);
  for (let index = 0; index < 3; index++) { created[index].finish(); await settle(); }
  loader.select(images, 2);
  assert.notEqual(loader.select(images, 0), old, 'page one is outside the window centered on page three');
  loader.clear();
});

test('background failures do not loop and are retried when that page is selected', async () => {
  const { loader, created } = setup();
  loader.select(images, 0).image.finish(); await settle();
  created[1].fail(new Error('Network failure')); await settle();
  assert.equal(created.length, 3); assert.equal(created[2].src, images[2].src);
  created[2].finish(); await settle(); assert.equal(created.length, 3);
  const retried = loader.select(images, 1);
  assert.notEqual(retried.image, created[1]); assert.equal(retried.image.fetchPriority, 'high');
  retried.image.finish(); assert.equal(await retried.promise, true); loader.clear();
});

test('failed foreground images can be retried without an unhandled rejection', async () => {
  const { loader, created } = setup();
  const failed = loader.select(images, 0); failed.image.fail(new Error('Decode failure'));
  assert.equal(await failed.promise, false); assert.equal(created.length, 1);
  const retried = loader.select(images, 0);
  assert.notEqual(retried.image, failed.image); retried.image.finish();
  assert.equal(await retried.promise, true); loader.clear();
});

test('single images and repeated image URLs never request nonexistent or duplicate neighbors', async () => {
  for (const album of [[images[0]], Array(4).fill(images[0])]) {
    const { loader, created } = setup();
    loader.select(album, 0).image.finish(); await settle();
    assert.equal(created.length, 1); loader.clear();
  }
});
