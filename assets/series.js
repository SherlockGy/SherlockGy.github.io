import config from '../config.js';
import { flattenSeries, seriesTrail } from './model.js?v=20260919-description-1';
import { applySeriesAction } from './series-model.js?v=20260919-series-1';
import { setFeedback } from './feedback.js?v=20260917-interaction-1';

const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
const button = (text, callback, className = 'secondary-button') => {
  const element = node('button', className, text); element.type = 'button';
  element.addEventListener('click', callback); return element;
};

export function createSeriesActions(onOpenChange, onSaved) {
  const dialog = node('dialog', 'upload-dialog series-action-dialog'); dialog.id = 'series-action';
  dialog.setAttribute('aria-labelledby', 'series-action-title');
  dialog.innerHTML = `<form><header class="dialog-header"><h2 id="series-action-title"></h2><button type="button" class="icon-button action-close" aria-label="关闭">×</button></header>
    <div class="dialog-content"><p class="action-context"></p><div class="action-fields"></div>
    <label class="field-label action-password-label" for="series-action-password">上传口令</label><input id="series-action-password" class="form-input" type="password" required autocomplete="off" placeholder="输入口令以保存这次修改"><p class="field-note">关闭窗口后清除口令</p></div>
    <footer class="dialog-footer"><p class="upload-status" role="status" aria-live="polite" tabindex="0"></p><button type="button" class="secondary-button action-cancel">取消</button><button type="submit" class="primary-button action-save">保存</button></footer></form>`;
  document.body.append(dialog);
  const $ = selector => dialog.querySelector(selector);
  let action, initial, source, opener, busy = false, saved = false, requestId, pending, submitLabel;
  const status = (message, kind) => setFeedback($('.upload-status'), message, kind);
  const changed = () => {
    requestId = null; pending = null; status(''); sync();
  };
  const dirty = () => JSON.stringify(action) !== initial;
  const sync = () => {
    dialog.querySelectorAll('input, select, button').forEach(control => { control.disabled = busy || saved; });
    dialog.querySelectorAll('[data-boundary="true"]').forEach(control => { control.disabled = true; });
    $('.action-close').disabled = busy; $('.action-cancel').disabled = busy;
    $('.action-save').disabled = busy || (!saved && !dirty());
    $('.action-save').textContent = saved ? '完成' : submitLabel;
    $('.action-cancel').hidden = saved;
  };
  const close = () => {
    if (busy || (!saved && dirty() && !confirm('放弃这次尚未保存的修改？'))) return;
    $('#series-action-password').value = ''; pending = null; dialog.close(); onOpenChange();
    (opener?.isConnected && opener.getClientRects().length ? opener : document.querySelector('#main'))?.focus({ preventScroll: true });
  };
  $('.action-close').addEventListener('click', close); $('.action-cancel').addEventListener('click', close);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  const request = async body => {
    if (!config.uploadEndpoint) throw new Error('请先配置上传服务');
    const endpoint = new URL('/library', config.uploadEndpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('上传服务地址需要配置为 HTTPS');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 90000);
    try {
      const response = await fetch(endpoint, { method: body ? 'POST' : 'GET', body,
        headers: { Authorization: `Bearer ${$('#series-action-password').value.trim()}` },
        signal: controller.signal, cache: 'no-store', redirect: 'error', credentials: 'omit' });
      const data = await response.json().catch(error => { if (controller.signal.aborted) throw error; return null; });
      if (!response.ok) throw Object.assign(new Error(data?.error?.message || `请求失败（HTTP ${response.status}），修改已保留，请重试。`), { code: data?.error?.code });
      if (!data) throw new Error('服务未返回有效结果，修改已保留，请保持内容不变重试。');
      return data;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('保存结果尚未确认，请保持内容不变重试。');
      if (error instanceof TypeError) throw new Error('连接中断，修改已保留，请重试。');
      throw error;
    } finally { clearTimeout(timer); }
  };
  $('form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return; if (saved) { close(); return; } if (!dirty()) return;
    const logPrefix = `[saveSeriesAction 保存系列操作][type=${action.type}][id=${action.id || action.parentId || 'root'}]`;
    busy = true; sync(); status('正在保存…');
    try {
      if (!$('#series-action-password').value.trim()) throw new Error('请输入上传口令');
      if (!pending) {
        const latest = await request();
        if (!/^[a-f0-9]{64}$/.test(latest.revision) || !latest.manifest || !Array.isArray(latest.manifest.albums)) throw new Error('无法读取最新目录，请重试。');
        const next = applySeriesAction(latest.manifest, action);
        pending = new FormData();
        pending.set('revision', latest.revision); pending.set('requestId', requestId ||= crypto.randomUUID());
        pending.set('series', JSON.stringify(next.series)); pending.set('placements', JSON.stringify(next.placements));
      }
      const result = await request(pending);
      if (!['committed', 'unchanged'].includes(result?.status) || !result.manifest || (result.status === 'committed' && (typeof result.commitSha !== 'string' || !result.commitSha))) throw new Error('未收到保存凭据，请保持内容不变重试。');
      saved = true; pending = null; $('#series-action-password').value = ''; $('#series-action-password').required = false;
      status(result.status === 'unchanged' ? '内容没有变化。' : '已保存。', 'success');
      try { onSaved(result); }
      catch { status('已保存，请刷新页面查看最新目录。', 'success'); }
    } catch (error) {
      console.warn(logPrefix, '保存未完成');
      if (error.code === 'LIBRARY_CHANGED') { pending = null; status('目录已有更新，本次修改已保留。请再次保存。', 'error'); }
      else status(error.message, 'error');
    }
    finally { busy = false; sync(); (saved ? $('.action-save') : $('.upload-status')).focus({ preventScroll: true }); }
  });
  const textField = (label, value, update) => {
    const wrapper = node('label', 'action-field'); wrapper.append(node('span', 'field-label', label));
    const input = node('input', 'form-input'); input.value = value; input.maxLength = 120; input.required = true;
    input.addEventListener('input', () => { update(input.value); changed(); }); wrapper.append(input); return wrapper;
  };
  const destination = (rootAllowed, excluded, value, update) => {
    const wrapper = node('label', 'action-field'); wrapper.append(node('span', 'field-label', '移动到'));
    const select = node('select', 'form-input');
    if (rootAllowed) select.append(new Option('系列图集首页', ''));
    for (const item of flattenSeries(source.series)) {
      if (excluded && seriesTrail(source.series, item.id).some(entry => entry.id === excluded)) continue;
      select.append(new Option(seriesTrail(source.series, item.id).map(entry => entry.title).join(' / '), item.id));
    }
    select.value = value; select.addEventListener('change', () => { update(select.value); changed(); }); wrapper.append(select); return wrapper;
  };
  const renderOrder = () => {
    const fields = $('.action-fields'); fields.replaceChildren();
    for (const [label, key, items] of [['子系列', 'seriesIds', source.series], ['图集', 'albumIds', source.albums]]) {
      if (!action[key].length) continue;
      fields.append(node('h3', 'order-heading', label));
      const list = node('ol', 'series-order-list');
      action[key].forEach((id, index) => {
        const item = items.find(entry => entry.id === id), row = node('li', 'series-order-row');
        row.append(node('span', 'order-position', String(index + 1).padStart(2, '0')), node('span', 'order-title', item.title));
        const controls = node('div', 'order-controls');
        for (const [text, delta] of [['上移', -1], ['下移', 1]]) {
          const control = button(text, () => {
            const order = action[key]; [order[index], order[index + delta]] = [order[index + delta], order[index]];
            changed(); renderOrder();
            dialog.querySelector(`[data-order-key="${key}"][data-order-id="${id}"][data-delta="${-delta}"]`)?.focus();
          });
          control.setAttribute('aria-label', `${text}：${item.title}`); control.dataset.orderKey = key; control.dataset.orderId = id; control.dataset.delta = delta;
          control.dataset.boundary = String(index + delta < 0 || index + delta >= action[key].length); controls.append(control);
        }
        row.append(controls); list.append(row);
      });
      fields.append(list);
    }
    sync();
  };
  return { open(options, catalog) {
    opener = document.activeElement; source = catalog; action = structuredClone(options);
    initial = JSON.stringify(action); busy = false; saved = false; requestId = null; pending = null;
    $('#series-action-password').value = ''; $('#series-action-password').required = true; status('');
    const fields = $('.action-fields'); fields.replaceChildren();
    const location = id => seriesTrail(source.series, id).map(item => item.title).join(' / ') || '系列图集首页';
    let heading, context;
    if (action.type === 'create') {
      heading = action.parentId ? '新建子系列' : '新建系列'; context = location(action.parentId); submitLabel = '创建';
      fields.append(textField('系列名称', '', value => { action.title = value; }));
    } else if (action.type === 'rename') {
      heading = '重命名系列'; context = location(action.id); submitLabel = '保存名称';
      fields.append(textField('系列名称', action.title, value => { action.title = value; }));
    } else if (action.type === 'move-series') {
      heading = '移动系列'; context = location(action.id); submitLabel = '确认移动';
      fields.append(destination(true, action.id, action.parentId, value => { action.parentId = value; }));
      fields.append(node('p', 'field-note', '子系列和图集会随这个系列一起移动。'));
    } else if (action.type === 'move-album') {
      heading = '移动图集'; context = source.albums.find(item => item.id === action.id).title; submitLabel = '确认移动';
      fields.append(destination(false, '', action.seriesId, value => { action.seriesId = value; }));
    } else {
      heading = '调整顺序'; context = location(action.parentId); submitLabel = '保存顺序'; renderOrder();
    }
    $('#series-action-title').textContent = heading; $('.action-context').textContent = context;
    sync(); dialog.showModal(); onOpenChange(); $('.dialog-content').scrollTop = 0;
    (fields.querySelector('input, select, button:not(:disabled)') || $('#series-action-password')).focus();
  } };
}
