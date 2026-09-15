import config from '../config.js';
import { normalizeManifest, groupByMonth, filterAlbums, validDate, validateFiles } from './model.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { albums: [], query: '', month: '', type: 'all', expanded: false,
  album: null, page: 0, mode: 'page', zoom: 1, preview: null, files: [], urls: [], requestId: null, busy: false, loadError: false, scrollY: 0 };
const reader = $('#reader');
const uploadDialog = $('#upload-dialog');
let pageObserver;
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
function updateBodyLock() { document.body.classList.toggle('modal-open', reader.open || uploadDialog.open); }
function localDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
function imageNode(image, lazy = true) {
  const img = el('img'); img.src = image.src; img.alt = image.alt;
  img.loading = lazy ? 'lazy' : 'eager'; img.decoding = 'async';
  if (image.width && image.height) { img.width = image.width; img.height = image.height; }
  return img;
}

async function loadAlbums() {
  $('#collection').setAttribute('aria-busy', 'true');
  try {
    const response = await fetch(config.manifestUrl, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`目录加载失败（${response.status}）`);
    state.albums = normalizeManifest(await response.json(), document.baseURI);
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
    const link = button('', `month-link${state.month === month ? ' active' : ''}`, () => {
      state.month = month; renderCatalog();
    });
    link.setAttribute('aria-label', `${year} 年 ${Number(month.slice(5))} 月，${albums.length} 个图集`);
    if (state.month === month) link.setAttribute('aria-current', 'true');
    link.append(el('span', '', `${Number(month.slice(5))} 月`), el('span', '', String(albums.length)));
    yearGroup.append(link);
  }
  $('#all-months').classList.toggle('active', !state.month);
  $('#all-months').setAttribute('aria-pressed', String(!state.month));
  $('#nav-count').textContent = state.albums.length;
}

function emptyState(kind) {
  const box = el('section', 'empty-state');
  if (kind === 'empty') {
    const add = button('', 'primary-button', openUpload); add.append(icon('plus'), el('span', '', '添加图集'));
    box.append(icon('images'), el('h2', '', '还没有图集'), el('p', '', '添加图片后，会按日期归档。'), add);
  } else if (kind === 'error') {
    box.append(el('h2', '', '暂时无法加载图集'), el('p', '', state.errorMessage), button('重新加载', 'secondary-button', loadAlbums));
  } else {
    box.append(el('h2', '', '没有找到相符的图集'), el('p', '', '试试其他关键词，或清除当前筛选。'), button('清除筛选', 'secondary-button', () => {
      state.query = ''; state.month = ''; state.type = 'all'; $('#search').value = ''; renderCatalog();
    }));
  }
  return box;
}

function renderCatalog() {
  renderNav();
  const filtered = filterAlbums(state.albums, state);
  $('#album-count').textContent = filtered.length;
  $('#image-count').textContent = filtered.reduce((count, album) => count + album.images.length, 0);
  const title = state.month ? `${state.month.slice(0, 4)} 年 ${Number(state.month.slice(5))} 月` : '全部图集';
  $('#page-title').textContent = title;
  $$('.tab').forEach(tab => {
    const active = tab.dataset.type === state.type;
    tab.classList.toggle('active', active); tab.setAttribute('aria-pressed', String(active));
  });
  $('#result-summary').textContent = state.query ? `“${state.query}” · 找到 ${filtered.length} 个图集` : '';
  const container = $('#collection'); container.replaceChildren();
  if (state.loadError) { container.append(emptyState('error')); return; }
  if (!filtered.length) { container.append(emptyState(state.albums.length ? 'filtered' : 'empty')); return; }
  for (const [month, albums] of groupByMonth(filtered)) {
    const section = el('section', 'month-section'); section.dataset.month = month;
    const header = el('div', 'month-heading');
    const number = el('h2', 'month-number', month.slice(5)); number.append(el('span', '', '月'));
    number.setAttribute('aria-label', `${month.slice(0, 4)} 年 ${Number(month.slice(5))} 月`);
    const year = el('time', 'month-year', month.slice(0, 4)); year.dateTime = month;
    header.append(number, year);
    const grid = el('div', 'album-grid');
    for (const album of albums) {
      const card = el('a', `album-card${album.images.length > 1 ? ' multiple' : ''}`);
      card.href = `#/album/${encodeURIComponent(album.id)}/1`;
      card.setAttribute('aria-label', `阅读 ${album.title}，${album.images.length} 张图片`);
      const cover = el('div', 'cover');
      const coverImage = imageNode({ ...album.images[0], alt: '' });
      coverImage.addEventListener('error', () => { coverImage.hidden = true; cover.prepend(el('span', 'card-description', '封面暂时无法显示')); }, { once: true });
      const badge = el('span', 'image-badge'); badge.append(icon(album.images.length > 1 ? 'images' : 'image'));
      badge.append(document.createTextNode(`${album.images.length} 张`)); cover.append(coverImage);
      const info = el('div', 'card-info'); info.append(el('h3', '', album.title));
      if (album.description) info.append(el('p', 'card-description', album.description));
      const meta = el('div', 'card-meta');
      const date = el('time', '', album.date.replaceAll('-', '.')); date.dateTime = album.date; meta.append(date);
      if (album.tags[0]) meta.append(el('span', 'tag', album.tags[0]));
      meta.append(badge); info.append(meta); card.append(cover, info); grid.append(card);
    }
    section.append(header, grid); container.append(section);
  }
}

function route() {
  const match = location.hash.match(/^#\/album\/([a-zA-Z0-9_-]+)(?:\/(\d+))?$/);
  if (!match) { closeReader(false); return; }
  const album = state.albums.find(item => item.id === match[1]) || (state.preview?.id === match[1] ? state.preview : null);
  if (!album) {
    history.replaceState(null, '', location.pathname + location.search); closeReader(false);
    toast('找不到这份图集，可能已移除或尚未发布。'); return;
  }
  const changed = state.album?.id !== album.id;
  state.album = album;
  state.page = Math.max(0, Math.min(album.images.length - 1, Number(match[2] || 1) - 1));
  if (changed) { state.zoom = 1; state.mode = 'page'; }
  if (!reader.open) {
    state.scrollY = window.scrollY; lastFocused = document.activeElement;
    reader.showModal(); updateBodyLock(); $('#reader-close').focus();
  }
  $('#reader-title').textContent = album.title;
  $('#reader-meta').textContent = `${album.date.replaceAll('-', '.')}  ·  ${album.images.length} 张图片${album.local ? '  ·  本地预览，尚未保存' : ''}`;
  $('#copy-link').disabled = !!album.local;
  document.title = `${album.title} · 图集`;
  renderReader();
}

function setExpanded(expanded) {
  state.expanded = expanded;
  reader.classList.toggle('expanded', expanded);
  const control = $('#fullscreen');
  const label = expanded ? '退出网页全屏' : '网页全屏';
  control.setAttribute('aria-pressed', String(expanded));
  control.setAttribute('aria-label', label); control.title = label;
  control.replaceChildren(icon(expanded ? 'collapse' : 'expand'));
  if (reader.open && state.album) applyZoom();
}

function closeReader(changeRoute = true) {
  setExpanded(false);
  pageObserver?.disconnect();
  if (reader.open) {
    reader.close(); updateBodyLock();
    if ($('#toast').parentElement === reader) document.body.append($('#toast'));
    window.scrollTo(0, state.scrollY); lastFocused?.focus({ preventScroll: true });
  }
  state.album = null;
  document.title = '图集 · SherlockGy';
  if (changeRoute) history.replaceState(null, '', location.pathname + location.search);
}

function syncReaderControls() {
  const total = state.album.images.length;
  $('.segmented', reader).hidden = total === 1;
  $('.reader-footer', reader).hidden = total === 1;
  $('#page-number').value = state.page + 1; $('#page-number').max = total;
  $('#page-total').textContent = `/ ${total} 页`;
  $('#prev-page').disabled = state.page === 0;
  $('#next-page').disabled = state.page === total - 1;
  $('#original-image').href = state.album.images[state.page].src;
  $('#zoom-reset').textContent = state.zoom === 1 ? '适宽' : `${Math.round(state.zoom * 100)}%`;
  $('#zoom-out').disabled = state.zoom <= .5; $('#zoom-in').disabled = state.zoom >= 3;
  for (const mode of ['page', 'scroll']) {
    $(`#mode-${mode}`).classList.toggle('active', state.mode === mode);
    $(`#mode-${mode}`).setAttribute('aria-pressed', String(state.mode === mode));
  }
}

function renderReader() {
  pageObserver?.disconnect();
  const stage = $('#reader-stage'); stage.replaceChildren();
  const images = state.mode === 'scroll' ? state.album.images.map((image, index) => [image, index]) : [[state.album.images[state.page], state.page]];
  for (const [image, index] of images) {
    const figure = el('figure', 'reader-page'); figure.dataset.index = index;
    const img = imageNode(image, state.mode === 'scroll' && Math.abs(index - state.page) > 1);
    img.addEventListener('error', () => {
      img.hidden = true;
      const error = el('div', 'image-error'); error.append(el('p', '', '这张图片暂时无法加载'));
      error.append(button('重新加载图片', 'text-button', () => { error.remove(); img.hidden = false; img.src = image.src; })); figure.prepend(error);
    });
    figure.append(img, el('figcaption', '', `${String(index + 1).padStart(2, '0')} / ${String(state.album.images.length).padStart(2, '0')}`));
    stage.append(figure);
  }
  applyZoom(); stage.scrollTop = 0; stage.scrollLeft = 0;
  if (state.mode === 'scroll') {
    const current = $(`[data-index="${state.page}"]`, stage);
    current?.scrollIntoView({ block: 'start' });
    pageObserver = new IntersectionObserver(entries => {
      if (!state.album || state.mode !== 'scroll') return;
      const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => Math.abs(a.boundingClientRect.top - stage.getBoundingClientRect().top) - Math.abs(b.boundingClientRect.top - stage.getBoundingClientRect().top));
      if (visible[0]) {
        state.page = Number(visible[0].target.dataset.index); syncReaderControls();
        history.replaceState(null, '', `#/album/${state.album.id}/${state.page + 1}`);
      }
    }, { root: stage, rootMargin: '0px 0px -65% 0px', threshold: 0 });
    $$('.reader-page', stage).forEach(figure => pageObserver.observe(figure));
  }
  syncReaderControls();
}

function applyZoom() {
  if (!state.album || !reader.open) return;
  const stage = $('#reader-stage'), style = getComputedStyle(stage);
  const available = Math.max(1, stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
  const width = Math.round((state.expanded ? available : Math.min(1120, available)) * state.zoom);
  $$('.reader-page').forEach(figure => {
    figure.style.width = `${width}px`;
    figure.classList.toggle('zoomed', width > available);
  });
  syncReaderControls();
}
function goPage(page) {
  if (!state.album) return;
  const target = Number.isFinite(page) ? Math.trunc(page) : 0;
  state.page = Math.max(0, Math.min(state.album.images.length - 1, target));
  history.replaceState(null, '', `#/album/${state.album.id}/${state.page + 1}`);
  if (state.mode === 'scroll') {
    $(`[data-index="${state.page}"]`, $('#reader-stage'))?.scrollIntoView({ block: 'start' }); syncReaderControls();
  } else renderReader();
}

function resetDraft() {
  state.urls.forEach(url => URL.revokeObjectURL(url));
  state.files = []; state.urls = []; state.preview = null; state.requestId = null;
  $('#upload-form').reset(); $('#album-date').value = localDate(); $('#upload-status').textContent = '';
  $('#upload-status').className = 'upload-status'; renderFiles();
}
function openUpload() {
  resetDraft();
  $('#upload-hint').textContent = config.uploadEndpoint
    ? '第一张图片作为封面，添加后可调整顺序。'
    : '上传服务尚未连接。你可以先命名、排序并预览图片；本地预览不会保存，关闭或刷新页面后失效。';
  $('#upload-submit').textContent = config.uploadEndpoint ? '保存图集' : '预览图集';
  $('#access-code-field').hidden = !config.uploadEndpoint;
  $('#access-code').required = !!config.uploadEndpoint;
  uploadDialog.showModal(); updateBodyLock(); $('#album-title').focus();
}
function closeUpload() {
  if (state.busy) return;
  $('#access-code').value = ''; uploadDialog.close(); updateBodyLock();
}

async function addFiles(incoming) {
  if (state.busy) return;
  const next = [...state.files, ...incoming];
  try {
    validateFiles(next, config);
    state.files = next; state.requestId = null;
    state.urls.push(...incoming.map(file => URL.createObjectURL(file)));
    $('#upload-status').textContent = '';
    if (!$('#album-title').value && incoming[0]) $('#album-title').value = incoming[0].name.replace(/\.[^.]+$/, '').slice(0, 120);
    renderFiles();
  } catch (error) { $('#upload-status').textContent = error.message; }
  $('#file-input').value = '';
}
function renderFiles() {
  const list = $('#file-list'); list.replaceChildren();
  state.files.forEach((file, index) => {
    const row = el('div', 'file-item');
    const img = el('img'); img.src = state.urls[index]; img.alt = '';
    const name = el('span', 'file-name', file.name); name.append(el('small', '', `${(file.size / 1048576).toFixed(2)} MB${index === 0 ? ' · 封面' : ''}`));
    row.append(el('span', 'file-order', String(index + 1).padStart(2, '0')), img, name);
    for (const [label, delta, name] of [['向前移动', -1, 'chevron-up'], ['向后移动', 1, 'chevron-down']]) {
      const move = button('', 'icon-button', () => {
        const target = index + delta; state.requestId = null;
        [state.files[index], state.files[target]] = [state.files[target], state.files[index]];
        [state.urls[index], state.urls[target]] = [state.urls[target], state.urls[index]];
        renderFiles();
      });
      move.append(icon(name)); move.title = label;
      move.setAttribute('aria-label', `${label}第 ${index + 1} 张图片`); move.disabled = state.busy || index + delta < 0 || index + delta >= state.files.length;
      row.append(move);
    }
    const remove = button('', 'icon-button', () => {
      state.requestId = null; URL.revokeObjectURL(state.urls[index]); state.files.splice(index, 1); state.urls.splice(index, 1); renderFiles();
    });
    remove.append(icon('close')); remove.title = '移除图片';
    remove.setAttribute('aria-label', `移除第 ${index + 1} 张图片`); remove.disabled = state.busy; row.append(remove); list.append(row);
  });
  $('#file-summary').textContent = state.files.length ? `${state.files.length} 张图片 · ${(state.files.reduce((sum, file) => sum + file.size, 0) / 1048576).toFixed(1)} MB` : '尚未选择图片';
}

function serviceError(data, fallback) {
  const message = data?.error?.message || fallback;
  const traceId = data?.error?.traceId;
  return new Error(typeof traceId === 'string' ? `${message}（请求编号：${traceId}）` : message);
}

async function checkConnection() {
  if (state.busy || !config.uploadEndpoint) return;
  const status = $('#upload-status'); status.className = 'upload-status';
  try {
    const endpoint = new URL(config.uploadEndpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('上传服务地址需要配置为 HTTPS');
    const code = $('#access-code').value.trim();
    if (!code) throw new Error('请先输入上传口令，再测试连接');
    state.busy = true;
    $$('#upload-form input, #upload-form textarea, #upload-form button').forEach(node => node.disabled = true);
    status.textContent = '正在检查连接和图集目录，请稍候…';
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 75000);
    let response, data;
    try {
      response = await fetch(new URL('/check', endpoint), { method: 'POST', headers: { Authorization: `Bearer ${code}` }, signal: controller.signal, redirect: 'error', credentials: 'omit' });
      data = await response.json().catch(error => { if (controller.signal.aborted) throw error; return null; });
    } finally { clearTimeout(timer); }
    if (response.status === 404) throw new Error('请先在 Cloudflare 部署新版 Worker 代码，再测试连接');
    if (!response.ok) throw serviceError(data, `连接检查失败（HTTP ${response.status}）`);
    if (data?.status !== 'readable') throw new Error('上传服务未返回检查结果，请确认已部署新版 Worker 代码');
    status.className = 'upload-status success';
    status.textContent = 'GitHub 连接和图集目录读取正常。写入权限仍需通过实际上传验证。';
  } catch (error) {
    status.textContent = error.name === 'AbortError' ? '等待连接检查超时，请查看 Worker 的实时日志。当前图片已保留。'
      : error instanceof TypeError ? '无法连接上传服务，请检查网络或服务配置。当前图片已保留。' : error.message;
  } finally {
    state.busy = false;
    $$('#upload-form input, #upload-form textarea, #upload-form button').forEach(node => node.disabled = false);
    renderFiles();
  }
}

async function submitAlbum(event) {
  event.preventDefault(); if (state.busy) return;
  const status = $('#upload-status'); status.className = 'upload-status';
  try {
    validateFiles(state.files, config);
    const title = $('#album-title').value.trim(), date = $('#album-date').value;
    if (!title) throw new Error('请填写图集名称');
    if (!validDate(date)) throw new Error('请选择有效的归档日期');
    const description = $('#album-description').value.trim();
    if (!config.uploadEndpoint) {
      state.preview = { id: `preview-${Date.now()}`, title, date, description, tags: [], local: true,
        images: state.urls.map((src, index) => ({ src, alt: `${title} · 第 ${index + 1} 页` })) };
      closeUpload(); location.hash = `#/album/${state.preview.id}/1`; return;
    }
    const endpoint = new URL(config.uploadEndpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('上传服务地址需要配置为 HTTPS');
    const code = $('#access-code').value.trim();
    if (!code) throw new Error('请输入上传口令');
    state.busy = true;
    $$('#upload-form input, #upload-form textarea, #upload-form button').forEach(node => node.disabled = true);
    status.textContent = '正在上传并保存，请保持页面打开…';
    const body = new FormData();
    const requestId = state.requestId ||= crypto.randomUUID();
    body.append('requestId', requestId); body.append('title', title); body.append('date', date); body.append('description', description);
    state.files.forEach(file => body.append('images', file, file.name));
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 120000);
    let response, data;
    try {
      response = await fetch(endpoint.href, { method: 'POST', headers: { Authorization: `Bearer ${code}` }, body, signal: controller.signal, redirect: 'error', credentials: 'omit' });
      data = await response.json().catch(error => { if (controller.signal.aborted) throw error; return null; });
    } finally { clearTimeout(timer); }
    if (!response.ok) throw serviceError(data, { 401: '上传口令不正确', 403: '没有上传权限', 413: '图片总大小超过上传服务限制', 409: '目录已更新，请刷新检查后重试' }[response.status] || `上传失败（${response.status}）`);
    if (data?.status !== 'committed' || typeof data.commitSha !== 'string') throw new Error('上传服务未返回保存凭据，请先检查图集目录再重试');
    normalizeManifest({ schemaVersion: 1, albums: [data.album] }, document.baseURI);
    status.className = 'upload-status success';
    status.textContent = '图集已保存。网站发布需要一点时间，稍后刷新首页即可查看。';
    $('#access-code').value = '';
    state.urls.forEach(url => URL.revokeObjectURL(url)); state.urls = []; state.files = []; state.requestId = null;
    $('#album-title').value = ''; $('#album-description').value = '';
  } catch (error) {
    status.textContent = error.name === 'AbortError' ? '等待上传服务超时。图片可能已保存，请先刷新检查，避免重复上传。' : error instanceof TypeError ? '无法连接上传服务。请检查网络或服务配置后重试。' : error.message;
  } finally {
    state.busy = false;
    $$('#upload-form input, #upload-form textarea, #upload-form button').forEach(node => node.disabled = false);
    renderFiles();
  }
}

$('#all-months').addEventListener('click', () => { state.month = ''; renderCatalog(); });
$$('.tab').forEach(tab => tab.addEventListener('click', () => { state.type = tab.dataset.type; renderCatalog(); }));
$('#search').addEventListener('input', event => { state.query = event.target.value; renderCatalog(); });
$('#new-album').addEventListener('click', openUpload);
$('#reader-close').addEventListener('click', () => closeReader());
reader.addEventListener('cancel', event => { event.preventDefault(); if (state.expanded) setExpanded(false); else closeReader(); });
$('#prev-page').addEventListener('click', () => goPage(state.page - 1));
$('#next-page').addEventListener('click', () => goPage(state.page + 1));
$('#page-number').addEventListener('change', event => goPage((Number(event.target.value) || 1) - 1));
for (const mode of ['page', 'scroll']) $(`#mode-${mode}`).addEventListener('click', () => { state.mode = mode; renderReader(); });
$('#zoom-out').addEventListener('click', () => { state.zoom = Math.max(.5, state.zoom - .25); applyZoom(); });
$('#zoom-in').addEventListener('click', () => { state.zoom = Math.min(3, state.zoom + .25); applyZoom(); });
$('#zoom-reset').addEventListener('click', () => { state.zoom = 1; applyZoom(); });
$('#fullscreen').addEventListener('click', () => setExpanded(!state.expanded));
$('#copy-link').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(location.href); toast('已复制当前阅读链接'); }
  catch { toast('复制未成功，请复制浏览器地址栏中的链接'); }
});
$('#upload-close').addEventListener('click', closeUpload);
uploadDialog.addEventListener('cancel', event => { event.preventDefault(); closeUpload(); });
$('#upload-form').addEventListener('submit', submitAlbum);
$('#check-connection').addEventListener('click', checkConnection);
for (const selector of ['#album-title', '#album-date', '#album-description']) $(selector).addEventListener('input', () => { state.requestId = null; });
$('#file-input').addEventListener('change', event => addFiles([...event.target.files]));
const drop = $('#drop-zone');
for (const name of ['dragenter', 'dragover']) drop.addEventListener(name, event => { event.preventDefault(); if (!state.busy) drop.classList.add('dragover'); });
for (const name of ['dragleave', 'drop']) drop.addEventListener(name, event => { event.preventDefault(); drop.classList.remove('dragover'); });
drop.addEventListener('drop', event => addFiles([...event.dataTransfer.files]));
window.addEventListener('hashchange', route);
window.addEventListener('resize', () => { if (reader.open) applyZoom(); });
document.addEventListener('keydown', event => {
  if (event.target.closest('input, textarea, select, [contenteditable]') || event.ctrlKey || event.metaKey || event.altKey) return;
  if (reader.open) {
    if (event.key === 'ArrowLeft') { event.preventDefault(); goPage(state.page - 1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); goPage(state.page + 1); }
    if (event.key === 'Home') { event.preventDefault(); goPage(0); }
    if (event.key === 'End') { event.preventDefault(); goPage(state.album.images.length - 1); }
  } else if (!uploadDialog.open && event.key === '/') { event.preventDefault(); $('#search').focus(); }
});
loadAlbums();
