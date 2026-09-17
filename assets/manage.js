import config from '../config.js';
import { createUploadClient } from './upload.js?v=20260917-upload-1';
import { normalizeManifest, normalizeSeries, flattenSeries, seriesTrail, validateFiles, validDate } from './model.js?v=20260917-thumbs-1';

function node(tag, className, text) {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}
function action(text, callback, className = 'secondary-button') {
  const button = node('button', className, text); button.type = 'button';
  button.addEventListener('click', callback); return button;
}
function input(label, value = '', type = 'text') {
  const wrapper = node('label', 'manager-field'); wrapper.append(node('span', 'field-label', label));
  const control = node('input', 'form-input'); control.type = type; control.value = value;
  if (type === 'text') control.maxLength = 120;
  wrapper.append(control); return { wrapper, control };
}
function seriesSelect(series, value, rootLabel, exclude = '') {
  const select = node('select', 'form-input'); select.append(new Option(rootLabel, ''));
  for (const item of flattenSeries(series)) {
    if (exclude && seriesTrail(series, item.id).some(entry => entry.id === exclude)) continue;
    select.append(new Option(seriesTrail(series, item.id).map(entry => entry.title).join(' / '), item.id));
  }
  select.value = value; return select;
}
async function service(path, password, body) {
  if (!config.uploadEndpoint) throw new Error('请先配置上传服务');
  const endpoint = new URL(config.uploadEndpoint);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('上传服务地址需要配置为 HTTPS');
  if (!password.trim()) throw new Error('请输入上传口令');
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), body ? 120000 : 75000);
  try {
    const response = await fetch(new URL(path, endpoint), { method: body ? 'POST' : 'GET', body,
      headers: { Authorization: `Bearer ${password.trim()}` }, signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
    const data = await response.json().catch(error => { if (controller.signal.aborted) throw error; return null; });
    if (!response.ok) {
      const error = new Error(data?.error?.message || (response.status === 404 ? '请先部署支持编辑与系列的新版 Worker' : `请求失败（HTTP ${response.status}）`));
      error.code = data?.error?.code;
      if (data?.error?.traceId) error.message += `（请求编号：${data.error.traceId}）`;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('等待服务超时，当前草稿已保留。可原样重试；请勿刷新页面。');
    if (error instanceof TypeError) throw new Error('无法连接上传服务，当前草稿已保留。请检查网络或 Worker 配置。');
    throw error;
  } finally { clearTimeout(timer); }
}

function managerDialog(id, title, description, onOpenChange) {
  const uploadClient = createUploadClient();
  const dialog = node('dialog', 'upload-dialog manager-dialog'); dialog.id = id; dialog.setAttribute('aria-labelledby', `${id}-title`);
  dialog.innerHTML = `<form><header class="dialog-header"><h2 id="${id}-title"></h2><button type="button" class="icon-button manager-close" aria-label="关闭"><svg class="icon" aria-hidden="true"><use href="./assets/icons.svg#close"/></svg></button></header>
    <div class="dialog-content"><p class="form-hint manager-description"></p>
    <label class="field-label" for="${id}-password">上传口令</label><div class="access-code-row"><input id="${id}-password" class="form-input manager-password" type="password" autocomplete="off" placeholder="输入口令" required><button type="button" class="secondary-button manager-load">载入最新内容</button></div>
    <p class="field-note">关闭窗口后清除口令；修改后点击保存才会生效。</p><div class="manager-workspace" hidden></div><p class="upload-status" role="status" aria-live="polite"></p></div>
    <footer class="dialog-footer"><span class="manager-summary">请先载入最新内容</span><button type="submit" class="primary-button manager-save" disabled>保存修改</button></footer></form>`;
  document.body.append(dialog);
  const $ = selector => dialog.querySelector(selector);
  $('h2').textContent = title; $('.manager-description').textContent = description;
  const model = { dialog, workspace: $('.manager-workspace'), busy: false, dirty: false, loaded: false, saved: false, requestId: null, revision: null };
  model.status = (message, success = false) => { $('.upload-status').textContent = message; $('.upload-status').className = `upload-status${success ? ' success' : ''}`; };
  model.sync = () => {
    dialog.querySelectorAll('input, textarea, select, button').forEach(control => { control.disabled = model.busy || model.saved; });
    $('.manager-close').disabled = model.busy;
    $('.manager-save').disabled = model.busy || (!model.saved && (!model.loaded || !model.dirty));
    $('.manager-save').textContent = model.saved ? '完成' : '保存修改';
    model.workspace.querySelectorAll('[data-boundary="true"]').forEach(control => { control.disabled = true; });
  };
  model.changed = () => { model.dirty = true; model.requestId = null; model.status(''); model.sync(); };
  model.summary = text => { $('.manager-summary').textContent = text; };
  model.close = () => {
    if (model.busy || (model.dirty && !confirm('还有未保存的修改，确定放弃并关闭吗？'))) return;
    uploadClient.reset(); model.dispose?.(); $('.manager-password').value = ''; dialog.close(); onOpenChange();
  };
  model.open = () => {
    uploadClient.reset();
    model.dispose?.(); Object.assign(model, { busy: false, dirty: false, loaded: false, saved: false, requestId: null, revision: null });
    model.workspace.replaceChildren(); model.workspace.hidden = true;
    $('.manager-password').value = ''; $('.manager-load').textContent = '载入最新内容';
    model.status(''); model.summary('请先载入最新内容'); model.sync(); dialog.showModal(); onOpenChange();
    $('.dialog-content').scrollTop = 0; $('.manager-password').focus();
  };
  model.load = async () => {
    if (model.busy || model.saved || (model.dirty && !confirm('重新载入会放弃当前修改，继续吗？'))) return;
    model.busy = true; model.sync(); model.status('正在载入最新内容…');
    try {
      const data = await service(model.path, $('.manager-password').value);
      if (!data || !/^[a-f0-9]{64}$/.test(data.revision)) throw new Error('请先部署支持编辑与系列的新版 Worker');
      model.receive(data); model.revision = data.revision; uploadClient.reset();
      model.loaded = true; model.dirty = false; model.requestId = null;
      model.workspace.hidden = false; $('.manager-load').textContent = '重新载入'; model.status('');
    } catch (error) { model.status(error.message); }
    finally { model.busy = false; model.sync(); }
  };
  $('.manager-load').addEventListener('click', model.load);
  $('.manager-close').addEventListener('click', model.close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); model.close(); });
  $('form').addEventListener('submit', async event => {
    event.preventDefault();
    if (model.saved) { model.close(); return; }
    if (!model.loaded) { await model.load(); return; }
    if (model.busy || !model.dirty) return;
    model.busy = true; model.sync(); model.status('正在保存，请保持窗口打开…');
    try {
      const body = model.payload();
      body.set('revision', model.revision); body.set('requestId', model.requestId ||= crypto.randomUUID());
      const data = model.path.startsWith('/albums/')
        ? await uploadClient.save({ endpoint: new URL(model.path, config.uploadEndpoint).href,
          password: $('.manager-password').value, body, onProgress: message => model.status(message) })
        : await service(model.path, $('.manager-password').value, body);
      if (!['committed', 'unchanged'].includes(data?.status) || (data.status === 'committed' && typeof data.commitSha !== 'string')) throw new Error('服务未返回保存凭据，请保留草稿并原样重试');
      model.saved = true; model.dirty = false; $('.manager-password').value = ''; $('.manager-password').required = false;
      uploadClient.reset();
      model.status(data.status === 'unchanged' ? '内容没有变化。' : '已保存。网站发布需要一点时间，稍后刷新查看。', true);
      model.onSaved?.(data);
    } catch (error) { model.status(error.message); }
    finally { model.busy = false; model.sync(); }
  });
  dialog.addEventListener('close', () => { $('.manager-password').required = true; });
  return model;
}

export function buildImageOrder(items) {
  const files = [];
  const order = items.map(item => {
    if (!item.file) return { existing: item.existing };
    const file = files.push(item.file) - 1;
    return { file, ...(item.existing === undefined ? {} : { replaces: item.existing }) };
  });
  return { files, order };
}

export function createImageEditor(onOpenChange, onSaved) {
  const ui = managerDialog('image-editor', '编辑图集', '修改名称与说明，或调整图片。第一张作为封面；分享链接仍按页码定位。', onOpenChange);
  let album, items = [], pickerTarget, draftTitle = '', draftDescription = '', canRename = false, canEditDescription = false, series = [];
  const revoke = item => { if (item.file) URL.revokeObjectURL(item.src); };
  ui.dispose = () => { items.forEach(revoke); items = []; };
  ui.onSaved = data => onSaved({ ...data, series });
  const render = () => {
    ui.workspace.replaceChildren();
    const title = input('图集名称', draftTitle);
    title.control.required = true; title.control.readOnly = !canRename;
    title.control.addEventListener('input', () => {
      if (!canRename || ui.busy || ui.saved) return;
      draftTitle = title.control.value; ui.changed();
    });
    ui.workspace.append(title.wrapper);
    if (!canRename) ui.workspace.append(node('p', 'field-note', '当前上传服务暂不支持修改名称，图片编辑仍可使用。'));
    const descriptionField = node('label', 'manager-field editor-description');
    const descriptionLabel = node('span', 'field-label', '说明');
    descriptionLabel.append(node('span', 'optional', '选填，最多 1000 字'));
    const description = node('textarea', 'form-input');
    description.value = draftDescription; description.maxLength = 1000; description.rows = 3;
    description.placeholder = '主题、出处或备注'; description.readOnly = !canEditDescription;
    description.addEventListener('input', () => {
      if (!canEditDescription || ui.busy || ui.saved) return;
      draftDescription = description.value; ui.changed();
    });
    descriptionField.append(descriptionLabel, description); ui.workspace.append(descriptionField);
    if (!canEditDescription) ui.workspace.append(node('p', 'field-note', '当前上传服务暂不支持修改说明，更新服务后即可编辑。'));
    const picker = node('input', 'visually-hidden'); picker.type = 'file'; picker.accept = 'image/jpeg,image/png,image/webp,image/gif,image/avif';
    const choose = target => { pickerTarget = target; picker.multiple = target === undefined; picker.value = ''; picker.click(); };
    const applyFiles = incoming => {
      if (ui.busy || ui.saved || !incoming.length) return;
      try {
        const current = items.filter(item => item !== pickerTarget && item.file).map(item => item.file);
        validateFiles([...current, ...incoming], config);
        if ((pickerTarget ? items.length : items.length + incoming.length) > config.maxFiles) throw new Error('每个图集最多 30 张图片');
        if (pickerTarget) {
          revoke(pickerTarget); Object.assign(pickerTarget, { file: incoming[0], src: URL.createObjectURL(incoming[0]) });
        } else items.push(...incoming.map(file => ({ file, src: URL.createObjectURL(file) })));
        ui.changed(); render();
      } catch (error) { ui.status(error.message); }
    };
    picker.addEventListener('change', () => applyFiles([...picker.files]));
    const add = action('添加图片', () => choose(undefined), 'primary-button');
    const drop = node('div', 'editor-add'); drop.append(add, node('span', 'field-note', '也可将图片拖到这里。单张 10 MB，本次新增与换图合计 30 MB。'));
    for (const eventName of ['dragenter', 'dragover']) drop.addEventListener(eventName, event => { event.preventDefault(); });
    drop.addEventListener('drop', event => { event.preventDefault(); pickerTarget = undefined; applyFiles([...event.dataTransfer.files]); });
    ui.workspace.append(drop, picker);
    const list = node('div', 'editor-list');
    items.forEach((item, index) => {
      const row = node('div', 'editor-item');
      const preview = node('img'); preview.src = item.src; preview.alt = `第 ${index + 1} 张预览`;
      const label = node('div', 'editor-label'); label.append(node('strong', '', `${index + 1}${index === 0 ? ' · 封面' : ''}`),
        node('span', 'file-name', item.file ? item.file.name : `原第 ${item.existing + 1} 张`),
        node('small', 'field-note', item.file ? item.existing === undefined ? '待新增' : '待替换' : '已保存'));
      const controls = node('div', 'editor-controls');
      for (const [text, delta] of [['上移', -1], ['下移', 1]]) {
        const move = action(text, () => {
          [items[index], items[index + delta]] = [items[index + delta], items[index]]; ui.changed(); render();
          listFocus(index + delta, text);
        });
        move.setAttribute('aria-label', `${text}第 ${index + 1} 张`);
        move.dataset.boundary = String(index + delta < 0 || index + delta >= items.length); controls.append(move);
      }
      controls.append(action('换图', () => choose(item)));
      if (item.file) controls.append(action(item.existing === undefined ? '移除' : '撤销换图', () => {
        revoke(item);
        if (item.existing === undefined) items.splice(index, 1);
        else { delete item.file; item.src = album.images[item.existing].src; }
        ui.changed(); render();
      }, 'text-button'));
      row.append(preview, label, controls); list.append(row);
    });
    ui.workspace.append(list); ui.summary(`${items.length} / 30 张图片`); ui.sync();
  };
  const listFocus = (index, text) => ui.workspace.querySelectorAll('.editor-item')[index]?.querySelector(`[aria-label="${text}第 ${index + 1} 张"]`)?.focus();
  ui.receive = data => {
    const next = normalizeManifest({ schemaVersion: 1, albums: [data.album], series: data.series }, document.baseURI)[0];
    ui.dispose(); album = next; draftTitle = album.title; draftDescription = album.description;
    canRename = data.capabilities?.editTitle === true; canEditDescription = data.capabilities?.editDescription === true; series = data.series || [];
    items = album.images.map((image, existing) => ({ existing, src: image.src })); render();
  };
  ui.payload = () => {
    const { files, order } = buildImageOrder(items); if (files.length) validateFiles(files, config);
    const body = new FormData(); body.set('order', JSON.stringify(order));
    const title = draftTitle.trim();
    if (!title || title.length > 120) throw new Error('图集名称须为 1–120 字');
    if (title !== album.title) {
      if (!canRename) throw new Error('当前上传服务暂不支持修改图集名称');
      body.set('title', title);
    }
    if (draftDescription !== album.description) {
      if (!canEditDescription) throw new Error('当前上传服务暂不支持修改图集说明');
      const description = draftDescription.trim();
      if (description.length > 1000) throw new Error('图集说明最多 1000 字');
      body.set('description', description);
    }
    files.forEach(file => body.append('images', file, file.name)); return body;
  };
  return { open(id) { ui.path = `/albums/${encodeURIComponent(id)}`; ui.open(); } };
}

export function createSeriesManager(onOpenChange, onSaved) {
  const ui = managerDialog('series-manager', '管理系列', '调整系列层级、顺序和图集归属。', onOpenChange);
  ui.path = '/library'; ui.onSaved = onSaved;
  let series = [], placements = [], titles = new Map(), selected = '', newTitle = '';
  const moveWithin = (list, item, delta, sameGroup) => {
    const siblings = list.filter(sameGroup), other = siblings[siblings.indexOf(item) + delta];
    if (!other) return;
    const a = list.indexOf(item), b = list.indexOf(other); [list[a], list[b]] = [list[b], list[a]];
    ui.changed(); render();
  };
  const orderButtons = (list, item, predicate) => {
    const group = list.filter(predicate), controls = node('div', 'editor-controls');
    for (const [text, delta] of [['上移', -1], ['下移', 1]]) {
      const button = action(text, () => moveWithin(list, item, delta, predicate));
      button.dataset.boundary = String(!group[group.indexOf(item) + delta]); controls.append(button);
    }
    return controls;
  };
  const render = () => {
    ui.workspace.replaceChildren();
    const location = node('label', 'manager-field'); location.append(node('span', 'field-label', '当前整理位置'));
    const select = seriesSelect(series, selected, '顶层系列');
    select.addEventListener('change', () => { selected = select.value; render(); }); location.append(select); ui.workspace.append(location);
    const create = node('div', 'manager-create');
    const title = input('新系列名称', newTitle); title.control.placeholder = '例如：经济学';
    title.control.addEventListener('input', () => { newTitle = title.control.value; });
    create.append(title.wrapper, action('添加系列', () => {
      if (!newTitle.trim()) { ui.status('请填写新系列名称'); title.control.focus(); return; }
      if (series.length >= 200) { ui.status('最多支持 200 个系列'); return; }
      series.push({ id: `series-${crypto.randomUUID()}`, title: newTitle.trim(), parentId: selected });
      newTitle = ''; ui.changed(); render();
    })); ui.workspace.append(create);
    ui.workspace.append(node('h3', 'manager-heading', selected ? '下级系列' : '顶层系列'));
    const children = series.filter(item => item.parentId === selected);
    if (!children.length) ui.workspace.append(node('p', 'field-note', selected ? '暂无下级系列' : '暂无系列'));
    for (const item of children) {
      const row = node('section', 'series-edit-row');
      const title = input('系列名称', item.title); title.control.setAttribute('aria-label', `系列名称：${item.title}`);
      title.control.addEventListener('input', () => { item.title = title.control.value; ui.changed(); });
      const parentLabel = node('label', 'manager-field'); parentLabel.append(node('span', 'field-label', '上级系列'));
      const parent = seriesSelect(series, item.parentId, '顶层', item.id);
      parent.addEventListener('change', () => { item.parentId = parent.value; ui.changed(); render(); }); parentLabel.append(parent);
      const controls = orderButtons(series, item, entry => entry.parentId === item.parentId);
      controls.prepend(action('进入系列', () => { selected = item.id; render(); }));
      row.append(title.wrapper, parentLabel, controls); ui.workspace.append(row);
    }
    ui.workspace.append(node('h3', 'manager-heading', selected ? '本系列的图集' : '月份图集'));
    const albums = placements.filter(item => item.seriesId === selected);
    if (!albums.length) ui.workspace.append(node('p', 'field-note', '暂无图集'));
    for (const item of albums) {
      const row = node('section', 'series-edit-row'); row.append(node('h4', 'manager-album-title', titles.get(item.id)));
      const destination = node('label', 'manager-field'); destination.append(node('span', 'field-label', '图集归属'));
      const select = seriesSelect(series, item.seriesId, '月份图集');
      select.addEventListener('change', () => {
        item.seriesId = select.value;
        if (!item.seriesId && !validDate(item.date)) selected = '';
        ui.changed(); render();
      }); destination.append(select); row.append(destination);
      if (!item.seriesId) {
        const dateField = input('归档日期', item.date, 'date'); dateField.control.required = true;
        dateField.control.addEventListener('input', () => { item.date = dateField.control.value; ui.changed(); }); row.append(dateField.wrapper);
      }
      if (selected) row.append(orderButtons(placements, item, entry => entry.seriesId === item.seriesId));
      ui.workspace.append(row);
    }
    ui.summary(`${series.length} 个系列 · ${placements.length} 个图集`); ui.sync();
  };
  ui.receive = data => {
    const nextSeries = normalizeSeries(data.manifest); normalizeManifest(data.manifest, document.baseURI);
    series = nextSeries;
    placements = data.manifest.albums.map(album => ({ id: album.id, seriesId: album.seriesId || '', date: album.date || '' }));
    titles = new Map(data.manifest.albums.map(album => [album.id, album.title]));
    if (!series.some(item => item.id === selected)) selected = '';
    newTitle = ''; render();
  };
  ui.payload = () => {
    normalizeSeries({ series });
    if (placements.some(item => !item.seriesId && !validDate(item.date))) throw new Error('移入月份图集时需要填写有效日期');
    const body = new FormData(); body.set('series', JSON.stringify(series)); body.set('placements', JSON.stringify(placements)); return body;
  };
  return { open(id = '') { selected = id; ui.open(); } };
}
