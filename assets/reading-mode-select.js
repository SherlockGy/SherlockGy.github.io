// Enhance only the reading-mode fields; the select remains the form's source of truth.
export function enhanceReadingModeSelect(select) {
  const doc = select.ownerDocument;
  const wrapper = doc.createElement('div'); wrapper.className = 'reading-mode-select';
  const trigger = doc.createElement('button'); trigger.type = 'button';
  trigger.className = 'form-input reading-mode-trigger'; trigger.id = `${select.id}-trigger`;
  trigger.setAttribute('role', 'combobox'); trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-label', '阅读方式');
  if (select.hasAttribute('aria-describedby')) trigger.setAttribute('aria-describedby', select.getAttribute('aria-describedby'));
  const value = doc.createElement('span'); value.className = 'reading-mode-value';
  const chevron = doc.createElement('span'); chevron.className = 'reading-mode-chevron'; chevron.setAttribute('aria-hidden', 'true');
  trigger.append(value, chevron);
  const popup = doc.createElement('div'); popup.className = 'reading-mode-menu'; popup.id = `${select.id}-options`;
  popup.setAttribute('role', 'listbox'); popup.setAttribute('aria-label', '阅读方式'); popup.hidden = true;
  const supportsPopover = typeof popup.showPopover === 'function';
  if (supportsPopover) popup.setAttribute('popover', 'manual');
  trigger.setAttribute('aria-controls', popup.id);
  const hints = { gallery: '逐页浏览图片', document: '适宽显示 · 连续滚动' };
  const options = [...select.options].map((option, index) => {
    const item = doc.createElement('div'); item.className = 'reading-mode-option'; item.id = `${select.id}-option-${index}`;
    item.setAttribute('role', 'option');
    const copy = doc.createElement('span'); copy.className = 'reading-mode-copy';
    const title = doc.createElement('span'); title.textContent = option.textContent;
    const hint = doc.createElement('span'); hint.className = 'reading-mode-hint'; hint.textContent = hints[option.value] || '';
    copy.append(title, hint);
    const check = doc.createElement('span'); check.className = 'reading-mode-check'; check.textContent = '✓'; check.setAttribute('aria-hidden', 'true');
    item.append(copy, check); popup.append(item);
    item.addEventListener('pointermove', () => activate(index));
    item.addEventListener('pointerdown', event => event.preventDefault());
    item.addEventListener('click', () => choose(index));
    return item;
  });
  select.before(wrapper); wrapper.append(select, trigger); select.hidden = true;
  const labels = [...select.labels]; labels.forEach(label => { if (label.htmlFor === select.id) label.htmlFor = trigger.id; });
  let opened = false, active = select.selectedIndex, listeners;
  function activate(index) {
    active = Math.max(0, Math.min(options.length - 1, index));
    options.forEach((item, i) => item.classList.toggle('is-active', i === active));
    if (opened) {
      trigger.setAttribute('aria-activedescendant', options[active].id);
      const item = options[active];
      if (item.offsetTop < popup.scrollTop) popup.scrollTop = item.offsetTop;
      else if (item.offsetTop + item.offsetHeight > popup.scrollTop + popup.clientHeight) popup.scrollTop = item.offsetTop + item.offsetHeight - popup.clientHeight;
    }
  }
  function sync() {
    trigger.disabled = select.disabled;
    value.textContent = select.selectedOptions[0]?.textContent || '';
    options.forEach((item, i) => item.setAttribute('aria-selected', String(i === select.selectedIndex)));
    if (select.disabled) close();
  }
  function close() {
    if (!opened) return;
    opened = false; listeners.abort();
    if (supportsPopover && popup.matches(':popover-open')) popup.hidePopover();
    popup.hidden = true; popup.remove();
    trigger.setAttribute('aria-expanded', 'false'); trigger.removeAttribute('aria-activedescendant');
  }
  function position() {
    const rect = trigger.getBoundingClientRect();
    const viewport = window.visualViewport;
    const leftEdge = (viewport?.offsetLeft || 0) + 8, topEdge = (viewport?.offsetTop || 0) + 8;
    const width = Math.min(rect.width, (viewport?.width || window.innerWidth) - 16);
    const bottom = topEdge + (viewport?.height || window.innerHeight) - 16;
    popup.style.width = `${width}px`;
    popup.style.left = `${Math.max(leftEdge, Math.min(rect.left, leftEdge + (viewport?.width || window.innerWidth) - 16 - width))}px`;
    const below = bottom - rect.bottom - 6, above = rect.top - topEdge - 6;
    const up = below < Math.min(popup.scrollHeight, 160) && above > below;
    popup.style.maxHeight = `${Math.max(44, up ? above : below)}px`;
    popup.style.top = `${up ? Math.max(topEdge, rect.top - popup.getBoundingClientRect().height - 6) : rect.bottom + 6}px`;
  }
  function open() {
    if (select.disabled || opened) return;
    sync(); opened = true;
    (select.closest('dialog') || doc.body).append(popup); popup.hidden = false;
    if (supportsPopover) popup.showPopover();
    trigger.setAttribute('aria-expanded', 'true'); position(); activate(select.selectedIndex);
    listeners = new AbortController(); const settings = { signal: listeners.signal };
    doc.addEventListener('pointerdown', event => { if (!wrapper.contains(event.target) && !popup.contains(event.target)) close(); }, settings);
    doc.addEventListener('focusin', event => { if (!wrapper.contains(event.target) && !popup.contains(event.target)) close(); }, settings);
    // Close rather than leave a detached menu floating when the dialog scrolls.
    doc.addEventListener('scroll', event => { if (!popup.contains(event.target)) close(); }, { ...settings, capture: true });
    window.addEventListener('resize', close, settings);
    window.visualViewport?.addEventListener('resize', close, settings);
    select.closest('dialog')?.addEventListener('close', close, settings);
  }
  function choose(index) {
    if (select.disabled) { close(); return; }
    const changed = select.selectedIndex !== index;
    select.selectedIndex = index; sync(); close(); trigger.focus({ preventScroll: true });
    if (changed) { select.dispatchEvent(new Event('input', { bubbles: true })); select.dispatchEvent(new Event('change', { bubbles: true })); }
  }
  trigger.addEventListener('click', () => opened ? close() : open());
  trigger.addEventListener('keydown', event => {
    if (event.key === 'Escape' && opened) { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'Tab') { close(); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      if (!opened) { open(); if (event.key === 'Home') activate(0); if (event.key === 'End') activate(options.length - 1); return; }
      if (event.key === 'Enter' || event.key === ' ') choose(active);
      else activate(event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : active + (event.key === 'ArrowDown' ? 1 : -1));
    }
  });
  select.addEventListener('change', sync);
  const observer = new MutationObserver(sync); observer.observe(select, { attributes: true, attributeFilter: ['disabled'] });
  const form = select.form;
  const reset = () => { close(); queueMicrotask(sync); }; form?.addEventListener('reset', reset);
  sync();
  return { sync, destroy() { close(); observer.disconnect(); form?.removeEventListener('reset', reset); select.removeEventListener('change', sync); } };
}
