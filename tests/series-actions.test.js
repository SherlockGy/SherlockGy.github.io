import test from 'node:test';
import assert from 'node:assert/strict';
import { applySeriesAction } from '../assets/series-model.js';
const fixture = () => ({ schemaVersion: 1, series: [
  { id: 'econ', title: '经济学', parentId: '' }, { id: 'macro', title: '宏观', parentId: 'econ' },
  { id: 'micro', title: '微观', parentId: 'econ' }, { id: 'policy', title: '政策', parentId: 'macro' },
  { id: 'code', title: '编程', parentId: '' },
], albums: [
  { id: 'month', title: '月份笔记', date: '2026-09-19' },
  { id: 'a', title: 'A', seriesId: 'macro' }, { id: 'b', title: 'B', seriesId: 'macro' },
  { id: 'c', title: 'C', seriesId: 'code' },
] });
test('contextual creation, rename and subtree moves preserve unrelated data and input', () => {
  const source = fixture(), original = structuredClone(source);
  const created = applySeriesAction(source, { type: 'create', id: 'new', title: '  利率  ', parentId: 'policy' });
  assert.deepEqual(created.series.at(-1), { id: 'new', title: '利率', parentId: 'policy' });
  const renamed = applySeriesAction(source, { type: 'rename', id: 'macro', previousTitle: '宏观', title: '宏观经济学' });
  assert.equal(renamed.series[1].title, '宏观经济学');
  const moved = applySeriesAction(source, { type: 'move-series', id: 'macro', previousParentId: 'econ', parentId: 'code' });
  assert.equal(moved.series.at(-1).parentId, 'code');
  assert.equal(moved.series.find(s => s.id === 'policy').parentId, 'macro');
  assert.deepEqual(source, original);
  assert.deepEqual(moved.placements, created.placements);
});
test('moves reject cycles and cross-category album transfers', () => {
  const source = fixture();
  for (const parentId of ['macro', 'policy', 'missing']) assert.throws(() => applySeriesAction(source, { type: 'move-series', id: 'macro', previousParentId: 'econ', parentId }));
  assert.throws(() => applySeriesAction(source, { type: 'move-album', id: 'month', previousSeriesId: '', seriesId: 'code' }));
  assert.throws(() => applySeriesAction(source, { type: 'move-album', id: 'a', previousSeriesId: 'macro', seriesId: '' }));
  const moved = applySeriesAction(source, { type: 'move-album', id: 'a', previousSeriesId: 'macro', seriesId: 'code' });
  assert.deepEqual(moved.placements.at(-1), { id: 'a', seriesId: 'code', date: '' });
  assert.deepEqual(moved.placements[0], { id: 'month', seriesId: '', date: '2026-09-19' });
});
test('sort touches only direct children and root sorting never includes monthly albums', () => {
  const source = fixture();
  const reordered = applySeriesAction(source, { type: 'reorder', parentId: 'macro', previousSeriesIds: ['policy'], seriesIds: ['policy'], previousAlbumIds: ['a', 'b'], albumIds: ['b', 'a'] });
  assert.deepEqual(reordered.placements.map(p => p.id), ['month', 'b', 'a', 'c']);
  const root = applySeriesAction(source, { type: 'reorder', parentId: '', previousSeriesIds: ['econ', 'code'], seriesIds: ['code', 'econ'], previousAlbumIds: [], albumIds: [] });
  assert.deepEqual(root.placements.map(p => p.id), ['month', 'a', 'b', 'c']);
  assert.deepEqual(root.series.filter(s => s.parentId).map(s => s.id), ['macro', 'micro', 'policy']);
});
test('stale targeted changes conflict while unrelated concurrent edits are preserved', () => {
  const source = fixture();
  assert.throws(() => applySeriesAction(source, { type: 'rename', id: 'macro', previousTitle: '旧名称', title: '新名称' }), /已有变化/);
  assert.throws(() => applySeriesAction(source, { type: 'move-album', id: 'a', previousSeriesId: 'code', seriesId: 'micro' }), /已有变化/);
  const order = { type: 'reorder', parentId: 'macro', previousSeriesIds: ['policy'], seriesIds: ['policy'], previousAlbumIds: ['b', 'a'], albumIds: ['a', 'b'] };
  assert.throws(() => applySeriesAction(source, order), /已有变化/);
  order.previousAlbumIds = ['a', 'b']; order.albumIds = ['a', 'a'];
  assert.throws(() => applySeriesAction(source, order), /全部条目/);
  source.series.push({ id: 'other', title: '并发新增', parentId: '' });
  const result = applySeriesAction(source, { type: 'rename', id: 'macro', previousTitle: '宏观', title: '新名称' });
  assert.equal(result.series.at(-1).id, 'other');
});

test('sorting one group preserves concurrent additions and reorders in the untouched group', () => {
  const source = fixture();
  source.series.push({ id: 'new-policy', title: '新政策', parentId: 'macro' });
  const albumOrder = applySeriesAction(source, { type: 'reorder', parentId: 'macro', previousSeriesIds: ['policy'], seriesIds: ['policy'], previousAlbumIds: ['a', 'b'], albumIds: ['b', 'a'] });
  assert.deepEqual(albumOrder.series, source.series);
  assert.deepEqual(albumOrder.placements.filter(item => item.seriesId === 'macro').map(item => item.id), ['b', 'a']);

  source.albums = [source.albums[0], source.albums[2], source.albums[1], source.albums[3], { id: 'new-album', seriesId: 'macro' }];
  const seriesOrder = applySeriesAction(source, { type: 'reorder', parentId: 'macro', previousSeriesIds: ['policy', 'new-policy'], seriesIds: ['new-policy', 'policy'], previousAlbumIds: ['a', 'b'], albumIds: ['a', 'b'] });
  assert.deepEqual(seriesOrder.placements.map(item => item.id), source.albums.map(item => item.id));
  assert.deepEqual(seriesOrder.series.filter(item => item.parentId === 'macro').map(item => item.id), ['new-policy', 'policy']);
  assert.throws(() => applySeriesAction(source, { type: 'reorder', parentId: 'macro', previousSeriesIds: ['policy'], seriesIds: ['policy'], previousAlbumIds: ['a', 'b'], albumIds: ['b', 'a'] }), /已有变化/);
});
