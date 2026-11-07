// ---------- Android app UI · reusable components ----------
// Top app bar, snackbar, bottom sheets, dialogs, list rows, switches, segmented
// controls, empty / error / skeleton states. The matching styles live in
// app/css/components.css. Nothing here knows about Quran data - it is the app's
// design-system layer.
(function(){
  'use strict';
  var QRApp = window.QRApp;
  var h = QRApp.h, icon = QRApp.icon, T = QRApp.T;
  var UI = QRApp.ui = {};

  // ---------- overlay registry (sheets / dialogs) ----------
  // The hardware back button closes the top-most overlay first (see nav.js).
  var overlays = QRApp.overlays = {
    stack: [],
    add: function(entry){ overlays.stack.push(entry); QRApp.emit('overlays', overlays.stack.length); return entry; },
    remove: function(entry){
      var i = overlays.stack.indexOf(entry);
      if(i > -1) overlays.stack.splice(i, 1);
      QRApp.emit('overlays', overlays.stack.length);
    },
    closeTop: function(){
      var top = overlays.stack[overlays.stack.length - 1];
      if(!top) return false;
      if(typeof top.onBack === 'function') top.onBack(); else top.close();
      return true;
    },
    count: function(){ return overlays.stack.length; }
  };

  function overlayHost(){
    var host = document.getElementById('qa-overlays');
    if(!host){ host = h('div', { id: 'qa-overlays' }); document.body.appendChild(host); }
    return host;
  }

  // ---------- snackbar ----------
  var snackEl = null, snackTimer = null, snackTextEl = null, snackActionEl = null;
  function ensureSnack(){
    if(snackEl) return;
    snackTextEl = h('span', { class: 'qa-grow' });
    snackActionEl = h('button', { class: 'qa-snack-action', type: 'button' });
    snackEl = h('div', { class: 'qa-snack', role: 'status', 'aria-live': 'polite' }, snackTextEl, snackActionEl);
    overlayHost().appendChild(snackEl);
  }
  // UI.snack('Saved', { action:{ label:'Undo', onClick:fn }, duration:3500 })
  UI.snack = function(msg, opts){
    opts = opts || {};
    ensureSnack();
    clearTimeout(snackTimer);
    snackTextEl.textContent = msg == null ? '' : String(msg);
    if(opts.action && opts.action.label){
      snackActionEl.style.display = '';
      snackActionEl.textContent = opts.action.label;
      snackActionEl.onclick = function(){ UI.hideSnack(); try{ opts.action.onClick && opts.action.onClick(); }catch(e){} };
    } else {
      snackActionEl.style.display = 'none';
      snackActionEl.onclick = null;
    }
    // restart the transition so back-to-back messages are visible
    snackEl.classList.remove('qa-visible');
    void snackEl.offsetWidth;
    snackEl.classList.add('qa-visible');
    snackTimer = setTimeout(UI.hideSnack, opts.duration || (opts.action ? 5000 : 2800));
  };
  UI.hideSnack = function(){ if(snackEl) snackEl.classList.remove('qa-visible'); };
  UI.toast = UI.snack;

  // ---------- generic helpers ----------
  UI.iconButton = function(name, label, onClick, cls){
    var b = h('button', { class: 'qa-iconbtn' + (cls ? ' ' + cls : ''), type: 'button', 'aria-label': label || name, title: label || '' });
    b.innerHTML = icon(name);
    if(onClick) b.addEventListener('click', onClick);
    return b;
  };
  UI.button = function(label, opts){
    opts = opts || {};
    var b = h('button', { class: 'qa-btn qa-btn-' + (opts.kind || 'filled') + (opts.block ? ' qa-btn-block' : '') + (opts.small ? ' qa-btn-sm' : '') + (opts.cls ? ' ' + opts.cls : ''), type: 'button' });
    if(opts.icon) b.insertAdjacentHTML('beforeend', icon(opts.icon));
    b.appendChild(document.createTextNode(label));
    if(opts.onClick) b.addEventListener('click', opts.onClick);
    return b;
  };
  UI.section = function(title, right){
    if(!right) return h('div', { class: 'qa-section-title' }, title);
    return h('div', { class: 'qa-section-head' }, h('div', { class: 'qa-section-title' }, title), right);
  };
  UI.linkButton = function(label, onClick){
    var b = h('button', { class: 'qa-link-btn', type: 'button' }, label);
    if(onClick) b.addEventListener('click', onClick);
    return b;
  };
  UI.progress = function(frac, accent){
    var f = Math.max(0, Math.min(1, frac || 0));
    var bar = h('span', { class: accent ? 'qa-accent' : '' });
    bar.style.width = (f * 100).toFixed(1) + '%';
    return h('div', { class: 'qa-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(f * 100)) }, bar);
  };
  UI.avatar = function(user, size){
    var el = h('div', { class: 'qa-avatar' });
    if(size){ el.style.width = el.style.height = size + 'px'; el.style.fontSize = Math.round(size * 0.4) + 'px'; }
    if(user && user.photoData){
      el.appendChild(h('img', { src: user.photoData, alt: '' }));
    } else {
      var nm = (user && (user.name || user.email)) || '';
      el.textContent = nm ? nm.trim().charAt(0).toUpperCase() : '';
      if(!nm) el.innerHTML = icon('person');
    }
    return el;
  };

  // ---------- list rows (settings style) ----------
  // UI.row({ icon, title, sub, value, chevron, onClick, danger, trail:Node })
  UI.row = function(o){
    var b = h('button', { class: 'qa-row-item' + (o.danger ? ' qa-danger' : ''), type: 'button' });
    if(o.icon){ var lead = h('span', { class: 'qa-row-lead' }); lead.innerHTML = icon(o.icon); b.appendChild(lead); }
    var main = h('span', { class: 'qa-row-main' }, h('div', { class: 'qa-row-title' }, o.title));
    if(o.sub) main.appendChild(h('div', { class: 'qa-row-sub' }, o.sub));
    b.appendChild(main);
    var trail = h('span', { class: 'qa-row-trail' });
    if(o.value != null && o.value !== '') trail.appendChild(h('span', { class: 'qa-val' }, o.value));
    if(o.trail) trail.appendChild(o.trail);
    if(o.chevron !== false && o.onClick && !o.trail){
      trail.insertAdjacentHTML('beforeend', icon(document.documentElement.dir === 'rtl' ? 'chevronLeft' : 'chevronRight'));
    }
    if(trail.childNodes.length) b.appendChild(trail);
    if(o.onClick) b.addEventListener('click', function(ev){ o.onClick(ev, b); });
    else b.setAttribute('tabindex', '-1');
    if(o.disabled) b.setAttribute('disabled', '');
    b.setValue = function(v){
      var el = trail.querySelector('.qa-val');
      if(!el){ el = h('span', { class: 'qa-val' }); trail.insertBefore(el, trail.firstChild); }
      el.textContent = v;
    };
    b.setSub = function(v){
      var el = main.querySelector('.qa-row-sub');
      if(!el){ el = h('div', { class: 'qa-row-sub' }); main.appendChild(el); }
      el.textContent = v;
    };
    return b;
  };
  UI.group = function(rows){
    var g = h('div', { class: 'qa-group' });
    (rows || []).forEach(function(r){ if(r) g.appendChild(r); });
    return g;
  };
  // A row with a switch. onChange(checked) may return a Promise<boolean|void>; resolving to
  // `false` (or rejecting) reverts the switch - used for permission-gated toggles.
  UI.switchRow = function(o){
    var input = h('input', { type: 'checkbox', role: 'switch' });
    input.checked = !!o.checked;
    var sw = h('span', { class: 'qa-switch' }, input, h('span', { class: 'qa-switch-track' }), h('span', { class: 'qa-switch-thumb' }));
    var row = UI.row({ icon: o.icon, title: o.title, sub: o.sub, trail: sw, chevron: false });
    row.setAttribute('role', 'presentation');
    var busy = false;
    function apply(next){
      if(busy) return;
      var prev = !next;
      if(!o.onChange) return;
      busy = true;
      var r;
      try{ r = o.onChange(next); }catch(e){ r = false; }
      Promise.resolve(r).then(function(res){
        if(res === false){ input.checked = prev; }
      }).catch(function(){ input.checked = prev; }).then(function(){ busy = false; });
    }
    input.addEventListener('change', function(){ apply(input.checked); });
    row.addEventListener('click', function(ev){
      if(ev.target === input) return;
      input.checked = !input.checked;
      apply(input.checked);
    });
    row.input = input;
    return row;
  };

  // ---------- segmented control ----------
  UI.seg = function(items, value, onChange){
    var el = h('div', { class: 'qa-seg', role: 'tablist' });
    var btns = {};
    items.forEach(function(it){
      var b = h('button', { class: 'qa-seg-btn' + (it.id === value ? ' qa-selected' : ''), type: 'button', role: 'tab', 'aria-selected': it.id === value ? 'true' : 'false' }, it.label);
      b.addEventListener('click', function(){ if(el.value === it.id) return; el.set(it.id); onChange && onChange(it.id); });
      btns[it.id] = b; el.appendChild(b);
    });
    el.value = value;
    el.set = function(id){
      el.value = id;
      Object.keys(btns).forEach(function(k){
        btns[k].classList.toggle('qa-selected', k === id);
        btns[k].setAttribute('aria-selected', k === id ? 'true' : 'false');
      });
      if(btns[id] && btns[id].scrollIntoView) { try{ btns[id].scrollIntoView({ inline: 'center', block: 'nearest' }); }catch(e){} }
    };
    return el;
  };
  UI.chip = function(label, onClick, selected){
    var c = h('button', { class: 'qa-chip' + (selected ? ' qa-selected' : ''), type: 'button' }, label);
    if(onClick) c.addEventListener('click', onClick);
    return c;
  };

  // ---------- states ----------
  UI.empty = function(o){
    var s = h('div', { class: 'qa-state' });
    var ic = h('div', { class: 'qa-state-ic' }); ic.innerHTML = icon(o.icon || 'info'); s.appendChild(ic);
    s.appendChild(h('h3', { class: 'qa-state-title' }, o.title || ''));
    if(o.text) s.appendChild(h('p', { class: 'qa-state-text' }, o.text));
    if(o.actionLabel && o.onAction) s.appendChild(UI.button(o.actionLabel, { kind: 'tonal', onClick: o.onAction }));
    return s;
  };
  UI.errorState = function(o){
    o = o || {};
    var offline = QRApp.native && QRApp.native.network && !QRApp.native.network.online;
    var s = UI.empty({
      icon: offline ? 'cloudOff' : 'error',
      title: o.title || (offline ? T('ইন্টারনেট সংযোগ নেই', 'You are offline') : T('লোড করা যায়নি', 'Could not load')),
      text: o.text || (offline ? T('সংযোগ ফিরলে আবার চেষ্টা করুন। আগে ডাউনলোড করা সূরা অফলাইনে পড়া যাবে।', 'Try again when you are back online. Downloaded surahs can be read offline.') : T('একটু পরে আবার চেষ্টা করুন।', 'Please try again in a moment.')),
      actionLabel: o.onRetry ? T('আবার চেষ্টা করুন', 'Try again') : null,
      onAction: o.onRetry
    });
    s.classList.add('qa-error');
    return s;
  };
  UI.skeletonList = function(n, withLead){
    var box = h('div', { class: 'qa-list' });
    for(var i = 0; i < (n || 6); i++){
      var row = h('div', { class: 'qa-skel-row' });
      if(withLead !== false) row.appendChild(h('div', { class: 'qa-skel qa-skel-box' }));
      var col = h('div', { class: 'qa-grow' });
      var l1 = h('div', { class: 'qa-skel qa-skel-line' }); l1.style.width = (48 + (i * 13) % 34) + '%';
      var l2 = h('div', { class: 'qa-skel qa-skel-line' }); l2.style.width = (28 + (i * 7) % 22) + '%'; l2.style.height = '11px';
      col.appendChild(l1); col.appendChild(l2); row.appendChild(col); box.appendChild(row);
    }
    return box;
  };
  UI.skeletonBlock = function(height){
    var b = h('div', { class: 'qa-skel' }); b.style.height = (height || 120) + 'px'; b.style.borderRadius = 'var(--qa-r-lg)'; return b;
  };
  UI.spinner = function(){ return h('div', { class: 'qa-spinner', role: 'status', 'aria-label': T('লোড হচ্ছে', 'Loading') }); };
  UI.banner = function(text, iconName, kind){
    var b = h('div', { class: 'qa-banner' + (kind === 'info' ? ' qa-info' : '') });
    b.innerHTML = icon(iconName || 'cloudOff'); b.appendChild(h('span', {}, text));
    return b;
  };

  // ---------- bottom sheet ----------
  // UI.sheet({ title, sub, body, actions:[{label,kind,onClick,closes}], onClose, dismissible })
  UI.sheet = function(o){
    o = o || {};
    var host = overlayHost();
    var scrim = h('div', { class: 'qa-scrim' });
    var sheet = h('div', { class: 'qa-sheet', role: 'dialog', 'aria-modal': 'true' });
    var handle = h('div', { class: 'qa-sheet-handle' });
    sheet.appendChild(handle);
    if(o.title){
      var head = h('div', { class: 'qa-sheet-head' }, h('h2', { class: 'qa-sheet-title' }, o.title));
      if(o.sub) head.appendChild(h('p', { class: 'qa-sheet-sub' }, o.sub));
      sheet.appendChild(head);
      sheet.setAttribute('aria-label', o.title);
    }
    var body = h('div', { class: 'qa-sheet-body' });
    function setBody(b){
      body.innerHTML = '';
      if(b == null) return;
      if(typeof b === 'string') body.innerHTML = b; else body.appendChild(b);
    }
    setBody(o.body);
    sheet.appendChild(body);
    var closed = false, entry;
    var api = { el: sheet, body: body, setBody: setBody };
    function close(result){
      if(closed) return; closed = true;
      overlays.remove(entry);
      scrim.classList.remove('qa-visible'); sheet.classList.remove('qa-visible');
      setTimeout(function(){ scrim.remove(); sheet.remove(); }, 260);
      try{ o.onClose && o.onClose(result); }catch(e){}
    }
    api.close = close;
    if(o.actions && o.actions.length){
      var bar = h('div', { class: 'qa-sheet-actions' });
      o.actions.forEach(function(a){
        bar.appendChild(UI.button(a.label, { kind: a.kind || 'tonal', onClick: function(){
          var r; try{ r = a.onClick && a.onClick(api); }catch(e){}
          if(a.closes !== false) close(a.value);
          return r;
        } }));
      });
      sheet.appendChild(bar);
    }
    entry = overlays.add({ id: 'sheet', close: function(){ close(); }, onBack: o.dismissible === false ? function(){} : null, dismissible: o.dismissible !== false });
    if(o.dismissible !== false) scrim.addEventListener('click', function(){ close(); });
    host.appendChild(scrim); host.appendChild(sheet);
    // drag the handle / header down to dismiss
    (function(){
      var startY = null, dy = 0;
      function down(e){ if(o.dismissible === false) return; startY = e.clientY; dy = 0; sheet.style.transition = 'none'; try{ e.target.setPointerCapture(e.pointerId); }catch(err){} }
      function move(e){ if(startY == null) return; dy = Math.max(0, e.clientY - startY); sheet.style.transform = 'translateY(' + dy + 'px)'; }
      function up(){
        if(startY == null) return; startY = null;
        sheet.style.transition = ''; sheet.style.transform = '';
        if(dy > 90) close();
      }
      [handle, sheet.querySelector('.qa-sheet-head')].forEach(function(el){
        if(!el) return;
        el.style.touchAction = 'none';
        el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
      });
    })();
    requestAnimationFrame(function(){ requestAnimationFrame(function(){ scrim.classList.add('qa-visible'); sheet.classList.add('qa-visible'); }); });
    return api;
  };

  // UI.actionSheet({ title, sub, actions:[{icon,label,onClick,danger}] })
  UI.actionSheet = function(o){
    var list = h('div', { class: 'qa-stack', style: { gap: '2px' } });
    var sh = null;
    (o.actions || []).forEach(function(a){
      if(!a) return;
      var b = h('button', { class: 'qa-action' + (a.danger ? ' qa-danger' : ''), type: 'button' });
      if(a.icon) b.insertAdjacentHTML('beforeend', icon(a.icon));
      b.appendChild(h('span', { class: 'qa-grow' }, a.label));
      b.addEventListener('click', function(){
        if(a.keepOpen !== true) sh.close();
        try{ a.onClick && a.onClick(); }catch(e){ QRApp.warn('action failed', e); }
      });
      list.appendChild(b);
    });
    sh = UI.sheet({ title: o.title, sub: o.sub, body: list, onClose: o.onClose });
    return sh;
  };

  // UI.choiceSheet({ title, options:[{id,label,sub,leading}], selected, searchable, multi, onPick(id) })
  // Resolves with the picked id (or null if dismissed).
  UI.choiceSheet = function(o){
    return new Promise(function(resolve){
      var picked = null;
      var wrap = h('div', { class: 'qa-stack', style: { gap: '10px' } });
      var input = null;
      if(o.searchable){
        input = h('input', { class: 'qa-input', type: 'search', placeholder: o.searchPlaceholder || T('খুঁজুন…', 'Search…'), autocomplete: 'off' });
        wrap.appendChild(input);
      }
      var list = h('div', { class: 'qa-group' });
      wrap.appendChild(list);
      function render(q){
        list.innerHTML = '';
        var qq = (q || '').trim().toLowerCase();
        var shown = (o.options || []).filter(function(op){
          return !qq || String(op.label).toLowerCase().indexOf(qq) > -1 || String(op.sub || '').toLowerCase().indexOf(qq) > -1;
        });
        if(!shown.length){ list.appendChild(h('div', { class: 'qa-state-text', style: { padding: '20px', textAlign: 'center' } }, T('কিছু পাওয়া যায়নি', 'Nothing found'))); return; }
        shown.forEach(function(op){
          var sel = op.id === o.selected;
          var trail = sel ? h('span', { class: 'qa-ic-wrap', html: icon('check') }) : null;
          var row = UI.row({ title: op.label, sub: op.sub, trail: trail, chevron: false, onClick: function(){
            picked = op.id; sh.close(); try{ o.onPick && o.onPick(op.id); }catch(e){}
          } });
          if(op.leading){ var l = h('span', { class: 'qa-row-lead' }, op.leading); row.insertBefore(l, row.firstChild); }
          if(sel) row.style.color = 'var(--qa-primary)';
          list.appendChild(row);
        });
      }
      render('');
      if(input) input.addEventListener('input', function(){ render(input.value); });
      var sh = UI.sheet({ title: o.title, sub: o.sub, body: wrap, onClose: function(){ resolve(picked); } });
    });
  };

  // ---------- dialog ----------
  // UI.dialog({ title, text, actions:[{label,kind,value}], dismissible }) -> Promise(value|null)
  UI.dialog = function(o){
    return new Promise(function(resolve){
      var wrap = h('div', { class: 'qa-dialog-wrap' });
      var dlg = h('div', { class: 'qa-dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': o.title || '' });
      if(o.title) dlg.appendChild(h('h2', { class: 'qa-dialog-title' }, o.title));
      if(o.text) dlg.appendChild(h('p', { class: 'qa-dialog-text' }, o.text));
      if(o.body) dlg.appendChild(typeof o.body === 'string' ? h('div', { html: o.body }) : o.body);
      var bar = h('div', { class: 'qa-dialog-actions' });
      var closed = false, entry;
      function close(value){
        if(closed) return; closed = true;
        overlays.remove(entry); wrap.remove(); resolve(value === undefined ? null : value);
      }
      (o.actions || [{ label: T('ঠিক আছে', 'OK'), kind: 'text', value: true }]).forEach(function(a){
        bar.appendChild(UI.button(a.label, { kind: a.kind || 'text', onClick: function(){
          if(a.onClick){ var r = a.onClick(); if(r === false) return; }
          close(a.value === undefined ? true : a.value);
        } }));
      });
      dlg.appendChild(bar); wrap.appendChild(dlg);
      entry = overlays.add({ id: 'dialog', close: function(){ close(null); }, onBack: o.dismissible === false ? function(){} : null, dismissible: o.dismissible !== false });
      if(o.dismissible !== false) wrap.addEventListener('click', function(e){ if(e.target === wrap) close(null); });
      overlayHost().appendChild(wrap);
      var first = bar.lastChild; if(first && first.focus) setTimeout(function(){ try{ first.focus({ preventScroll: true }); }catch(e){} }, 30);
    });
  };
  UI.confirm = function(o){
    return UI.dialog({
      title: o.title, text: o.text,
      actions: [
        { label: o.cancelLabel || T('বাতিল', 'Cancel'), kind: 'text', value: false },
        { label: o.confirmLabel || T('ঠিক আছে', 'OK'), kind: o.danger ? 'danger' : 'filled', value: true }
      ]
    }).then(function(v){ return v === true; });
  };
  UI.alert = function(title, text){ return UI.dialog({ title: title, text: text }); };

  // Prompt for a single line of text (replaces window.prompt)
  UI.prompt = function(o){
    return new Promise(function(resolve){
      var input = h('input', { class: 'qa-input', type: o.type || 'text', placeholder: o.placeholder || '', value: o.value || '', autocomplete: 'off' });
      var holder = h('div', { style: { marginBottom: '20px' } }, input);
      var done = false;
      UI.dialog({
        title: o.title, text: o.text, body: holder,
        actions: [
          { label: T('বাতিল', 'Cancel'), kind: 'text', value: null },
          { label: o.confirmLabel || T('ঠিক আছে', 'OK'), kind: 'filled', value: '__ok__', onClick: function(){
            var v = input.value.trim();
            if(o.validate){ var msg = o.validate(v); if(msg){ UI.snack(msg); return false; } }
            done = v; return true;
          } }
        ]
      }).then(function(val){ resolve(val === '__ok__' ? done : null); });
      setTimeout(function(){ try{ input.focus(); input.select(); }catch(e){} }, 60);
      input.addEventListener('keydown', function(e){ if(e.key === 'Enter'){ var btn = holder.parentNode.querySelector('.qa-dialog-actions .qa-btn-filled'); if(btn) btn.click(); } });
    });
  };

  // ---------- top app bar (single, re-configured per screen) ----------
  var bar = null, barParts = {};
  UI.topbar = {
    mount: function(){
      if(bar) return bar;
      bar = h('header', { class: 'qa-topbar', role: 'banner' });
      barParts.lead = h('div', { class: 'qa-topbar-lead' });
      barParts.titles = h('div', { class: 'qa-topbar-titles' });
      barParts.actions = h('div', { class: 'qa-topbar-actions' });
      bar.appendChild(barParts.lead); bar.appendChild(barParts.titles); bar.appendChild(barParts.actions);
      document.body.insertBefore(bar, document.body.firstChild);
      return bar;
    },
    el: function(){ return bar; },
    // cfg: { lead:'back'|'close'|null|{icon,label,onClick}, title, sub, brand, actions:[], elevated, search:{...} }
    apply: function(cfg){
      UI.topbar.mount();
      cfg = cfg || {};
      barParts.lead.innerHTML = ''; barParts.titles.innerHTML = ''; barParts.actions.innerHTML = '';
      // a previous search field must never survive into the next configuration (no duplicates)
      if(barParts.searchWrap){ barParts.searchWrap.remove(); barParts.searchWrap = null; barParts.searchInput = null; }
      bar.classList.toggle('qa-elevated', !!cfg.elevated);
      if(cfg.lead){
        var lead = cfg.lead;
        if(lead === 'back') lead = { icon: 'back', label: T('পেছনে', 'Back'), onClick: function(){ QRApp.nav.back(); } };
        else if(lead === 'close') lead = { icon: 'close', label: T('বন্ধ করুন', 'Close'), onClick: function(){ QRApp.nav.back(); } };
        barParts.lead.appendChild(UI.iconButton(lead.icon, lead.label, lead.onClick));
      } else {
        barParts.lead.style.width = '8px';
      }
      if(cfg.lead) barParts.lead.style.width = '';
      if(cfg.search){
        var s = cfg.search;
        var wrap = h('label', { class: 'qa-topbar-search' });
        wrap.insertAdjacentHTML('beforeend', icon('search', 'qa-ic-sm'));
        var inp = h('input', { type: 'search', placeholder: s.placeholder || T('খুঁজুন…', 'Search…'), autocomplete: 'off', enterkeyhint: 'search', 'aria-label': s.placeholder || '' });
        inp.style.marginInlineStart = '10px';
        if(s.value) inp.value = s.value;
        if(s.onInput) inp.addEventListener('input', function(){ s.onInput(inp.value); });
        inp.addEventListener('keydown', function(e){ if(e.key === 'Enter'){ if(s.onSubmit) s.onSubmit(inp.value); inp.blur(); } });
        wrap.appendChild(inp);
        barParts.titles.style.display = 'none';
        barParts.titles.parentNode.insertBefore(wrap, barParts.actions);
        barParts.searchWrap = wrap; barParts.searchInput = inp;
        if(s.autofocus) setTimeout(function(){ try{ inp.focus(); }catch(e){} }, 120);
      } else {
        barParts.titles.style.display = '';
        if(barParts.searchWrap){ barParts.searchWrap.remove(); barParts.searchWrap = null; barParts.searchInput = null; }
        if(cfg.brand){
          var t = h('div', { class: 'qa-topbar-title qa-brand' }, h('span', { class: 'qa-brand-ar', lang: 'ar' }, 'قرآن'), h('span', {}, cfg.title || 'কুরআন বাংলা'));
          barParts.titles.appendChild(t);
        } else {
          barParts.titles.appendChild(h('div', { class: 'qa-topbar-title' }, cfg.title || ''));
        }
        if(cfg.sub) barParts.titles.appendChild(h('div', { class: 'qa-topbar-sub' }, cfg.sub));
      }
      (cfg.actions || []).forEach(function(a){
        if(!a) return;
        var b = UI.iconButton(a.icon, a.label, a.onClick, a.on ? 'qa-on' : '');
        if(a.badge) b.appendChild(h('span', { class: 'qa-badge-dot' }));
        barParts.actions.appendChild(b);
      });
    },
    focusSearch: function(){ if(barParts.searchInput) barParts.searchInput.focus(); },
    setElevated: function(on){ if(bar) bar.classList.toggle('qa-elevated', !!on); }
  };
})();
