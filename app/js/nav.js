// ---------- Android app UI · navigation shell ----------
// Five bottom-navigation destinations (Home · Quran · Discover · Bookmarks · More),
// a stack of pushed screens above them (reader, search, settings, legacy tools ...),
// the single top app bar, and ONE hardware-back handler that decides, in order:
//
//   1. an app sheet / dialog is open              -> close it
//   2. a website overlay is open (modal, auth ...) -> close it
//   3. the audio player panel is expanded          -> collapse it
//   4. the visible screen has an inner state       -> step out of it
//   5. a screen is pushed                          -> pop it
//   6. a tab other than Home is showing            -> go to Home
//   7. Home                                        -> "press back again" -> minimize / exit
//
// Nothing here knows about Quran data; screens register themselves (see home.js,
// quran.js, ...) with QRApp.nav.register(id, definition).
(function(){
  'use strict';
  var QRApp = window.QRApp, h = QRApp.h, icon = QRApp.icon, T = QRApp.T, UI = QRApp.ui, NAT = QRApp.native;
  var root = document.documentElement;
  var nav = QRApp.nav = {};

  var defs = {};            // id -> screen definition
  var tabIds = [];          // ordered tab ids
  var routes = [];          // pushed routes (top = last)
  var tabEls = {};          // tab id -> screen element
  var tabEntries = {};      // tab id -> entry
  var rootEl = null, navEl = null, netEl = null;
  var curTab = 'home';
  var scrollPos = {};
  var routeSeq = 0;
  var singletonEls = {};
  var built = false;

  // ---------- registry ----------
  // def: { tab, order, icon, label:[bn,en], mount(el, params), show(params, el), hide(params, el),
  //        topbar(params, entry) -> cfg, onBack(entry) -> bool, onReselect(), singleton, host }
  nav.register = function(id, def){
    def.id = id; defs[id] = def;
    if(def.tab && tabIds.indexOf(id) === -1){
      tabIds.push(id);
      tabIds.sort(function(a, b){ return (defs[a].order || 0) - (defs[b].order || 0); });
    }
    return def;
  };
  nav.def = function(id){ return defs[id]; };

  function label(def){ var l = def.label || [def.id, def.id]; return T(l[0], l[1]); }

  // ---------- offline notice ----------
  function fillNetbar(){
    if(!netEl) return;
    netEl.innerHTML = '';
    netEl.appendChild(UI.banner(T('অফলাইন — সংরক্ষিত ও আগে খোলা সূরা পড়া যাবে। খোঁজা, নামাজের সময় ও নতুন সূরার জন্য ইন্টারনেট লাগবে।',
                                  'Offline — saved and recently opened surahs still work. Search, prayer times and new surahs need internet.')));
  }

  // ---------- shell ----------
  nav.build = function(){
    if(built) return; built = true;
    rootEl = h('main', { class: 'qa-root', id: 'qa-root' });
    var legacyHost = document.querySelector('.app-shell');
    if(legacyHost && legacyHost.parentNode) legacyHost.parentNode.insertBefore(rootEl, legacyHost);
    else document.body.appendChild(rootEl);

    UI.topbar.mount();

    // "offline" notice: always in the DOM, shown by css only while the phone has no connection (html.qa-offline)
    netEl = h('div', { class: 'qa-netbar', role: 'status', 'aria-live': 'polite' });
    rootEl.appendChild(netEl);
    fillNetbar();
    QRApp.on('language', fillNetbar);

    navEl = h('nav', { class: 'qa-nav', role: 'tablist', 'aria-label': T('প্রধান নেভিগেশন', 'Main navigation') });
    document.body.appendChild(navEl);
    buildNavButtons();

    tabIds.forEach(function(id){
      var el = h('section', { class: 'qa-screen', 'data-screen': id, 'aria-label': label(defs[id]) });
      tabEls[id] = el; rootEl.appendChild(el);
      tabEntries[id] = { tab: true, id: id, def: defs[id], el: el, params: {}, key: 'tab:' + id };
    });

    var onScroll = QRApp.throttleRaf(function(){ UI.topbar.setElevated((window.scrollY || 0) > 2); });
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', QRApp.debounce(updateLayout, 80));
    window.addEventListener('orientationchange', function(){ setTimeout(updateLayout, 250); });
    QRApp.on('keyboard', updateLayout);
    watchPlayer();
  };

  function buildNavButtons(){
    navEl.innerHTML = '';
    tabIds.forEach(function(id){
      var d = defs[id];
      var btn = h('button', { class: 'qa-nav-item' + (id === curTab ? ' qa-active' : ''), type: 'button', role: 'tab', 'data-tab': id, 'aria-selected': id === curTab ? 'true' : 'false', 'aria-label': label(d) },
        h('span', { class: 'qa-nav-pill', html: icon(d.icon) }),
        h('span', { class: 'qa-nav-label' }, label(d)));
      btn.addEventListener('click', function(){ nav.go(id, { user: true }); });
      navEl.appendChild(btn);
    });
  }
  function syncNavActive(){
    if(!navEl) return;
    QRApp.$$('.qa-nav-item', navEl).forEach(function(b){
      var on = b.getAttribute('data-tab') === curTab;
      b.classList.toggle('qa-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  // ---------- layout: space reserved for the bottom nav + mini player ----------
  var railMq = null;
  function isRail(){
    try{ railMq = railMq || window.matchMedia('(min-width:840px)'); return railMq.matches; }catch(e){ return false; }
  }
  function updateLayout(){
    var navVisible = navEl && !root.classList.contains('qa-nav-hidden') && !root.classList.contains('qa-kbd-open');
    var navH = (navVisible && !isRail()) ? navEl.offsetHeight : 0;
    var pb = document.getElementById('playerBar');
    var playerVisible = pb && pb.classList.contains('visible') && !root.classList.contains('qa-kbd-open');
    var pH = playerVisible ? pb.offsetHeight : 0;
    root.style.setProperty('--qa-nav-offset', navH + 'px');
    root.style.setProperty('--qa-bottom-reserve', (navH + pH) + 'px');
    // js/player.js (follow-along scrolling) reads this to know how much of the screen is covered
    root.style.setProperty('--player-h', (navH + pH) + 'px');
  }
  nav.updateLayout = updateLayout;
  function watchPlayer(){
    var pb = document.getElementById('playerBar');
    if(!pb) return;
    try{
      new MutationObserver(updateLayout).observe(pb, { attributes: true, attributeFilter: ['class'] });
      if(window.ResizeObserver) new ResizeObserver(updateLayout).observe(pb);
    }catch(e){}
  }

  // ---------- entries ----------
  function topRoute(){ return routes.length ? routes[routes.length - 1] : null; }
  function curEntry(){ return topRoute() || tabEntries[curTab]; }
  nav.current = function(){ var e = curEntry(); return e ? { id: e.id, tab: !!e.tab, params: e.params } : null; };
  nav.tab = function(){ return curTab; };
  nav.hasRoutes = function(){ return routes.length > 0; };
  nav.isHomeRoot = function(){ return !routes.length && curTab === 'home'; };
  nav.routeIds = function(){ return routes.map(function(r){ return r.id; }); };

  function saveScroll(e){ if(e) scrollPos[e.key] = window.scrollY || 0; }
  function restoreScroll(e){
    var y = (e && scrollPos[e.key]) || 0;
    window.scrollTo(0, y);
    requestAnimationFrame(function(){ if(Math.abs((window.scrollY || 0) - y) > 2) window.scrollTo(0, y); });
  }

  function ensureMounted(e){
    var el = e.el;
    if(!el || el._mounted) return;
    el._mounted = true;
    try{
      var r = e.def.mount && e.def.mount(el, e.params, e);
      if(r && typeof r.catch === 'function') r.catch(function(err){ mountFailed(e, err); });
    }catch(err){ mountFailed(e, err); }
  }
  function mountFailed(e, err){
    QRApp.warn('screen failed to mount', e.id, err);
    if(!e.el) return;
    e.el.innerHTML = '';
    e.el.appendChild(UI.errorState({ onRetry: function(){ e.el._mounted = false; e.el.innerHTML = ''; ensureMounted(e); if(e.def.show) try{ e.def.show(e.params, e.el, e); }catch(x){} } }));
  }

  function leave(e){
    if(!e) return;
    saveScroll(e);
    try{ e.def.hide && e.def.hide(e.params, e.el, e); }catch(err){ QRApp.warn('hide failed', e.id, err); }
  }

  function enter(e, opts){
    opts = opts || {};
    var top = topRoute();
    // visibility of the app screens
    Object.keys(tabEls).forEach(function(id){ tabEls[id].classList.toggle('qa-active', !top && id === curTab); });
    routes.forEach(function(r){ if(r.el) r.el.classList.toggle('qa-active', r === top); });
    root.classList.toggle('qa-legacy-visible', !!(top && top.def.host === 'legacy'));
    root.classList.toggle('qa-nav-hidden', !!top);
    root.setAttribute('data-qa-screen', e.id);
    syncNavActive();
    ensureMounted(e);
    try{ e.def.show && e.def.show(e.params, e.el, e); }catch(err){ QRApp.warn('show failed', e.id, err); }
    applyTopbar(e);
    updateLayout();
    if(opts.scrollTop) window.scrollTo(0, 0); else restoreScroll(e);
    UI.topbar.setElevated((window.scrollY || 0) > 2);
    QRApp.emit('nav', { id: e.id, tab: !!e.tab, params: e.params });
  }

  function applyTopbar(e){
    e = e || curEntry();
    if(!e) return;
    var cfg = null;
    try{ cfg = e.def.topbar ? e.def.topbar(e.params, e) : null; }catch(err){ QRApp.warn('topbar failed', e.id, err); }
    cfg = cfg || { title: label(e.def) };
    // Screens that scroll content under the bar keep it flat until scrolled.
    UI.topbar.apply(cfg);
    UI.topbar.setElevated(!!cfg.elevated || (window.scrollY || 0) > 2);
  }
  nav.refreshTopbar = function(){ if(built) applyTopbar(curEntry()); };

  // ---------- tabs ----------
  // nav.go('quran') — also pops every pushed screen.
  nav.go = function(id, opts){
    opts = opts || {};
    if(!built || !defs[id] || !defs[id].tab) return false;
    var before = curEntry();
    // Re-tapping the tab you are on: scroll to top, or let the screen react.
    if(!routes.length && id === curTab){
      if((window.scrollY || 0) > 40){ window.scrollTo({ top: 0, behavior: 'smooth' }); return true; }
      if(defs[id].onReselect){ try{ defs[id].onReselect(); }catch(e){} }
      return true;
    }
    leave(before);
    while(routes.length) dropRoute(routes.pop());
    curTab = id;
    enter(tabEntries[id], { scrollTop: !!opts.scrollTop });
    return true;
  };

  // ---------- pushed screens ----------
  function dropRoute(r){
    if(!r) return;
    if(r.el){
      if(r.def.singleton) r.el.classList.remove('qa-active');   // kept (mounted) for the next push, but hidden
      else { try{ r.def.unmount && r.def.unmount(r.el, r.params, r); }catch(e){} r.el.remove(); }
    }
    delete scrollPos[r.key];
  }

  // nav.push('reader', {type:'surah', num:2}); opts: {replace:true}
  nav.push = function(id, params, opts){
    opts = opts || {};
    var def = defs[id];
    if(!built || !def){ QRApp.warn('unknown screen', id); return null; }
    params = params || {};
    var before = curEntry();

    // A singleton screen that is already on the stack is reused (params replaced).
    if(def.singleton){
      for(var i = 0; i < routes.length; i++){
        if(routes[i].id !== id) continue;
        leave(before);
        while(routes.length - 1 > i) dropRoute(routes.pop());
        var ex = routes[i]; ex.params = params;
        enter(ex, { scrollTop: true });
        return ex;
      }
    }
    leave(before);
    if(opts.replace && routes.length) dropRoute(routes.pop());
    var el = null;
    if(def.host !== 'legacy'){
      if(def.singleton && singletonEls[id]) el = singletonEls[id];
      else{
        el = h('section', { class: 'qa-screen', 'data-screen': id });
        rootEl.appendChild(el);
        if(def.singleton) singletonEls[id] = el;
      }
    }
    var entry = { id: id, def: def, el: el, params: params, key: 'route:' + (++routeSeq) + ':' + id };
    routes.push(entry);
    enter(entry, { scrollTop: true });
    return entry;
  };

  nav.pop = function(){
    if(!routes.length) return false;
    var gone = routes.pop();
    leave(gone);
    dropRoute(gone);
    enter(curEntry());
    return true;
  };

  // The pushed entry for a screen id (top-most match), the entry that is on top, and
  // popping back down to a given screen.
  nav.find = function(id){
    for(var i = routes.length - 1; i >= 0; i--){ if(routes[i].id === id) return routes[i]; }
    return null;
  };
  nav.top = function(){ return curEntry() || null; };
  nav.popTo = function(id){
    var idx = -1;
    for(var i = routes.length - 1; i >= 0; i--){ if(routes[i].id === id){ idx = i; break; } }
    if(idx < 0) return false;
    if(idx === routes.length - 1) return true;
    leave(curEntry());
    while(routes.length - 1 > idx) dropRoute(routes.pop());
    enter(routes[idx]);
    return true;
  };

  // Replace a screen's params and re-run show() (e.g. the reader opening another surah).
  nav.update = function(id, params){
    var e = curEntry();
    if(!e || e.id !== id) return;
    e.params = params || {};
    try{ e.def.show && e.def.show(e.params, e.el, e); }catch(err){ QRApp.warn('update failed', err); }
    applyTopbar(e);
  };

  // Website screens (planner, topics, hadith, stats, exam, profile) are hosted by the
  // website's own .app-shell. See legacy.css for how they are re-skinned.
  nav.openLegacy = function(view, opts){
    opts = opts || {};
    return nav.push('legacy', { view: view, title: opts.title }, opts);
  };

  // Re-render every mounted screen (used after the interface language changes).
  // A screen may define relocalize(el, params, entry) to redraw itself in place (the reader does, so the
  // loaded passage and the reading position survive); otherwise it is unmounted and mounted again.
  nav.invalidateAll = function(){
    if(!built) return;
    buildNavButtons();
    function reset(def, el, params, entry){
      if(def.relocalize){ try{ def.relocalize(el, params, entry); }catch(e){ QRApp.warn('relocalize failed', e); } return; }
      try{ def.unmount && def.unmount(el, params, entry); }catch(e){}
      el._mounted = false; el.innerHTML = '';
    }
    Object.keys(tabEls).forEach(function(id){
      var el = tabEls[id];
      reset(defs[id], el, {}, tabEntries[id]);
      el.setAttribute('aria-label', label(defs[id]));
    });
    routes.forEach(function(r){ if(r.el) reset(r.def, r.el, r.params, r); });
    var e = curEntry();
    ensureMounted(e);
    try{ e.def.show && e.def.show(e.params, e.el, e); }catch(err){}
    applyTopbar(e);
    QRApp.emit('relocalize');
  };
  nav.relocalize = nav.invalidateAll;

  // ---------- website (legacy) overlays ----------
  // The reused website screens open their own modals / overlays. They are detected on demand
  // (when the back button is pressed) rather than observed.
  var MODAL_SUBBACK = { settingsModal: '#settingsBackBtn', translationHelpModal: '#trHelpBackBtn' };

  function isShown(el){
    if(!el) return false;
    var cs = window.getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length > 0;
  }
  function zOf(el){ var z = parseInt(window.getComputedStyle(el).zIndex, 10); return isNaN(z) ? 0 : z; }

  function openLegacyOverlays(){
    var list = [];
    QRApp.$$('.app-modal').forEach(function(el, i){
      if(isShown(el)) list.push({ el: el, kind: 'modal', z: zOf(el), order: i });
    });
    var auth = QRApp.$$('.auth-overlay.open');
    auth.forEach(function(el, i){ list.push({ el: el, kind: 'auth', z: zOf(el) + 1, order: 1000 + i }); });
    [['statusAudioSheet', 'statusAudioSheet'], ['statusViewersSheet', 'statusViewersSheet'], ['statusViewerOverlay', 'statusViewer'], ['statusComposerOverlay', 'statusComposer']].forEach(function(p, i){
      var el = document.getElementById(p[0]);
      if(el && el.classList.contains('open')) list.push({ el: el, kind: p[1], z: 2000 + i, order: 2000 + i });
    });
    list.sort(function(a, b){ return (a.z - b.z) || (a.order - b.order); });
    return list;
  }
  nav.hasLegacyOverlay = function(){ return openLegacyOverlays().length > 0; };

  function closeLegacyOverlay(){
    var list = openLegacyOverlays();
    if(!list.length) return false;
    var top = list[list.length - 1], el = top.el;
    try{
      if(top.kind === 'modal'){
        var sub = MODAL_SUBBACK[el.id] && el.querySelector(MODAL_SUBBACK[el.id]);
        if(sub && isShown(sub)){ sub.click(); return true; }
        if(el.id === 'aiTafsirModal'){
          var hp = document.getElementById('aiTafsirHistoryPanel');
          var hc = document.getElementById('aiTafsirHistoryClose');
          if(hp && isShown(hp) && hc){ hc.click(); return true; }
        }
        var closeBtn = el.querySelector('.app-modal-close');
        if(closeBtn){ closeBtn.click(); }
        else if(el.id && typeof closeModal === 'function'){ closeModal(el.id); }
        // anything still open (a close button that did nothing) is hidden so back never feels stuck
        if(isShown(el)) el.style.display = 'none';
      } else if(top.kind === 'auth'){
        if(el.id === 'authOverlay' && typeof closeAuthFlow === 'function') closeAuthFlow(); else el.classList.remove('open');
      } else if(top.kind === 'statusViewer' && typeof closeStatusViewer === 'function') closeStatusViewer();
      else if(top.kind === 'statusComposer' && typeof closeStatusComposer === 'function') closeStatusComposer();
      else if(top.kind === 'statusViewersSheet' && typeof closeStatusViewersSheet === 'function') closeStatusViewersSheet();
      else if(top.kind === 'statusAudioSheet' && typeof closeStatusAudioSheet === 'function') closeStatusAudioSheet();
      else el.classList.remove('open');
    }catch(err){ QRApp.warn('closing website overlay failed', err); try{ el.style.display = 'none'; el.classList.remove('open'); }catch(e){} }
    return true;
  }
  nav.closeLegacyOverlay = closeLegacyOverlay;

  // Inner states of the reused website screens.
  function clickIfShown(sel){
    var el = document.querySelector(sel);
    if(el && el.getClientRects().length > 0 && window.getComputedStyle(el).display !== 'none'){ el.click(); return true; }
    return false;
  }
  function visibleBlock(sel){ var el = document.querySelector(sel); return !!(el && el.style.display !== 'none' && el.getClientRects().length > 0); }
  function legacyBack(view){
    if(view === 'topics' && visibleBlock('#topicDetailContainer')){ return clickIfShown('#topicBackBtn') || (function(){ document.getElementById('topicBackBtn').click(); return true; })(); }
    if(view === 'hadith'){
      if(visibleBlock('#hadithListContainer')){ document.getElementById('hadithListBackBtn').click(); return true; }
      if(visibleBlock('#hadithChaptersContainer')){ document.getElementById('hadithChaptersBackBtn').click(); return true; }
    }
    if(view === 'profile'){
      var act = document.querySelector('#profilePageAuth .auth-screen.active');
      if(act && act.id !== 'ppAuthChoice'){
        var b = act.querySelector('[data-pp-back]');
        if(b){ b.click(); return true; }
      }
    }
    return false;
  }

  // The website's goToView(view) — the original is kept to switch/lazy-render a website section.
  var LEGACY_VIEWS = ['planner', 'topics', 'hadith', 'stats', 'exam', 'profile'];
  var LEGACY_TITLES = {
    planner: ['প্ল্যানার', 'Planner'], topics: ['বিষয়ভিত্তিক', 'Topics'], hadith: ['হাদিস', 'Hadith'],
    stats: ['পরিসংখ্যান', 'Statistics'], exam: ['পরীক্ষা', 'Exams'], profile: ['প্রোফাইল', 'Profile']
  };
  nav.legacyViews = LEGACY_VIEWS;
  nav.register('legacy', {
    host: 'legacy',
    show: function(params){
      var v = params.view;
      var orig = (window.goToView && window.goToView.__orig) || window.goToView;
      if(typeof orig === 'function'){ try{ orig(v); }catch(err){ QRApp.warn('website view failed', v, err); } }
    },
    topbar: function(params){
      var t = LEGACY_TITLES[params.view];
      return { lead: 'back', title: params.title || (t ? T(t[0], t[1]) : ''), elevated: false };
    },
    onBack: function(e){ return legacyBack(e.params.view); }
  });

  // ---------- the one back handler ----------
  // Returns a short reason when the press was consumed inside the app, false otherwise.
  nav.back = function(){
    if(!built) return false;
    if(QRApp.overlays.closeTop()) return 'overlay';
    if(closeLegacyOverlay()) return 'website-overlay';
    try{
      if(typeof isPlayerExpanded === 'function' && isPlayerExpanded()){ collapsePlayer(); return 'player'; }
    }catch(e){}
    var e = curEntry();
    if(e && e.def.onBack){
      var handled = false;
      try{ handled = e.def.onBack(e); }catch(err){ QRApp.warn('onBack failed', err); }
      if(handled) return 'screen';
    }
    if(routes.length){ nav.pop(); return 'pop'; }
    if(curTab !== 'home'){ nav.go('home'); return 'home'; }
    return false;
  };

  // Hardware / gesture back. At Home: first press shows a hint, second press leaves the app
  // (minimizing instead of exiting while a recitation is playing, so the audio keeps going).
  var lastBackAt = 0;
  function audioIsPlaying(){ try{ return !!state.isPlaying; }catch(e){ return false; } }
  nav.onHardwareBack = function(){
    if(nav.back()) return;
    var now = Date.now();
    if(now - lastBackAt < 2200){
      lastBackAt = 0;
      if(audioIsPlaying()) NAT.minimize(); else NAT.exit();
      return;
    }
    lastBackAt = now;
    UI.snack(audioIsPlaying()
      ? T('আবার ব্যাক চাপলে অ্যাপ মিনিমাইজ হবে (তিলাওয়াত চলবে)', 'Press back again to minimize (audio keeps playing)')
      : T('বের হতে আবার ব্যাক চাপুন', 'Press back again to exit'), { duration: 2000 });
  };

  nav.start = function(){
    NAT.onBack(function(){ nav.onHardwareBack(); });
    // Home is the initial screen.
    var e = tabEntries[curTab];
    enter(e, { scrollTop: true });
  };

  // ---------- external links open in a Chrome Custom Tab ----------
  document.addEventListener('click', function(ev){
    var a = ev.target && ev.target.closest && ev.target.closest('a[href]');
    if(!a || ev.defaultPrevented) return;
    var href = a.getAttribute('href') || '';
    if(!/^https?:\/\//i.test(href)) return;
    var sameOrigin = false;
    try{ sameOrigin = new URL(href, location.href).origin === location.origin; }catch(e){}
    if(sameOrigin && a.getAttribute('target') !== '_blank') return;
    ev.preventDefault();
    NAT.openExternal(href);
  }, true);
})();
