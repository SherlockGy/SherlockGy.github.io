import test from 'node:test';
import assert from 'node:assert/strict';
import { createScrollReader, readingPage } from '../assets/reader.js';

test('continuous reading tracks the visible page when scrolling down and back up', () => {
  const rects = offset => [0, 1, 2].map(index => ({ index, top: 26 + index * 901 - offset, bottom: 890 + index * 901 - offset }));
  assert.deepEqual([0, 500, 750, 600, 500, 0].map(offset => readingPage(rects(offset), 700)), [0, 0, 1, 0, 0, 0]);
  assert.equal(readingPage([], 700), undefined);
  assert.equal(readingPage([{ index: 1, top: 100, bottom: 200 }], 700), 1);
});

function setup(t) {
  const originals = Object.fromEntries(['requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver'].map(key => [key, globalThis[key]]));
  let frame;
  globalThis.requestAnimationFrame = callback => { frame = callback; return 1; };
  globalThis.cancelAnimationFrame = () => { frame = undefined; };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  const alignments = [], selected = [], loads = [];
  const figures = [0, 1, 2].map(index => {
    const ready = {};
    ready.promise = new Promise((resolve, reject) => { ready.resolve = resolve; ready.reject = reject; }); loads.push(ready);
    const image = { loading: 'lazy', decode: () => ready.promise, hasAttribute: () => false };
    return { querySelector: () => image, scrollIntoView: () => alignments.push(index),
      getBoundingClientRect: () => ({ top: 20 + index * 900, bottom: 900 + index * 900 }) };
  });
  const stage = new EventTarget();
  Object.assign(stage, { scrollTop: 0, clientHeight: 700, scrollHeight: 2700,
    querySelectorAll: () => figures, getBoundingClientRect: () => ({ top: 0 }) });
  const reader = createScrollReader(stage, index => selected.push(index));
  t.after(() => {
    reader.disconnect();
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  return { reader, stage, figures, loads, alignments, selected, flush: () => { const callback = frame; frame = undefined; callback?.(); } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('jumping waits for preceding images without dimensions before final alignment', async t => {
  const { reader, figures, loads, alignments } = setup(t);
  reader.goTo(2);
  assert.deepEqual(alignments, [2]);
  assert.ok(figures.every(figure => figure.querySelector().loading === 'eager'));
  loads[2].resolve(); await settle();
  assert.deepEqual(alignments, [2]);
  loads[0].resolve(); loads[1].reject(new Error('Missing image')); await settle();
  assert.deepEqual(alignments, [2, 2], 'failed images must not prevent positioning');
});

test('user scrolling cancels delayed navigation without pulling the reader back', async t => {
  const { reader, stage, loads, alignments, selected, flush } = setup(t);
  reader.goTo(2); stage.dispatchEvent(new Event('wheel')); flush();
  loads.forEach(load => load.resolve()); await settle();
  assert.deepEqual(alignments, [2]); assert.deepEqual(selected, [0]);
});

test('pages with known dimensions retain lazy loading when jumping ahead', async t => {
  const { reader, figures, alignments } = setup(t);
  figures.forEach(figure => { figure.querySelector().hasAttribute = () => true; });
  reader.goTo(2); await settle();
  assert.ok(figures.every(figure => figure.querySelector().loading === 'lazy'));
  assert.deepEqual(alignments, [2, 2]);
});

test('a newer page selection replaces any pending alignment', async t => {
  const { reader, loads, alignments } = setup(t);
  reader.goTo(2); reader.goTo(1);
  loads.forEach(load => load.resolve()); await settle();
  assert.deepEqual(alignments, [2, 1, 1]);
});

test('closing the reader cancels alignment and detaches its scroll handling', async t => {
  const { reader, stage, loads, alignments, selected, flush } = setup(t);
  reader.goTo(2); reader.disconnect();
  loads.forEach(load => load.resolve()); await settle();
  stage.dispatchEvent(new Event('scroll')); flush();
  assert.deepEqual(alignments, [2]); assert.deepEqual(selected, []);
});
