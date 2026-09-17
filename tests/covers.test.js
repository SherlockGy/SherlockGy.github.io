import test from 'node:test';
import assert from 'node:assert/strict';
import { configureCoverImage } from '../assets/covers.js';

function fakeImage() {
  const events = {}, changes = [], node = {
    addEventListener(name, listener) { events[name] = listener; },
    removeAttribute(name) { delete this[name]; changes.push(['remove', name]); },
    emit(name) { events[name](); },
  };
  return { changes, node: new Proxy(node, { set(target, name, value) { changes.push([name, value]); target[name] = value; return true; } }) };
}
const original = { src: 'https://example.com/original.png', width: 1448, height: 1086, thumbnails: [
  { src: 'https://example.com/480.webp', width: 480, height: 360 },
  { src: 'https://example.com/960.webp', width: 960, height: 720 },
] };

test('a cover offers responsive thumbnails before assigning src and never initially requests the original', () => {
  const { node, changes } = fakeImage();
  configureCoverImage(node, original, { eager: true, priority: true });
  assert.equal(node.loading, 'eager'); assert.equal(node.fetchPriority, 'high');
  assert.deepEqual(changes.filter(([key]) => key === 'src'), [['src', original.thumbnails[0].src]]);
  assert.ok(changes.findIndex(([key]) => key === 'srcset') < changes.findIndex(([key]) => key === 'src'));
  assert.equal(node.srcset, 'https://example.com/480.webp 480w, https://example.com/960.webp 960w');
  assert.equal(node.width, 480); assert.equal(node.height, 360);
});

test('a broken thumbnail falls back once, clears responsive candidates, and reports a broken original', () => {
  const { node } = fakeImage(); let failures = 0;
  configureCoverImage(node, original, { onError: () => failures++ });
  node.emit('error');
  assert.equal(node.src, original.src); assert.equal(node.srcset, undefined); assert.equal(node.sizes, undefined); assert.equal(failures, 0);
  node.emit('error'); assert.equal(failures, 1);
});

test('legacy/local preview images remain usable and later covers stay lazy', () => {
  const { node } = fakeImage();
  configureCoverImage(node, { src: 'blob:local-preview', width: 100, height: 200 });
  assert.equal(node.src, 'blob:local-preview'); assert.equal(node.srcset, undefined);
  assert.equal(node.loading, 'lazy'); assert.equal(node.fetchPriority, 'auto');
});
