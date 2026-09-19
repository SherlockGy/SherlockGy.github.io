import test from 'node:test';
import assert from 'node:assert/strict';
import { createReaderDirectory } from '../assets/reader-directory.js';

function setup(t) {
  const originalDocument = globalThis.document, originalObserver = globalThis.ResizeObserver;
  const document = { activeElement: null };
  class Element extends EventTarget {
    constructor(tag) {
      super(); this.tagName = tag; this.children = []; this.attributes = new Map();
      this.scrollTop = 0; this.clientHeight = 250; this.offsetHeight = 100;
    }
    append(...children) { children.forEach(child => { child.parent = this; this.children.push(child); }); }
    replaceChildren() { this.children.forEach(child => { child.parent = null; }); this.children = []; }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); delete this[name]; }
    contains(element) { return element === this || this.children.some(child => child.contains(element)); }
    focus() { document.activeElement = this; }
    getBoundingClientRect() {
      return { top: this.parent ? this.parent.children.indexOf(this) * this.offsetHeight - this.parent.scrollTop : 0 };
    }
  }
  document.createElement = tag => new Element(tag);
  globalThis.document = document;
  globalThis.ResizeObserver = class { observe() {} };
  t.after(() => {
    if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
    if (originalObserver === undefined) delete globalThis.ResizeObserver; else globalThis.ResizeObserver = originalObserver;
  });
  const list = document.createElement('nav');
  const album = { images: Array.from({ length: 30 }, (_, index) => ({
    src: `https://example.test/original-${index}.png`,
    thumbnails: [{ src: `https://example.test/thumbnail-${index}.webp`, width: 480, height: 270 }],
  })) };
  const selected = [];
  const directory = createReaderDirectory(list, page => { selected.push(page); directory.show(album, page); });
  const key = (value, modifiers = {}) => {
    const event = new Event('keydown', { cancelable: true });
    Object.assign(event, { key: value, ...modifiers }); list.dispatchEvent(event); return event;
  };
  return { list, album, document, directory, key, selected };
}

test('目录跳到末页后焦点同步，Tab 只停留在当前图片', t => {
  const { list, album, document, directory, key, selected } = setup(t);
  directory.show(album, 3); list.children[3].focus();
  assert.equal(key('End').defaultPrevented, true);
  assert.deepEqual(selected, [29]);
  assert.equal(document.activeElement, list.children[29]);
  assert.deepEqual(list.children.filter(button => button.tabIndex === 0), [list.children[29]]);
  assert.equal(list.scrollTop, 2750);
  key('ArrowUp'); assert.equal(document.activeElement, list.children[28]);
  key('Home'); key('ArrowUp'); assert.equal(document.activeElement, list.children[0]);
  const count = selected.length;
  assert.equal(key('ArrowDown', { metaKey: true }).defaultPrevented, false);
  assert.equal(selected.length, count);
});

test('翻页不重复创建目录，外部控件的焦点保持不变', t => {
  const { list, album, document, directory } = setup(t);
  directory.show(album, 0);
  const first = list.children[0], outside = document.createElement('button');
  outside.focus(); directory.show(album, 20);
  assert.equal(list.children[0], first);
  assert.equal(document.activeElement, outside);
  assert.equal(first.tabIndex, -1);
  assert.equal(list.children[20].attributes.get('aria-current'), 'page');
});

test('阅读区交还焦点时定位当前页，关闭目录后不抢占其他控件', t => {
  const { list, album, document, directory } = setup(t);
  const outside = document.createElement('button');
  directory.show(album, 8); outside.focus();
  directory.focusCurrent();
  assert.equal(document.activeElement, list.children[8]);
  directory.show(album, 9);
  assert.equal(document.activeElement, list.children[9]);
  directory.clear(); outside.focus(); directory.focusCurrent();
  assert.equal(document.activeElement, outside);
});

test('关闭或切换图集后取消缩略图来源，迟到的错误不再回退原图', t => {
  const { list, album, directory } = setup(t);
  directory.show(album, 0);
  const firstImage = list.children[0].children[0].children[0];
  const oldImage = list.children[1].children[0].children[0];
  firstImage.dispatchEvent(new Event('error'));
  assert.equal(firstImage.src, album.images[0].src, '目录打开时仍允许缩略图失败后回退原图');
  directory.clear();
  assert.equal(list.children.length, 0); assert.equal(list.hidden, true);
  oldImage.dispatchEvent(new Event('error'));
  assert.equal(oldImage.src, undefined); assert.equal(oldImage.srcset, undefined);
  directory.show(album, 0);
  const replacedImage = list.children[0].children[0].children[0];
  directory.show({ images: [album.images[3]] }, 0);
  replacedImage.dispatchEvent(new Event('error'));
  assert.equal(replacedImage.src, undefined);
  assert.equal(list.children.length, 1);
});

test('预览及回退原图均失败时显示明确提示，仍可点击跳页', t => {
  const { list, album, directory, selected } = setup(t);
  directory.show(album, 0);
  const button = list.children[1], preview = button.children[0];
  const [image, unavailable] = preview.children;
  assert.equal(unavailable.hidden, true);
  image.dispatchEvent(new Event('error'));
  assert.equal(unavailable.hidden, true, '回退原图尚未失败时不提前显示错误');
  image.dispatchEvent(new Event('error'));
  assert.equal(unavailable.hidden, false);
  assert.equal(unavailable.textContent, '预览不可用');
  assert.equal(image.hidden, true);
  button.dispatchEvent(new Event('click'));
  assert.deepEqual(selected, [1]);
  assert.equal(button.attributes.get('aria-current'), 'page');
});
