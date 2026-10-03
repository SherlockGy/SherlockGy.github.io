import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlbumExport } from '../assets/export.js';

function setup(t) {
  const originals = { document: globalThis.document, fetch: globalThis.fetch };
  const controls = new Map();
  class Element extends EventTarget {
    constructor() { super(); this.value = ''; this.open = false; this.hidden = false; this.isConnected = true; }
    querySelector(selector) { return controls.get(selector); }
    setAttribute(name, value) { this[name] = value; }
    removeAttribute(name) { delete this[name]; }
    getClientRects() { return [1]; }
    focus() { globalThis.document.activeElement = this; }
    showModal() { this.open = true; }
    close() {
      this.open = false;
      queueMicrotask(() => this.dispatchEvent(new Event('close')));
    }
  }
  for (const name of ['form', '#export-password', '#export-format', '#export-submit', '#export-status', '#export-download',
    '#export-cancel', '#export-close', '#export-format-note', '#export-album-name']) controls.set(name, new Element());
  const dialog = new Element(), opener = new Element();
  globalThis.document = { querySelector: () => dialog, activeElement: opener };
  t.after(() => {
    ui.close();
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  const ui = createAlbumExport(() => {});
  const album = { id: 'export-review', title: '下载流程测试', images: [{ src: 'https://example.test/1.png' }] };
  return { ui, album, dialog, control: selector => controls.get(selector),
    submit: () => controls.get('form').dispatchEvent(new Event('submit', { cancelable: true })) };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('关闭后立即重开，旧关闭事件不会清空新下载会话', async t => {
  const { ui, album, dialog, control, submit } = setup(t);
  let requests = 0;
  globalThis.fetch = async () => { requests++; return Response.json({ error: { message: '口令不正确' } }, { status: 401 }); };
  ui.open(album); ui.close(); ui.open(album);
  await settle();
  control('#export-password').value = 'test-only'; submit(); await settle();
  assert.equal(dialog.open, true);
  assert.equal(requests, 1);
  assert.equal(control('#export-status').textContent, '口令不正确');
});

test('取消后立即重试，旧响应不能覆盖新请求或关闭新请求的状态', async t => {
  const { ui, album, control, submit } = setup(t);
  const pending = [];
  globalThis.fetch = (url, options) => new Promise(resolve => pending.push({ resolve, signal: options.signal }));
  ui.open(album); control('#export-password').value = 'test-only'; submit();
  control('#export-cancel').dispatchEvent(new Event('click'));
  assert.equal(pending[0].signal.aborted, true);
  submit();
  pending[0].resolve(Response.json({ status: 'readable' })); await settle();
  assert.equal(control('#export-submit').disabled, true);
  assert.equal(pending[1].signal.aborted, false);
  pending[1].resolve(Response.json({ error: { message: '新请求口令错误' } }, { status: 401 })); await settle();
  assert.equal(control('#export-status').textContent, '新请求口令错误');
  assert.equal(control('#export-submit').disabled, false);
});
