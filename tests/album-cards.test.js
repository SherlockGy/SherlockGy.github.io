import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../assets/app.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('function renderCards('), source.indexOf('\nfunction route()'));

function node(tag, className = '', textContent = '') {
  return { tag, className, textContent, children: [], attrs: {},
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this.attrs[name] = value; },
  };
}
function descendants(root) { return [root, ...root.children.flatMap(descendants)]; }
function render(album, view = album.seriesId ? 'series' : 'archive') {
  const calls = [];
  const context = {
    state: { view, albums: [album], series: [{ id: 'ai', title: '所属系列名称' }] },
    matchMedia: () => ({ matches: false }), el: node,
    icon: name => node('svg', name),
    document: { createTextNode: text => node('#text', '', text) },
    configureCoverImage: image => image,
    contextMenu: (label, actions) => Object.assign(node('details', 'context-menu'), { label, actions }),
    imageEditor: { open: (...args) => calls.push(['edit', ...args]) },
    seriesActions: { open: action => calls.push(['move', action]) },
  };
  vm.createContext(context); vm.runInContext(code, context);
  const grid = node('div', 'album-grid'); context.renderCards(grid, [album]);
  const card = grid.children[0], meta = card.children.find(item => item.className === 'card-meta');
  return { card, meta, nodes: descendants(card), calls };
}
const album = overrides => ({ id: 'example', title: '图集标题', description: '', date: '2026-11-06',
  seriesId: '', tags: ['保留标签', '第二标签'], images: [{ src: './example.png' }], ...overrides });

test('series cards omit the series name and date while retaining the first tag, count, and actions', () => {
  const { card, meta, nodes, calls } = render(album({ seriesId: 'ai', date: '' }));
  assert.equal(nodes.filter(item => item.className === 'card-series').length, 0);
  assert.equal(nodes.filter(item => item.tag === 'time').length, 0);
  assert.equal(nodes.some(item => item.textContent === '所属系列名称'), false);
  assert.deepEqual(meta.children.map(item => item.className), ['tag', 'image-badge', 'context-menu']);
  assert.equal(meta.children[0].textContent, '保留标签');
  assert.equal(descendants(meta.children[1]).at(-1).textContent, '1 张');
  assert.equal(card.children[0].href, '#/album/example/1');
  const menu = meta.children[2];
  assert.equal(menu.label, '图集操作：图集标题');
  assert.deepEqual(Array.from(menu.actions, action => action[0]), ['编辑图集', '移动到…']);
  menu.actions[0][1](); menu.actions[1][1]();
  assert.equal(calls[0][0], 'edit'); assert.equal(calls[0][1], 'example');
  assert.equal(calls[1][1].seriesId, 'ai');
});

test('monthly cards keep their date, first tag, and image count', () => {
  const { meta, nodes } = render(album({}));
  assert.deepEqual(meta.children.map(item => item.tag), ['time', 'span', 'span']);
  assert.equal(meta.children[0].textContent, '2026.11.06');
  assert.equal(meta.children[0].dateTime, '2026-11-06');
  assert.equal(meta.children[1].textContent, '保留标签');
  assert.equal(nodes.filter(item => item.className === 'tag').length, 1);
  assert.equal(nodes.some(item => item.textContent === '第二标签'), false);
});

test('untagged cards do not add an empty tag or series fallback', () => {
  for (const seriesId of ['', 'ai', 'unknown']) {
    const { meta, nodes } = render(album({ seriesId, tags: [] }));
    assert.equal(nodes.filter(item => item.className === 'tag' || item.className === 'card-series').length, 0);
    assert.equal(nodes.some(item => item.textContent === '系列图集'), false);
    assert.equal(meta.children.length, 2);
  }
});

test('series search cards share the same metadata and preserve document links and multiple-image counts', () => {
  const { card, meta } = render(album({ seriesId: 'ai', document: { type: 'document' }, images: [{}, {}] }), 'series');
  assert.equal(card.children[0].href, '#/album/example');
  assert.equal(descendants(meta).find(item => item.tag === '#text').textContent, '2 张');
  assert.equal(meta.children[0].textContent, '保留标签');
  assert.ok(source.includes('renderCards(grid, filtered)'));
  assert.ok(source.includes('renderCards(grid, albums, renderedCards)'));
});
