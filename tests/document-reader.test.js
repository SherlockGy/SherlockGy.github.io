import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDocument, normalizeManifest } from '../assets/model.js';
import { documentGeometry, readDocumentProgress } from '../assets/document-reader.js';
import { readFileSync } from 'node:fs';
const bounds = [.12, .05, .88, .94];
test('document mode is explicit and malformed crops safely fall back to original', () => {
  assert.equal(normalizeDocument(undefined), undefined);
  assert.equal(normalizeDocument({ type: 'portrait' }), undefined);
  assert.deepEqual(normalizeDocument({ type: 'document', contentBounds: bounds }).contentBounds, bounds);
  for (const crop of [[-.1, 0, 1, 1], [0, 0, 0, 1], [0, 0, 1, Infinity], 'bad']) {
    assert.deepEqual(normalizeDocument({ type: 'document', contentBounds: crop }).contentBounds, [0, 0, 1, 1]);
  }
});
test('natural page heights, shared crop scale, centered desktop cap and mobile fit', () => {
  const page = { width: 1697, height: 2400 };
  const desktop = documentGeometry(page, bounds, 1400);
  assert.equal(desktop.width, 820);
  assert.ok(desktop.height > 1300);
  assert.equal(desktop.imageWidth, 820 / .76);
  const mobile = documentGeometry(page, bounds, 350);
  assert.equal(mobile.width, 350);
  assert.ok(Math.abs(mobile.height / mobile.width - desktop.height / desktop.width) < .00001);
  assert.deepEqual(documentGeometry(page, bounds, 1400), desktop, 'sparse last page retains identical scale');
  assert.equal(documentGeometry(page, [0, 0, 1, 1], 1400).imageWidth, 820);
});
test('saved position accepts signed within-page anchors and safely handles storage failures', () => {
  const storage = { getItem: () => JSON.stringify({ page: 3, offset: -.1, scale: 1.2 }) };
  assert.deepEqual(readDocumentProgress(storage, 'a'), { page: 3, offset: -.1, scale: 1.2 });
  assert.equal(readDocumentProgress({ getItem() { throw Error(); } }, 'a'), null);
  assert.equal(readDocumentProgress({ getItem: () => '{oops' }, 'a'), null);
  assert.equal(readDocumentProgress({ getItem: () => '{"page":-1}' }, 'a'), null);
});
test('published album retains all six original pages, order, title and source description', () => {
  const manifest = JSON.parse(readFileSync(new URL('../data/albums.json', import.meta.url)));
  const albums = normalizeManifest(manifest);
  const document = albums.find(a => a.id === 'album-6db69c16-779c-44f8-85c2-82d58b884962');
  assert.deepEqual(document.document.contentBounds, bounds);
  assert.equal(document.images.length, 6);
  assert.match(document.description, /felixrieseberg/);
  assert.equal(albums.filter(a => a.document).length, 1);
  document.images.forEach((image, index) => {
    assert.ok(image.src.endsWith(`${String(index + 1).padStart(3, '0')}.webp`));
    assert.equal(image.width, 1697); assert.equal(image.height, 2400);
  });
});

test('document fullscreen keeps note expansion and layout enabled', () => {
  const source = readFileSync(new URL('../assets/app.js', import.meta.url), 'utf8');
  const noteCode = source.slice(source.indexOf('function setReaderNoteOpen'), source.indexOf('function updateReaderNote'));
  assert.ok(noteCode.includes('open && !toggle.hidden && !usesSlideshow()'));
  assert.ok(noteCode.includes('panel.hidden || !reader.open || usesSlideshow()'));
  assert.ok(!noteCode.includes('state.expanded'));
});

test('direct album routes reset fullscreen only when changing presentation kind', () => {
  const source = readFileSync(new URL('../assets/app.js', import.meta.url), 'utf8');
  assert.ok(source.includes("changed && state.expanded && isDocument() !== (album.document?.type === 'document')"));
});

test('document toolbar has no redundant details shortcut', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const source = readFileSync(new URL('../assets/app.js', import.meta.url), 'utf8');
  assert.ok(!html.includes('id="document-details"'));
  assert.ok(!source.includes("$('#document-details')"));
  for (const id of ['mode-page', 'mode-scroll', 'original-image', 'reader-hand']) assert.ok(html.includes(`id="${id}"`));
});
