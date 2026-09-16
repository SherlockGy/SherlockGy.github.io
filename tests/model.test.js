import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeManifest, normalizeSeries, flattenSeries, seriesTrail, groupByMonth, filterAlbums, validDate, safeImageUrl, validateFiles } from '../assets/model.js';
import { buildImageOrder } from '../assets/manage.js';
import config from '../config.js';
// Test-only metadata: never loaded by the website.
const fixture = { schemaVersion: 1, albums: [
  { id: 'test-reading', title: '阅读笔记', date: '2026-09-15', images: ['./images/test-a.png', './images/test-b.png'] },
  { id: 'test-questions', title: '判断问题', date: '2026-09-08', images: ['./images/test-c.png'] },
  { id: 'test-context', title: '上下文', date: '2026-08-22', tags: ['知识整理'], images: ['./images/test-d.png', './images/test-e.png'] },
  { id: 'test-notes', title: '整理笔记', date: '2026-06-12', images: ['./images/test-f.png'] },
] };
const albums = normalizeManifest(fixture);

test('only populated months appear, newest first; single and multiple images are retained', () => {
  assert.deepEqual(groupByMonth(albums).map(([month]) => month), ['2026-09', '2026-08', '2026-06']);
  assert.equal(albums[0].images.length, 2);
  assert.equal(albums[1].images.length, 1);
  assert.equal(groupByMonth([]).length, 0);
});
test('month, keyword and image-count filters combine correctly', () => {
  assert.deepEqual(filterAlbums(albums, { query: '判断', month: '2026-09', type: 'single' }).map(a => a.id), ['test-questions']);
  assert.equal(filterAlbums(albums, { month: '2026-07' }).length, 0);
  assert.equal(filterAlbums(albums, { query: '知识整理' }).length, 1);
  assert.equal(filterAlbums(albums, { type: 'multiple' }).length, 2);
});
test('archive dates are calendar dates, without timezone conversion', () => {
  assert.equal(validDate('2024-02-29'), true);
  for (const date of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-09-15T10:00:00Z', 'bad']) assert.equal(validDate(date), false);
});
test('malformed manifests are reported instead of silently losing content', () => {
  for (const data of [{ albums: [] }, { schemaVersion: 1 }, { schemaVersion: 1, albums: [fixture.albums[0], fixture.albums[0]] },
    { schemaVersion: 1, albums: [{ ...fixture.albums[0], images: [] }] },
    { schemaVersion: 1, albums: [{ ...fixture.albums[0], date: '2026-02-30' }] }]) assert.throws(() => normalizeManifest(data));
});
test('image URLs reject executable protocols and embedded credentials', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///tmp/file', 'https://user:pass@example.com/img.png']) assert.throws(() => safeImageUrl(url));
  assert.equal(safeImageUrl('./images/example.png'), 'https://sherlockgy.github.io/images/example.png');
});
test('file count, type, empty content and byte limits are enforced', () => {
  const file = { name: 'note.png', size: 1024, type: 'image/png' };
  assert.doesNotThrow(() => validateFiles([file], config));
  for (const files of [[], Array(31).fill(file), [{ ...file, size: 0 }], [{ ...file, type: 'image/svg+xml' }],
    [{ ...file, size: 11 * 1048576 }], Array(4).fill({ ...file, size: 9 * 1048576 })]) assert.throws(() => validateFiles(files, config));
});
test('production manifest remains valid as real albums are added', async () => {
  const data = JSON.parse(await readFile(new URL('../data/albums.json', import.meta.url)));
  assert.doesNotThrow(() => normalizeManifest(data));
});

test('undated series albums retain manual order and never enter month archives', () => {
  const data = { schemaVersion: 1, series: [{ id: 'economics', title: '经济学' }, { id: 'macro', title: '宏观', parentId: 'economics' }],
    albums: [fixture.albums[0], { id: 'z-last', title: '基础', seriesId: 'macro', images: ['./images/test-a.png'] },
      { id: 'a-first', title: '进阶', seriesId: 'macro', date: '2020-01-01', images: ['./images/test-b.png'] }] };
  const albums = normalizeManifest(data), series = normalizeSeries(data);
  assert.deepEqual(groupByMonth(albums).map(([month]) => month), ['2026-09']);
  assert.deepEqual(filterAlbums(albums, { view: 'series', seriesId: 'macro' }).map(item => item.id), ['z-last', 'a-first']);
  assert.equal(filterAlbums(albums, { view: 'archive' }).length, 1);
  assert.equal(filterAlbums(albums, { view: 'series' }).length, 0);
  assert.equal(filterAlbums(albums, { month: '2020-01' }).length, 0);
  assert.deepEqual(seriesTrail(series, 'macro').map(item => item.title), ['经济学', '宏观']);
  assert.deepEqual(flattenSeries(series).map(item => item.depth), [0, 1]);
});
test('series graphs reject loops, duplicate ids and nonexistent parents or album destinations', () => {
  for (const series of [
    [{ id: 'a', title: 'A', parentId: 'a' }],
    [{ id: 'a', title: 'A', parentId: 'b' }, { id: 'b', title: 'B', parentId: 'a' }],
    [{ id: 'a', title: 'A', parentId: 'missing' }],
    [{ id: 'a', title: 'A' }, { id: 'a', title: 'A' }],
  ]) assert.throws(() => normalizeSeries({ series }));
  assert.throws(() => normalizeManifest({ schemaVersion: 1, albums: [{ ...fixture.albums[0], seriesId: 'missing' }] }));
});
test('editing sends only new files and preserves original identity through reorder and replacement', () => {
  const replacement = { name: 'replace.png' }, added = { name: 'added.png' };
  const result = buildImageOrder([{ existing: 2 }, { existing: 0, file: replacement }, { file: added }, { existing: 1 }]);
  assert.deepEqual(result.files, [replacement, added]);
  assert.deepEqual(result.order, [{ existing: 2 }, { file: 0, replaces: 0 }, { file: 1 }, { existing: 1 }]);
  assert.deepEqual(buildImageOrder([{ existing: 1 }, { existing: 0 }]).files, []);
});
