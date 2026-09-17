import config from '../config.js';
import { normalizeManifest, normalizeSeries, flattenSeries, seriesTrail, groupByMonth, filterAlbums, validDate, validateFiles } from './model.js?v=20260917-review-3';
import { createImageEditor, createSeriesManager } from './manage.js?v=20260917-review-4';
import { configureCoverImage } from './covers.js?v=20260917-previews-1';
import { createImagePreview, createPreviewButton } from './previews.js?v=20260917-space-1';
import { setFeedback } from './feedback.js?v=20260917-interaction-1';
import { createUploadClient } from './upload.js?v=20260917-review-4';
import { createSlideshow } from './slideshow.js?v=20260917-preload-2';
import { createImageReader, createScrollReader } from './reader.js?v=20260917-preload-2';
import { createImagePreloader, createImageWindow } from './preload.js?v=20260917-preload-2';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { albums: [], series: [], view: 'archive', seriesId: '', query: '', month: '', type: 'all', expanded: false,
  album: null, page: 0, mode: 'page', zoom: 1, hand: false, preview: null, files: [], urls: [], requestId: null, busy: false,
  uploadDirty: false, uploadSaved: false, loadError: false, scrollY: 0 };
const reader = $('#reader');
const uploadDialog = $('#upload-dialog');
const uploadClient = createUploadClient();
const imagePreview = createImagePreview(updateBodyLock);
const slideshow = createSlideshow($('#slideshow'), { onSelect: goPage, onExit: () => setExpanded(false) });
const imageEditor = createImageEditor(updateBodyLock, data => {
  if (data.album) {
    const knownThumbnails = new Map(state.albums.flatMap(album => album.images).filter(image => image.thumbnails?.length).map(image => [image.src, image.thumbnails]));
    state.series = normalizeSeries(data);
    const updated = normalizeManifest({ schemaVersion: 1, albums: [data.album], series: state.series }, document.baseURI)[0];
    for (const image of updated.images) image.thumbnails ||= knownThumbnails.get(image.src);
    state.albums = state.albums.map(album => album.id === updated.id ? updated : album);
  }
  if (data.status === 'committed') $('#publish-notice').hidden = false;
  closeReader();
  renderCatalog();
}, imagePreview);
const seriesManager = createSeriesManager(updateBodyLock, data => {
  if (data.manifest) {
    const knownThumbnails = new Map(state.albums.flatMap(album => album.images).filter(image => image.thumbnails?.length).map(image => [image.src, image.thumbnails]));
    state.series = normalizeSeries(data.manifest);
    state.albums = normalizeManifest(data.manifest, document.baseURI);
    // Worker responses contain source metadata; retain already published covers by original URL.
    for (const album of state.albums) for (const image of album.images) image.thumbnails ||= knownThumbnails.get(image.src);
    renderCatalog();
  }
  if (data.status === 'committed') $('#publish-notice').hidden = false;
});
let scrollReader;
let imageReader;
const pagePreloader = createImagePreloader();
let preloadedAlbum, pageImageDispose, continuousImages;
let lastFocused;
let toastTimer;
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `./assets/icons.svg#${name}`); svg.append(use);
  return svg;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, className, action) {
  const node = el('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}
function toast(message) {
  const node = $('#toast');
  (reader.open ? reader : document.body).append(node);
  node.textContent = message; node.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { node.hidden = true; }, 3000);
}
function updateBodyLock() { document.body.classList.toggle('modal-open', !!document.querySelector('dialog[open]')); }
function collectionHash() { return state.view === 'series' ? `#/series${state.seriesId ? `/${state.seriesId}` : ''}` : ''; }
function openCollection(view, seriesId = '', month = '', keepType = false) {
  state.view = view; state.seriesId = seriesId; state.month = month;
  state.query = ''; $('#search').value = '';
  if (!keepType) state.type = 'all';
  history.replaceState(null, '', location.pathname + location.search + collectionHash());
  renderCatalog(); $('#main').focus({ preventScroll: true });
}
function localDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
async function loadAlbums() {
  $('#collection').setAttribute('aria-busy', 'true');
  try {
    const response = await fetch(config.manifestUrl, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`目录加载失败（${response.status}）`);
    const data = await response.json();
    state.series = normalizeSeries(data);
    state.albums = normalizeManifest(data, document.baseURI);
    state.loadError = false;
  } catch (error) {
    state.loadError = true;
    state.errorMessage = error.message;
  }
  renderCatalog();
  $('#collection').setAttribute('aria-busy', 'false');
  route();
}

function renderNav() {
  const nav = $('#month-nav'); nav.replaceChildren();
  const groups = groupByMonth(state.albums);
  $('.archive-label').hidden = !groups.length;
  let year = '', yearGroup;
  for (const [month, albums] of groups) {
    if (year !== month.slice(0, 4)) {
      year = month.slice(0, 4); yearGroup = el('div', 'year-group');
      yearGroup.append(el('p', 'year-title', year)); nav.append(yearGroup);
    }
    const link = button('', `month-link${state.view === 'archive' && state.month === month ? ' active' : ''}`, () => openCollection('archive', '', month));
    link.setAttribute('aria-label', `${year} 年 ${Number(month.slice(5))} 月，${albums.length} 个图集`);
    if (state.month === month) link.setAttribute('aria-current', 'true');
    link.append(el('span', '', `${Number(month.slice(5))} 月`), el('span', '', String(albums.length)));
    yearGroup.append(link);
  }
  $('#all-months').classList.toggle('active', state.view === 'archive' && !state.month);
  $('#all-months').setAttribute('aria-pressed', String(state.view === 'archive' && !state.month));
  $('#nav-count').textContent = state.albums.filter(album => !album.seriesId).length;
  const seriesNav = $('#series-nav'); seriesNav.replaceChildren();
  $('#all-series').classList.toggle('active', state.view === 'series' && !state.seriesId);
  $('#all-series').setAttribute('aria-pressed', String(state.view === 'series' && !state.seriesId));
  for (const item of flattenSeries(state.series)) {
    const link = button(item.title, `series-link${state.view === 'series' && state.seriesId === item.id ? ' active' : ''}`, () => openCollection('series', item.id));
    link.style.setProperty('--depth', Math.min(item.depth, 6));
    link.title = seriesTrail(state.series, item.id).map(entry => entry.title).join(' / ');
    if (state.view === 'series' && state.seriesId === item.id) link.setAttribute('aria-current', 'page');
    seriesNav.append(link);
  }
}

function emptyState(kind) {
  const box = el('section', 'empty-state');
  if (kind === 'empty') {
    const add = button('', 'primary-button', openUpload); add.append(icon('plus'), el('span', '', '添加图集'));
    box.append(icon('images'), el('h2', '', '暂无图集'), add);
  } else if (kind === 'error') {
    box.append(el('h2', '', '暂时无法加载图集'), el('p', '', state.errorMessage), button('重新加载', 'secondary-button', loadAlbums));
  } else {
    box.append(el('h2', '', '没有找到相符的图集'), el('p', '', '试试其他关键词，或清除当前筛选。'), button('清除筛选', 'secondary-button', () => {
      state.query = ''; state.month = ''; state.type = 'all'; $('#search').value = ''; renderCatalog(); $('#search').focus();
    }));
  }
  return box;
}

function renderCatalog() {
  const query = state.query.trim();
  document.body.dataset.view = state.view;
  renderNav();
  const seriesIds = new Set(state.series.filter(item => !state.seriesId || seriesTrail(state.series, item.id).some(parent => parent.id === state.seriesId)).map(item => item.id));
  const seriesAlbums = state.albums.filter(album => seriesIds.has(album.seriesId));
  const filtered = state.view === 'series' && query
    ? filterAlbums(seriesAlbums, { query: state.query, type: state.type }) : filterAlbums(state.albums, state);
  const counted = state.view === 'series' ? filterAlbums(seriesAlbums, { query: state.query, type: state.type }) : filtered;
  $('#album-count').textContent = counted.length;
  $('#image-count').textContent = counted.reduce((count, album) => count + album.images.length, 0);
  $('#series-count-note').hidden = state.view !== 'series';
  const currentSeries = state.series.find(item => item.id === state.seriesId);
  const title = state.view === 'series' ? currentSeries?.title || '系列图集' : state.month ? `${state.month.slice(0, 4)} 年 ${Number(state.month.slice(5))} 月` : '月份图集';
  $('#page-title').textContent = title;
  const crumbs = $('#series-breadcrumbs'); crumbs.replaceChildren(); crumbs.hidden = state.view !== 'series';
  if (state.view === 'series') {
    crumbs.append(button('系列图集', 'text-button', () => openCollection('series')));
    for (const item of seriesTrail(state.series, state.seriesId)) {
      crumbs.append(el('span', '', '/'), button(item.title, 'text-button', () => openCollection('series', item.id)));
    }
  }
  $$('.tab').forEach(tab => {
    const active = tab.dataset.type === state.type;
    tab.classList.toggle('active', active); tab.setAttribute('aria-pressed', String(active));
  });
  $('#result-summary').textContent = query ? `“${query}” · 找到 ${filtered.length} 个图集` : '';
  const container = $('#collection'); container.replaceChildren();
  if (state.loadError) { container.append(emptyState('error')); return; }
  if (state.view === 'series') {
    const typeMatches = filterAlbums(seriesAlbums, { type: state.type });
    const children = state.series.filter(item => item.parentId === state.seriesId &&
      query.toLocaleLowerCase().split(/\s+/).every(term => item.title.toLocaleLowerCase().includes(term))).map(item => {
      const descendants = new Set(state.series.filter(entry => seriesTrail(state.series, entry.id).some(parent => parent.id === item.id)).map(entry => entry.id));
      return { ...item, albumCount: typeMatches.filter(album => descendants.has(album.seriesId)).length };
    }).filter(item => state.type === 'all' || item.albumCount > 0);
    if (children.length) {
      const grid = el('div', 'series-grid');
      for (const item of children) {
        const card = button('', 'series-card', () => openCollection('series', item.id, '', true));
        card.append(icon('folio'), el('h2', '', item.title), el('p', '', `${state.series.filter(entry => entry.parentId === item.id).length} 个子系列 · ${item.albumCount} 个图集`)); grid.append(card);
      }
      container.append(grid);
    }
    if (filtered.length) { const grid = el('div', 'album-grid series-albums'); renderCards(grid, filtered); container.append(grid); }
    if (!children.length && !filtered.length) {
      if (query || state.type !== 'all') { container.append(emptyState('filtered')); return; }
      const empty = el('section', 'empty-state');
      empty.append(el('h2', '', '暂无内容'),
        button('管理系列', 'secondary-button', () => seriesManager.open(state.seriesId)), button('添加图集', 'primary-button', openUpload));
      container.append(empty);
    }
    return;
  }
  if (!filtered.length) { container.append(emptyState(state.albums.some(album => !album.seriesId) ? 'filtered' : 'empty')); return; }
  let renderedCards = 0;
  for (const [month, albums] of groupByMonth(filtered)) {
    const section = el('section', 'month-section'); section.dataset.month = month;
    const header = el('div', 'month-heading');
    const number = el('h2', 'month-number', month.slice(5)); number.append(el('span', '', '月'));
    number.setAttribute('aria-label', `${month.slice(0, 4)} 年 ${Number(month.slice(5))} 月`);
    const year = el('time', 'month-year', month.slice(0, 4)); year.dateTime = month;
    header.append(number, year);
    const grid = el('div', 'album-grid');
    renderCards(grid, albums, renderedCards); renderedCards += albums.length;
    section.append(header, grid); container.append(section);
  }
}

function renderCards(grid, albums, offset = 0) {
  const eagerCount = matchMedia('(max-width: 540px)').matches ? 1 : matchMedia('(min-width: 1800px)').matches ? 3 : 2;
  for (const [index, album] of albums.entries()) {
      const card = el('a', `album-card${album.images.length > 1 ? ' multiple' : ''}`);
      card.href = `#/album/${encodeURIComponent(album.id)}/1`;
      card.setAttribute('aria-label', `阅读 ${album.title}，${album.images.length} 张图片`);
      const cover = el('div', 'cover');
      const coverImage = configureCoverImage(el('img'), { ...album.images[0], alt: '' }, {
        eager: offset + index < eagerCount, priority: offset + index === 0, series: state.view === 'series',
        onError: () => { coverImage.hidden = true; cover.prepend(el('span', 'card-description', '封面暂时无法显示')); },
      });
      const badge = el('span', 'image-badge'); badge.append(icon(album.images.length > 1 ? 'images' : 'image'));
      badge.append(document.createTextNode(`${album.images.length} 张`)); cover.append(coverImage);
      const open = el('span', 'card-open'); open.setAttribute('aria-hidden', 'true'); open.append(icon('expand')); cover.append(open);
      const info = el('div', 'card-info'); info.append(el('h3', '', album.title));
      if (album.description) info.append(el('p', 'card-description', album.description));
      const meta = el('div', 'card-meta');
      if (album.seriesId) meta.append(el('span', 'card-series', state.series.find(item => item.id === album.seriesId)?.title || '系列图集'));
      else { const date = el('time', '', album.date.replaceAll('-', '.')); date.dateTime = album.date; meta.append(date); }
      if (album.tags[0]) meta.append(el('span', 'tag', album.tags[0]));
      meta.append(badge); info.append(meta); card.append(cover, info); grid.append(card);
  }
}

function route() {
  if (state.loadError) return;
  const showCollection = (view, seriesId = '') => {
    if (state.view !== view || state.seriesId !== seriesId) {
      state.query = ''; $('#search').value = ''; state.type = 'all'; state.month = '';
    }
    state.view = view; state.seriesId = seriesId;
    renderCatalog();
  };
  const seriesRoute = location.hash.match(/^#\/series(?:\/([a-zA-Z0-9_-]+))?$/);
  if (seriesRoute) {
    closeReader(false);
    showCollection('series', state.series.some(item => item.id === seriesRoute[1]) ? seriesRoute[1] : ''); return;
  }
  const match = location.hash.match(/^#\/album\/([a-zA-Z0-9_-]+)(?:\/(\d+))?$/);
  if (!match) { closeReader(false); if (!location.hash) showCollection('archive'); return; }
  const album = state.albums.find(item => item.id === match[1]) || (state.preview?.id === match[1] ? state.preview : null);
  if (!album) {
    history.replaceState(null, '', location.pathname + location.search); closeReader(false);
    showCollection('archive');
    toast('找不到这份图集，可能已移除或尚未发布。'); return;
  }
  if (!reader.open && !album.local && (album.seriesId || state.view !== 'archive')) {
    showCollection(album.seriesId ? 'series' : 'archive', album.seriesId);
  }
  const changed = state.album?.id !== album.id;
  state.album = album;
  state.page = Math.max(0, Math.min(album.images.length - 1, Number(match[2] || 1) - 1));
  if (changed) { state.zoom = 1; state.hand = false; state.mode = 'page'; }
  if (!reader.open) {
    state.scrollY = window.scrollY; lastFocused = document.activeElement;
    reader.showModal(); updateBodyLock(); $('#reader-close').focus();
  }
  $('#reader-title').textContent = album.title;
  const locationLabel = album.seriesId ? seriesTrail(state.series, album.seriesId).map(item => item.title).join(' / ') : album.date.replaceAll('-', '.');
  $('#reader-meta').textContent = `${locationLabel}  ·  ${album.images.length} 张图片${album.local ? '  ·  本地预览，尚未保存' : ''}`;
  $('#copy-link').disabled = !!album.local;
  $('#edit-images').hidden = !!album.local || !config.uploadEndpoint;
  document.title = `${album.title} · 图集`;
  renderReader();
}

function setExpanded(expanded, restoreReader = true) {
  if (state.expanded === expanded) return;
  state.expanded = expanded;
  reader.classList.toggle('expanded', expanded);
  const control = $('#fullscreen');
  const label = expanded ? '退出网页全屏' : '网页全屏';
  control.setAttribute('aria-pressed', String(expanded));
  control.setAttribute('aria-label', label); control.title = label;
  control.replaceChildren(icon(expanded ? 'collapse' : 'expand'));
  disposeReaderImages(true);
  if (expanded && reader.open && state.album) slideshow.open(state.album, state.page);
  else {
    slideshow.close();
    if (restoreReader && reader.open && state.album) { renderReader(); control.focus({ preventScroll: true }); }
  }
}

function closeReader(changeRoute = true) {
  setExpanded(false, false);
  disposeReaderImages(true);
  if (reader.open) {
    reader.close(); updateBodyLock();
    if ($('#toast').parentElement === reader) document.body.append($('#toast'));
    window.scrollTo(0, state.scrollY);
    if (!document.querySelector('dialog[open]')) {
      const card = $$('.album-card').find(card => card.hash === `#/album/${encodeURIComponent(state.album?.id)}/1`);
      (lastFocused?.isConnected && lastFocused.getClientRects().length ? lastFocused : card || $('#main')).focus({ preventScroll: true });
    }
  }
  state.album = null;
  document.title = '图集 · SherlockGy';
  if (changeRoute) history.replaceState(null, '', location.pathname + location.search + collectionHash());
}

function syncReaderControls() {
  const focused = document.activeElement;
  const total = state.album.images.length;
  $('.segmented', reader).hidden = total === 1;
  $('.reader-footer', reader).hidden = total === 1;
  $('#page-number').value = state.page + 1; $('#page-number').max = total;
  $('#page-total').textContent = `/ ${total} 页`;
  $('#prev-page').disabled = state.page === 0;
  $('#next-page').disabled = state.page === total - 1;
  $('#original-image').href = state.album.images[state.page].src;
  const scale = `${Math.round(state.zoom * 100)}%`;
  $('#reader-scale').textContent = scale;
  $('#reader-scale').setAttribute('aria-label', `当前缩放 ${scale}`);
  $('#reader-scale').hidden = state.mode !== 'page';
  $('#reader-hand').hidden = state.mode !== 'page';
  $('#reader-hand').setAttribute('aria-pressed', String(state.hand));
  const handLabel = state.hand ? '关闭拖动，恢复适屏' : '开启拖动与缩放（滚轮 / 双指）';
  $('#reader-hand').setAttribute('aria-label', handLabel); $('#reader-hand').title = handLabel;
  $('#zoom-reset').hidden = state.mode !== 'page';
  $('#reader-tool-divider').hidden = state.mode !== 'page';
  $('#reader-stage').setAttribute('aria-label', state.hand ? '图片阅读区域：拖动查看，滚轮或双指缩放；加减键缩放，0 键恢复适屏' : '图片阅读区域');
  if (!state.expanded && reader.contains(focused) && focused.disabled) $('#reader-stage').focus({ preventScroll: true });
  for (const mode of ['page', 'scroll']) {
    $(`#mode-${mode}`).classList.toggle('active', state.mode === mode);
    $(`#mode-${mode}`).setAttribute('aria-pressed', String(state.mode === mode));
  }
}

function disposeReaderImages(clearPreload = false) {
  scrollReader?.disconnect(); scrollReader = null;
  imageReader?.disconnect(); imageReader = null;
  continuousImages?.clear(); continuousImages = null;
  pageImageDispose?.(); pageImageDispose = null;
  $('#reader-stage').replaceChildren();
  if (clearPreload) { pagePreloader.clear(); preloadedAlbum = null; }
}

function mountReaderImage(frame, image, index, entry, retry, onReady = () => {}) {
  const logPrefix = `[mountReaderImage 图片阅读][albumId=${state.album.id}][page=${index + 1}]`;
  const img = entry.image;
  let disposed = false;
  img.alt = image.alt; img.hidden = !entry.ready;
  const status = el('div', 'reader-image-status', '正在加载图片…');
  status.setAttribute('role', 'status'); status.hidden = entry.ready;
  frame.setAttribute('aria-busy', String(!entry.ready));
  frame.replaceChildren(img, status);
  function display(loaded) {
    if (disposed) return;
    frame.setAttribute('aria-busy', 'false');
    if (loaded) { img.hidden = false; status.hidden = true; onReady(); }
    else {
      console.warn(logPrefix, '原图加载失败');
      status.hidden = false; status.className = 'image-error';
      status.replaceChildren(el('p', '', '这张图片暂时无法加载'), button('重新加载图片', 'text-button', () => {
        $('#reader-stage').focus({ preventScroll: true }); retry();
      }));
    }
  }
  if (entry.ready) display(true); else entry.promise.then(display);
  return () => { disposed = true; frame.replaceChildren(); frame.removeAttribute('aria-busy'); };
}

function renderReader() {
  disposeReaderImages(state.expanded || state.mode === 'scroll' || preloadedAlbum !== state.album);
  state.zoom = 1;
  if (state.expanded) { slideshow.show(state.album, state.page); syncReaderControls(); return; }
  syncReaderControls();
  const stage = $('#reader-stage');
  stage.classList.toggle('is-continuous', state.mode === 'scroll');
  const images = state.mode === 'scroll' ? state.album.images.map((image, index) => [image, index]) : [[state.album.images[state.page], state.page]];
  const frames = new Map();
  for (const [, index] of images) {
    const figure = el('figure', 'reader-page'); figure.dataset.index = index;
    figure.setAttribute('aria-label', `第 ${index + 1} 张，共 ${state.album.images.length} 张`);
    const frame = el('div', 'reader-image-frame');
    frames.set(index, frame);
    figure.append(frame);
    stage.append(figure);
  }
  layoutReader(); stage.scrollTop = 0; stage.scrollLeft = 0;
  if (state.mode === 'scroll') {
    continuousImages = createImageWindow(state.album.images, (index, entry) => mountReaderImage(
      frames.get(index), state.album.images[index], index, entry, () => continuousImages.retry(index),
    ));
    continuousImages.select(state.page);
    scrollReader = createScrollReader(stage, page => {
      if (!state.album || state.expanded || state.mode !== 'scroll') return;
      continuousImages.select(page);
      if (page !== state.page) {
        state.page = page; syncReaderControls();
        history.replaceState(null, '', `#/album/${state.album.id}/${state.page + 1}`);
      }
    }, { fixedLayout: true });
    scrollReader.goTo(state.page);
  } else {
    preloadedAlbum = state.album;
    const frame = frames.get(state.page), entry = pagePreloader.select(state.album.images, state.page);
    pageImageDispose = mountReaderImage(frame, state.album.images[state.page], state.page, entry, renderReader, () => {
      imageReader = createImageReader(frame, {
        keyTarget: stage,
        onScaleChange: scale => { state.zoom = scale; syncReaderControls(); },
      });
      imageReader.setHand(state.hand);
    });
  }
  syncReaderControls();
}

function layoutReader() {
  if (!state.album || !reader.open) return;
  if (state.expanded) { slideshow.resize(); return; }
  const stage = $('#reader-stage'), style = getComputedStyle(stage);
  if (!stage.clientWidth || !stage.clientHeight) return;
  const bounds = stage.getBoundingClientRect();
  // clientHeight/clientWidth round to whole pixels; use the smaller rendered
  // bounds as well so fractional viewport sizes do not create a stray scrollbar.
  const availableWidth = Math.max(1, Math.min(stage.clientWidth, bounds.width) - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
  const availableHeight = Math.max(1, Math.min(stage.clientHeight, bounds.height) - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom));
  const width = Math.max(1, Math.floor(availableWidth));
  const height = Math.max(1, Math.floor(availableHeight));
  // Pagination lives in the fixed footer. Every image uses the whole frame,
  // including the space previously reserved for a duplicate page caption.
  $$('.reader-page', stage).forEach(figure => {
    figure.style.width = `${width}px`;
    $('.reader-image-frame', figure).style.height = `${height}px`;
  });
}
function resizeReader() {
  if (!state.album || !reader.open || state.expanded) return;
  const stage = $('#reader-stage'), figure = $(`.reader-page[data-index="${state.page}"]`, stage);
  if (!figure || !stage.clientHeight) return;
  const top = stage.getBoundingClientRect().top + parseFloat(getComputedStyle(stage).paddingTop);
  const before = figure.getBoundingClientRect();
  const vertical = before.height ? (top - before.top) / before.height : 0;
  const horizontal = stage.scrollLeft / Math.max(1, stage.scrollWidth - stage.clientWidth);
  layoutReader();
  const after = figure.getBoundingClientRect();
  // Preserve the place in the continuous list when mobile browser chrome or
  // the window changes size. The single-image controller preserves its pan.
  stage.scrollTop += after.top - top + vertical * after.height;
  stage.scrollLeft = horizontal * Math.max(0, stage.scrollWidth - stage.clientWidth);
}
function goPage(page) {
  if (!state.album) return;
  const target = Number.isFinite(page) ? Math.trunc(page) : 0;
  const nextPage = Math.max(0, Math.min(state.album.images.length - 1, target));
  // Boundary keys and selecting the active thumbnail must not reload the
  // current original or discard the user's zoom and pan.
  if (nextPage === state.page) {
    if (!state.expanded && state.mode === 'scroll') scrollReader?.goTo(state.page);
    syncReaderControls(); return;
  }
  state.page = nextPage;
  history.replaceState(null, '', `#/album/${state.album.id}/${state.page + 1}`);
  if (state.expanded) renderReader();
  else if (state.mode === 'scroll') {
    continuousImages.select(state.page); scrollReader.goTo(state.page); syncReaderControls();
  } else renderReader();
}

function resetDraft() {
  uploadClient.reset();
  state.urls.forEach(url => URL.revokeObjectURL(url));
  state.files = []; state.urls = []; state.preview = null; state.requestId = null;
  state.uploadDirty = false; state.uploadSaved = false;
  $('#upload-form').reset(); $('#album-date').value = localDate(); setFeedback($('#upload-status'), '');
  syncUploadControls(); renderFiles();
}
function syncUploadControls() {
  $$('#upload-form input, #upload-form textarea, #upload-form select, #upload-form button').forEach(control => {
    control.disabled = state.busy || state.uploadSaved;
  });
  $('#upload-close').disabled = state.busy;
  $('#upload-submit').disabled = state.busy;
  $('#upload-submit').textContent = state.uploadSaved ? '完成' : config.uploadEndpoint ? '保存图集' : '预览图集';
}
function uploadChanged() {
  if (state.busy || state.uploadSaved) return;
  state.uploadDirty = true; state.requestId = null; setFeedback($('#upload-status'), '');
}
function openUpload() {
  if (uploadDialog.open || state.busy) return;
  if (!state.uploadDirty) {
    resetDraft();
    const select = $('#album-series'); select.replaceChildren(new Option('月份图集', ''));
    for (const item of flattenSeries(state.series)) select.append(new Option(seriesTrail(state.series, item.id).map(entry => entry.title).join(' / '), item.id));
    select.value = state.view === 'series' ? state.seriesId : ''; syncAlbumLocation();
  }
  // A local preview shares these files. Resume its draft without revoking them;
  // the old preview snapshot is replaced the next time the user previews it.
  state.preview = null;
  $('#upload-hint').textContent = config.uploadEndpoint
    ? '第一张图片作为封面，添加后可调整顺序。'
    : '上传服务尚未连接。你可以先命名、排序并预览图片；本地预览不会保存，关闭或刷新页面后失效。';
  $('#upload-submit').textContent = config.uploadEndpoint ? '保存图集' : '预览图集';
  $('#access-code-field').hidden = !config.uploadEndpoint;
  $('#access-code').required = !!config.uploadEndpoint;
  uploadDialog.showModal(); updateBodyLock(); $('.dialog-content', uploadDialog).scrollTop = 0; $('#album-title').focus();
}
function syncAlbumLocation() {
  const isSeries = !!$('#album-series').value;
  $('#album-date-row').hidden = isSeries; $('#album-date').required = !isSeries;
  state.requestId = null;
}
function closeUpload({ keepDraft = false } = {}) {
  if (state.busy) return;
  if (!keepDraft && state.uploadDirty && !confirm('还有未保存的图集，确定放弃并关闭吗？')) return;
  $('#access-code').value = ''; uploadDialog.close(); updateBodyLock();
  if (!keepDraft) resetDraft();
}

async function addFiles(incoming) {
  if (state.busy || state.uploadSaved || !incoming.length) return;
  const next = [...state.files, ...incoming];
  try {
    validateFiles(next, config);
    state.files = next; uploadChanged();
    state.urls.push(...incoming.map(file => URL.createObjectURL(file)));
    if (!$('#album-title').value && incoming[0]) $('#album-title').value = incoming[0].name.replace(/\.[^.]+$/, '').slice(0, 120);
    renderFiles();
  } catch (error) { setFeedback($('#upload-status'), error.message, 'error'); }
  $('#file-input').value = '';
}
function renderFiles() {
  const list = $('#file-list'); list.replaceChildren();
  const previews = () => state.files.map((file, index) => ({ src: state.urls[index], name: file.name }));
  state.files.forEach((file, index) => {
    const row = el('div', 'file-item');
    const preview = createPreviewButton({ src: state.urls[index] }, index, () => imagePreview.open(previews(), index));
    preview.disabled = state.busy;
    const details = el('div', 'file-details');
    const filename = el('span', 'file-name', file.name); filename.title = file.name;
    details.append(el('span', 'file-order', `${String(index + 1).padStart(2, '0')}${index === 0 ? ' · 封面' : ''}`),
      filename, el('small', 'field-note', `${(file.size / 1048576).toFixed(2)} MB${state.uploadSaved ? ' · 已保存' : ''}`));
    const actions = el('div', 'file-actions');
    row.append(preview, details, actions);
    for (const [label, delta, name] of [['向前移动', -1, 'chevron-up'], ['向后移动', 1, 'chevron-down']]) {
      const move = button('', 'icon-button', () => {
        const target = index + delta; uploadChanged();
        [state.files[index], state.files[target]] = [state.files[target], state.files[index]];
        [state.urls[index], state.urls[target]] = [state.urls[target], state.urls[index]];
        renderFiles();
        const movedRow = list.children[target], movedButton = movedRow.querySelectorAll('.file-actions button')[delta < 0 ? 0 : 1];
        (movedButton.disabled ? movedRow.querySelector('.image-preview-button') : movedButton).focus();
      });
      move.append(icon(name)); move.title = label;
      move.setAttribute('aria-label', `${label}第 ${index + 1} 张图片`); move.disabled = state.busy || state.uploadSaved || index + delta < 0 || index + delta >= state.files.length;
      actions.append(move);
    }
    const remove = button('', 'icon-button', () => {
      uploadChanged(); URL.revokeObjectURL(state.urls[index]); state.files.splice(index, 1); state.urls.splice(index, 1); renderFiles();
      (list.children[Math.min(index, state.files.length - 1)]?.querySelector('.image-preview-button') || $('#file-input')).focus();
    });
    remove.append(icon('close')); remove.title = '移除图片';
    remove.setAttribute('aria-label', `移除第 ${index + 1} 张图片`); remove.disabled = state.busy || state.uploadSaved; actions.append(remove); list.append(row);
  });
  $('#file-summary').textContent = state.files.length ? `${state.files.length} 张图片 · ${(state.files.reduce((sum, file) => sum + file.size, 0) / 1048576).toFixed(1)} MB` : '尚未选择图片';
}

function serviceError(data, fallback) {
  const message = data?.error?.message || fallback;
  const traceId = data?.error?.traceId;
  return new Error(typeof traceId === 'string' ? `${message}（请求编号：${traceId}）` : message);
}

async function checkConnection() {
  if (state.busy || state.uploadSaved || !config.uploadEndpoint) return;
  const status = $('#upload-status');
  try {
    const endpoint = new URL(config.uploadEndpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('上传服务地址需要配置为 HTTPS');
    const code = $('#access-code').value.trim();
    if (!code) throw new Error('请先输入上传口令，再测试连接');
    state.busy = true;
    syncUploadControls();
    setFeedback(status, '正在检查连接和图集目录，请稍候…');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 75000);
    let response, data;
    try {
      response = await fetch(new URL('/check', endpoint), { method: 'POST', headers: { Authorization: `Bearer ${code}` }, signal: controller.signal, redirect: 'error', credentials: 'omit' });
      data = await response.json().catch(error => { if (controller.signal.aborted) throw error; return null; });
    } finally { clearTimeout(timer); }
    if (response.status === 404) throw new Error('请先在 Cloudflare 部署新版 Worker 代码，再测试连接');
    if (!response.ok) throw serviceError(data, `连接检查失败（HTTP ${response.status}）`);
    if (data?.status !== 'readable') throw new Error('上传服务未返回检查结果，请确认已部署新版 Worker 代码');
    setFeedback(status, 'GitHub 连接和图集目录读取正常。写入权限仍需通过实际上传验证。', 'success');
  } catch (error) {
    setFeedback(status, error.name === 'AbortError' ? '等待连接检查超时，请查看 Worker 的实时日志。当前图片已保留。'
      : error instanceof TypeError ? '无法连接上传服务，请检查网络或服务配置。当前图片已保留。' : error.message, 'error');
  } finally {
    state.busy = false;
    syncUploadControls(); renderFiles(); $('#check-connection').focus({ preventScroll: true });
  }
}

async function submitAlbum(event) {
  event.preventDefault(); if (state.busy) return;
  if (state.uploadSaved) { closeUpload(); return; }
  const status = $('#upload-status');
  try {
    validateFiles(state.files, config);
    const title = $('#album-title').value.trim(), seriesId = $('#album-series').value, date = seriesId ? '' : $('#album-date').value;
    if (!title) throw new Error('请填写图集名称');
    if (!seriesId && !validDate(date)) throw new Error('请选择有效的归档日期');
    const description = $('#album-description').value.trim();
    if (!config.uploadEndpoint) {
      state.preview = { id: `preview-${Date.now()}`, title, date, seriesId, description, tags: [], local: true,
        images: state.urls.map((src, index) => ({ src, alt: `${title} · 第 ${index + 1} 页` })) };
      closeUpload({ keepDraft: true }); location.hash = `#/album/${state.preview.id}/1`; return;
    }
    const endpoint = new URL(config.uploadEndpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('上传服务地址需要配置为 HTTPS');
    const code = $('#access-code').value.trim();
    if (!code) throw new Error('请输入上传口令');
    state.busy = true;
    syncUploadControls();
    setFeedback(status, '正在上传并保存，请保持页面打开…');
    const body = new FormData();
    const requestId = state.requestId ||= crypto.randomUUID();
    body.append('requestId', requestId); body.append('title', title); body.append('date', date); body.append('description', description);
    if (seriesId) body.append('seriesId', seriesId);
    state.files.forEach(file => body.append('images', file, file.name));
    const data = await uploadClient.save({ endpoint: endpoint.href, password: code, body,
      onProgress: message => setFeedback(status, message) });
    if (data?.status !== 'committed' || typeof data.commitSha !== 'string') throw new Error('上传服务未返回保存凭据，请先检查图集目录再重试');
    // The commit receipt confirms persistence. Validating against a stale
    // local series list must not turn an already committed upload into failure.
    state.uploadSaved = true; state.uploadDirty = false;
    setFeedback(status, '图集已保存。网站发布需要一点时间，稍后刷新首页即可查看。', 'success');
    $('#access-code').value = '';
    $('#access-code').required = false; $('#publish-notice').hidden = false;
    state.requestId = null;
    uploadClient.reset();
  } catch (error) {
    setFeedback(status, error.name === 'AbortError' ? '等待服务超时，当前草稿已保留，请原样重试；请勿刷新页面。' : error instanceof TypeError ? '无法连接上传服务。请检查网络或服务配置后重试。' : error.message, 'error');
  } finally {
    state.busy = false;
    syncUploadControls(); renderFiles();
    if (uploadDialog.open) (state.uploadSaved ? $('#upload-submit') : status).focus({ preventScroll: true });
  }
}

$('#all-months').addEventListener('click', () => openCollection('archive'));
$('#all-series').addEventListener('click', () => openCollection('series'));
$('#manage-series').addEventListener('click', () => seriesManager.open(state.seriesId));
$('#edit-images').addEventListener('click', () => {
  if (state.album && !state.album.local) imageEditor.open(state.album.id, state.albums.flatMap(album => album.images));
});
$('#album-series').addEventListener('change', () => { syncAlbumLocation(); uploadChanged(); });
$$('.tab').forEach(tab => tab.addEventListener('click', () => { state.type = tab.dataset.type; renderCatalog(); }));
$('#search').addEventListener('input', event => { state.query = event.target.value; renderCatalog(); });
$('#new-album').addEventListener('click', openUpload);
$('#reader-close').addEventListener('click', () => closeReader());
reader.addEventListener('cancel', event => { event.preventDefault(); if (state.expanded) setExpanded(false); else closeReader(); });
$('#prev-page').addEventListener('click', () => goPage(state.page - 1));
$('#next-page').addEventListener('click', () => goPage(state.page + 1));
$('#page-number').addEventListener('change', event => goPage((Number(event.target.value) || 1) - 1));
for (const mode of ['page', 'scroll']) $(`#mode-${mode}`).addEventListener('click', () => {
  if (state.mode === mode) return;
  state.mode = mode; state.hand = false; renderReader();
});
$('#reader-hand').addEventListener('click', () => {
  if (state.mode !== 'page') return;
  state.hand = !state.hand; imageReader?.setHand(state.hand); syncReaderControls();
  if (state.hand) {
    $('#reader-stage').focus({ preventScroll: true });
    toast('拖动查看 · 滚轮或双指缩放 · 点“适屏”复位');
  }
});
$('#zoom-reset').addEventListener('click', () => imageReader?.reset());
$('#fullscreen').addEventListener('click', () => setExpanded(!state.expanded));
$('#copy-link').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(location.href); toast('已复制当前阅读链接'); }
  catch { toast('复制未成功，请复制浏览器地址栏中的链接'); }
});
$('#upload-close').addEventListener('click', () => closeUpload());
uploadDialog.addEventListener('cancel', event => { event.preventDefault(); closeUpload(); });
$('#upload-form').addEventListener('submit', submitAlbum);
$('#check-connection').addEventListener('click', checkConnection);
for (const selector of ['#album-title', '#album-date', '#album-description']) $(selector).addEventListener('input', uploadChanged);
$('#file-input').addEventListener('change', event => addFiles([...event.target.files]));
const drop = $('#drop-zone');
for (const name of ['dragenter', 'dragover']) drop.addEventListener(name, event => { event.preventDefault(); if (!state.busy && !state.uploadSaved) drop.classList.add('dragover'); });
for (const name of ['dragleave', 'drop']) drop.addEventListener(name, event => { event.preventDefault(); drop.classList.remove('dragover'); });
drop.addEventListener('drop', event => addFiles([...event.dataTransfer.files]));
window.addEventListener('hashchange', route);
// Observe the actual reading area: wrapping controls, rotation and viewport
// changes can alter its height without changing the image dimensions.
let readerResizeFrame;
new ResizeObserver(() => {
  cancelAnimationFrame(readerResizeFrame);
  readerResizeFrame = requestAnimationFrame(resizeReader);
}).observe($('#reader-stage'));
document.addEventListener('keydown', event => {
  if ($('#image-preview').open || uploadDialog.open) return;
  if ($('#image-editor').open || $('#series-manager').open) return;
  if (event.target.closest('input, textarea, select, [contenteditable]') || event.ctrlKey || event.metaKey || event.altKey) return;
  if (reader.open) {
    if (state.expanded && ['ArrowUp', 'PageUp'].includes(event.key)) { event.preventDefault(); goPage(state.page - 1); }
    if (state.expanded && ['ArrowDown', 'PageDown'].includes(event.key)) { event.preventDefault(); goPage(state.page + 1); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); goPage(state.page - 1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); goPage(state.page + 1); }
    if (event.key === 'Home') { event.preventDefault(); goPage(0); }
    if (event.key === 'End') { event.preventDefault(); goPage(state.album.images.length - 1); }
  } else if (!uploadDialog.open && event.key === '/') { event.preventDefault(); $('#search').focus(); }
});
loadAlbums();
