// Small UI toolkit: element builder, menus, popovers, dialogs, toasts.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else if (k in el && k !== 'list') el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat()) {
      if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
    }
    return el;
  }

  const fmt = (n) => Number(n).toLocaleString();

  // ---------- floating layer (menus + popovers share one slot) ----------
  let layer = null;
  let layerAnchor = null;
  let onLayerClose = null;

  function place(el, anchor) {
    const r = anchor instanceof Element ? anchor.getBoundingClientRect() : anchor;
    el.style.left = '0px';
    el.style.top = '0px';
    const w = el.offsetWidth;
    const hgt = el.offsetHeight;
    let left = Math.min(r.left, window.innerWidth - w - 12);
    let top = r.bottom + 4;
    if (top + hgt > window.innerHeight - 12) top = Math.max(12, r.top - hgt - 4);
    el.style.left = Math.max(12, left) + 'px';
    el.style.top = top + 'px';
  }

  function closeLayer() {
    if (!layer) return;
    layer.remove();
    layer = null;
    layerAnchor = null;
    const cb = onLayerClose;
    onLayerClose = null;
    if (cb) cb();
  }

  function openLayer(anchor, content, cls, onClose) {
    closeLayer();
    layer = h('div', { class: 'layer ' + (cls || '') }, content);
    document.body.append(layer);
    layerAnchor = anchor instanceof Element ? anchor : null;
    onLayerClose = onClose || null;
    place(layer, anchor);
    return layer;
  }

  // Toggle behaviour for buttons that open a popover.
  function isOpenFor(anchor) { return layer && layerAnchor === anchor; }

  // items: { label, hint, onclick, disabled, icon, badge (Promise<string>) } | '-' | { heading }
  function menu(anchor, items, title) {
    const list = h('div', { class: 'menu', role: 'menu' });
    if (title) list.append(h('div', { class: 'menu-title' }, title));
    for (const it of items) {
      if (!it) continue;
      if (it === '-') { list.append(h('div', { class: 'menu-sep' })); continue; }
      if (it.heading) { list.append(h('div', { class: 'menu-heading' }, it.heading)); continue; }
      const badge = h('span', { class: 'menu-badge' }, it.badgeText || '');
      if (it.badge) it.badge.then((t) => { badge.textContent = t; }).catch(() => { badge.textContent = ''; });
      list.append(h('button', {
        class: 'menu-item', role: 'menuitem', disabled: it.disabled,
        onclick: () => { closeLayer(); it.onclick(); },
      },
      h('span', { class: 'menu-icon' }, it.icon || ''),
      h('span', { class: 'menu-label' }, it.label, it.hint ? h('span', { class: 'menu-hint' }, it.hint) : null),
      badge));
    }
    openLayer(anchor, list, 'menu-layer');
    const first = list.querySelector('.menu-item:not([disabled])');
    if (first) first.focus();
  }

  function popover(anchor, content, onClose) {
    return openLayer(anchor, h('div', { class: 'popover' }, content), 'pop-layer', onClose);
  }

  // Ask for a short piece of text next to an element. Resolves null on cancel.
  function askText(anchor, label, initial, button) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); closeLayer(); } };
      const input = h('input', { type: 'text', value: initial ?? '' });
      const form = h('form', { class: 'ask', onsubmit: (e) => { e.preventDefault(); finish(input.value); } },
        h('label', null, label), input,
        h('div', { class: 'row end' },
          h('button', { type: 'button', class: 'ghost small', onclick: () => finish(null) }, 'Cancel'),
          h('button', { type: 'submit', class: 'primary small' }, button || 'OK')));
      popover(anchor, form, () => { if (!done) { done = true; resolve(null); } });
      input.focus();
      input.select();
    });
  }

  // ---------- modal dialog ----------
  let dialogEl = null;
  function dialog(title, body, actions, cls) {
    closeDialog();
    dialogEl = h('div', { class: 'modal-backdrop', onmousedown: (e) => { if (e.target === dialogEl) closeDialog(); } },
      h('div', { class: 'modal ' + (cls || ''), role: 'dialog', 'aria-label': title },
        h('div', { class: 'modal-head' }, h('h2', null, title),
          h('button', { class: 'x', title: 'Close', onclick: closeDialog }, '×')),
        h('div', { class: 'modal-body' }, body),
        h('div', { class: 'modal-foot' }, actions)));
    document.body.append(dialogEl);
    return dialogEl;
  }
  function closeDialog() { if (dialogEl) { dialogEl.remove(); dialogEl = null; } }

  // ---------- toast ----------
  let toastTimer = null;
  function toast(msg, isError, ms) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('error', !!isError);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms || (isError ? 6000 : 3500));
  }

  document.addEventListener('mousedown', (e) => {
    if (!layer || layer.contains(e.target)) return;
    if (layerAnchor && layerAnchor.contains(e.target)) return;
    closeLayer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (layer) closeLayer();
    else if (dialogEl) closeDialog();
  });
  window.addEventListener('resize', closeLayer);

  window.DBXDom = { $, h, fmt, menu, popover, askText, closeLayer, isOpenFor, dialog, closeDialog, toast };
})();
