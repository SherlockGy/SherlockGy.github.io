import test from 'node:test';
import assert from 'node:assert/strict';
import { fitImage, constrainPan, zoomAtPoint, createWheelPager } from '../assets/slideshow.js';

test('landscape, portrait and extreme aspect ratios fit entirely inside the viewing area', () => {
  for (const [width, height] of [[1672, 941], [800, 2400], [4000, 100], [100, 4000]]) {
    for (const [vw, vh] of [[1200, 800], [244, 640], [500, 300]]) {
      const fitted = fitImage(width, height, vw, vh);
      assert.ok(fitted.width <= vw - 24 + 1e-9 && fitted.height <= vh - 24 + 1e-9);
      assert.ok(Math.abs(fitted.width / fitted.height - width / height) < 1e-9);
      assert.ok(Math.abs(fitted.width - (vw - 24)) < 1e-9 || Math.abs(fitted.height - (vh - 24)) < 1e-9);
    }
  }
  assert.deepEqual(fitImage(0, 100, 800, 600), { width: 0, height: 0 });
});

test('drag boundaries allow at most half a viewport of blank space on every side at any scale', () => {
  const vw = 1200, vh = 800;
  for (const [width, height] of [[1100, 600], [300, 760], [3000, 2400], [100, 50]]) {
    const right = constrainPan(100000, 100000, width, height, vw, vh);
    const left = constrainPan(-100000, -100000, width, height, vw, vh);
    assert.equal(vw / 2 + right.x - width / 2, vw / 2);
    assert.equal(vh / 2 + right.y - height / 2, vh / 2);
    assert.equal(vw - (vw / 2 + left.x + width / 2), vw / 2);
    assert.equal(vh - (vh / 2 + left.y + height / 2), vh / 2);
    assert.deepEqual(constrainPan(0, 0, width, height, vw, vh), { x: 0, y: 0 });
  }
});

test('zoom keeps the point under the cursor fixed and enforces useful scale limits', () => {
  const view = { scale: 1.5, x: 40, y: -30 }, point = { x: 250, y: 120 };
  for (const scale of [.01, .75, 3, 100]) {
    const result = zoomAtPoint(view, scale, point);
    assert.ok(result.scale >= .25 && result.scale <= 8);
    assert.ok(Math.abs((point.x - view.x) / view.scale - (point.x - result.x) / result.scale) < 1e-9);
    assert.ok(Math.abs((point.y - view.y) / view.scale - (point.y - result.y) / result.scale) < 1e-9);
  }
});

test('one touchpad gesture including inertia turns one page, a pause or reversal starts another', () => {
  const pager = createWheelPager();
  assert.equal(pager.feed(10, 0), 0);
  assert.equal(pager.feed(15, 10), 0);
  assert.equal(pager.feed(15, 20), 1);
  for (let time = 30; time < 400; time += 10) assert.equal(pager.feed(80, time), 0);
  assert.equal(pager.feed(80, 600), 1);
  assert.equal(pager.feed(-80, 650), -1);
  pager.reset();
  assert.equal(pager.feed(80, 660), 1);
});
