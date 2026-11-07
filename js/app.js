// ---------- Theme system ----------
// Browser-chrome color (address bar / status bar tint) to match each theme,
// same order as THEMES in js/data.js.
const THEME_COLORS = {
  emerald:'#092723', night:'#0A211D', royal:'#120B21',
  desert:'#7A3B12', ocean:'#0A4A61', amoled:'#000000', rose:'#7E2F4B'
};
function themeMeta(id){ return THEMES.find(t => t.id === id) || THEMES[0]; }

// The single place that actually applies a theme: sets the attribute every
// themed CSS rule keys off, flips the dark-accent class, tints the browser
// chrome, remembers the choice, and keeps every bit of theme UI in sync —
// so no matter where a theme gets picked from, the whole app updates together.
function applyTheme(id, opts){
  opts = opts || {};
  const meta = themeMeta(id);
  state.theme = meta.id;
  trackThemeTried(meta.id);
  document.body.setAttribute('data-theme', meta.id);
  document.body.classList.toggle('theme-dark-accent', !!meta.dark);
  const mc = document.querySelector('meta[name="theme-color"]');
  if(mc) mc.setAttribute('content', THEME_COLORS[meta.id] || THEME_COLORS.emerald);
  if(opts.save !== false) saveTheme();
  syncThemeHeaderIcon();
  syncThemeSettingsLabel();
  refreshThemePickerActive();
}

function syncThemeHeaderIcon(){
  const btn = document.getElementById('themeBtn');
  if(!btn) return;
  const icon = btn.querySelector('i');
  if(icon) icon.className = themeMeta(state.theme).dark ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
}
function syncThemeSettingsLabel(){
  const label = document.getElementById('settingsThemeLabel');
  if(!label) return;
  const dict = I18N[state.language] || I18N.en;
  const meta = themeMeta(state.theme);
  label.textContent = dict[meta.nameKey] || I18N.en[meta.nameKey] || meta.id;
}
function refreshThemePickerActive(){
  const grid = document.getElementById('themePickerGrid');
  if(!grid) return;
  grid.querySelectorAll('.theme-picker-card').forEach(card => {
    card.classList.toggle('active', card.getAttribute('data-theme-id') === state.theme);
  });
}

// Builds (once) and opens the visual theme gallery: a grid of cards, each a
// live color-swatch preview + name/description, reused from Settings and
// from the quick header button so there's exactly one picker in the app.
function openThemePicker(){
  const dict = I18N[state.language] || I18N.en;
  const t = (k) => dict[k] !== undefined ? dict[k] : I18N.en[k];
  let modal = document.getElementById('themePickerModal');
  if(!modal){
    modal = document.createElement('div');
    modal.className = 'app-modal';
    modal.id = 'themePickerModal';
    modal.innerHTML = `
      <div class="app-modal-box">
        <div class="app-modal-head">
          <h3 id="themePickerTitle"></h3>
          <button class="app-modal-close" id="themePickerClose">✕</button>
        </div>
        <div class="app-modal-body">
          <div class="theme-picker-grid" id="themePickerGrid"></div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    wireModalBackdrop('themePickerModal');
    document.getElementById('themePickerClose').onclick = () => closeModal('themePickerModal');
  }
  document.getElementById('themePickerTitle').textContent = t('theme_picker_title');
  const grid = document.getElementById('themePickerGrid');
  grid.innerHTML = THEMES.filter(theme => theme.id !== 'custom').map(theme => `
    <button class="theme-picker-card${theme.id === state.theme ? ' active' : ''}" data-theme-id="${theme.id}" type="button">
      <span class="theme-picker-swatch">${theme.swatch.map(c => `<span style="background:${c}"></span>`).join('')}</span>
      <span class="theme-picker-name">${t(theme.nameKey)}${theme.id === state.theme ? ' <i class="fa-solid fa-circle-check"></i>' : ''}</span>
      <span class="theme-picker-desc">${t(theme.descKey)}</span>
    </button>`).join('');
  grid.querySelectorAll('.theme-picker-card').forEach(card => {
    card.onclick = () => applyTheme(card.getAttribute('data-theme-id'));
  });
  if(typeof appendCustomThemeCard === 'function') appendCustomThemeCard(grid, t);
  openModal('themePickerModal');
}

function initTheme(){
  applyTheme(state.theme, { save:false }); // paint the theme chosen at load time
  document.getElementById('themeBtn').onclick = openThemePicker;
}

// ---------- Font size buttons (reader toolbar) ----------
function initFontControls(){
  document.getElementById('incFont').onclick = () => { state.fontStep = Math.min(state.fontStep+1, 6); applyFontSize(); };
  document.getElementById('decFont').onclick = () => { state.fontStep = Math.max(state.fontStep-1, -3); applyFontSize(); };
}

// ---------- Offline / online status pill in the header ----------
// Shows three states: fully offline, online-but-a-cloud-sync-is-still-pending
// (see cloudSyncPending in js/auth.js), or hidden when everything is caught up.
// Exposed globally (not just called once) so js/auth.js can refresh it the
// moment a sync attempt succeeds/fails/gets queued.
function updateConnStatusPill(){
  const pill = document.getElementById('connStatus');
  if(!pill) return;
  const online = navigator.onLine;
  const pending = typeof cloudSyncPending !== 'undefined' && cloudSyncPending;
  if(!online){
    pill.innerHTML = '<i class="fa-solid fa-cloud-arrow-down"></i> অফলাইন মোড';
    pill.classList.add('visible');
  } else if(pending){
    pill.innerHTML = '<i class="fa-solid fa-rotate fa-spin"></i> সিঙ্ক হচ্ছে...';
    pill.classList.add('visible');
  } else {
    pill.textContent = '';
    pill.classList.remove('visible');
  }
}
function initConnectionStatus(){
  const pill = document.getElementById('connStatus');
  if(!pill) return;
  window.addEventListener('online', () => {
    updateConnStatusPill();
    if(typeof showToast === 'function') showToast('🟢 আবার সংযুক্ত হয়েছে');
  });
  window.addEventListener('offline', () => {
    updateConnStatusPill();
    if(typeof showToast === 'function') showToast('অফলাইন মোড — সংরক্ষিত কনটেন্ট দিয়ে অ্যাপ চলবে');
  });
  updateConnStatusPill();
}

// ---------- Service worker registration: this is what makes the whole app,
// its Quran text, and previously played tilawat work with no internet at all. ----------
function initServiceWorker(){
  if(!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support just won't be available */ });
  });
  // Ask the browser not to evict cached Quran audio/text under storage pressure.
  if(navigator.storage && navigator.storage.persist){
    navigator.storage.persist().catch(() => {});
  }
  // ---------- স্মার্ট আপডেট: পুরনো JS + নতুন ক্যাশ একসাথে মিশে না যায় ----------
  // sw.js প্রতিটি নতুন ভার্সনে skipWaiting()+clients.claim() করে সাথে সাথেই
  // কন্ট্রোল নিয়ে নেয় (দ্রুত ডিপ্লয়ের জন্য ইচ্ছাকৃত)। সমস্যা হলো: এতে ট্যাব
  // খোলা থাকা অবস্থাতেই নিচের ক্যাশ/ফাইল বদলে যায়, অথচ পেজে আগে থেকে চলতে
  // থাকা JS পুরনোই থেকে যায় — দুটো ভার্সন মিশে গিয়ে সূক্ষ্ম bug হতে পারে।
  // এখানে সেই মুহূর্তটা (controllerchange) ধরে একবার নিজে থেকেই রিফ্রেশ করে
  // দেওয়া হয়, যাতে ইউজারকে ম্যানুয়ালি রিলোড করতে না হয় অথচ সবসময় সব
  // ফাইলের একই ভার্সন নিয়ে অ্যাপ চলে।
  // ব্রাউজার এই পেজ লোড হওয়ার সময়ই যদি ইতিমধ্যে কোনো SW-এর কন্ট্রোলে থাকে,
  // তবেই এটা একটা "রিটার্নিং ইউজার" — অর্থাৎ পরের controllerchange মানে সত্যিকারের
  // নতুন ভার্সন। প্রথমবার ইনস্টলের সময় clients.claim()-এর কারণেও একটা
  // controllerchange ঘটে (null থেকে প্রথম কন্ট্রোলার), সেটাকে "আপডেট" হিসেবে
  // ভুল করে রিফ্রেশ করা এড়াতেই এই চেক।
  const hadController = !!navigator.serviceWorker.controller;
  let swRefreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if(!hadController || swRefreshing) return;
    swRefreshing = true;
    if(typeof showToast === 'function') showToast('✨ নতুন আপডেট ইনস্টল হয়েছে — রিফ্রেশ হচ্ছে');
    setTimeout(() => window.location.reload(), 900);
  });
}

// ---------- "Install app" button (PWA), the most reliable way to get heavy
// offline use + steady background/lock-screen audio on mobile. ----------
function initInstallPrompt(){
  const btn = document.getElementById('installBtn');
  if(!btn) return;
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    btn.style.display = 'inline-flex';
  });
  btn.onclick = async () => {
    if(!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    btn.style.display = 'none';
  };
  window.addEventListener('appinstalled', () => { btn.style.display = 'none'; });
}

// ---------- Keep header fixed on top: measure its real height (it can
// wrap to two lines on small screens) and push page content down by
// exactly that much, so nothing is hidden underneath it. ----------
function initHeaderOffset(){
  const header = document.querySelector('header');
  if(!header) return;
  const setOffset = () => {
    document.documentElement.style.setProperty('--header-h', header.offsetHeight + 'px');
  };
  setOffset();
  window.addEventListener('resize', setOffset);
  window.addEventListener('orientationchange', setOffset);
  // Re-measure once web fonts finish loading, since font swap can change header height.
  if(document.fonts && document.fonts.ready) document.fonts.ready.then(setOffset);
}

// ---------- Home-screen shortcuts (manifest.json "shortcuts") ----------
// Long-pressing the installed app's icon offers a few direct jumps (see
// manifest.json). Each one launches index.html with ?shortcut=<id>; once
// the rest of init has run and every view/modal is ready, send the user
// straight there, then strip the query param so a later plain refresh of
// this same tab doesn't repeat the jump.
function handleShortcutLaunch(){
  const params = new URLSearchParams(window.location.search);
  const shortcut = params.get('shortcut');
  if(!shortcut) return;

  if(shortcut === 'continue'){
    if(state.lastRead && state.lastRead.surah){
      openSurahAndScrollTo(state.lastRead.surah, state.lastRead.ayah || 1);
    } else {
      showToast('এখনো কোনো পঠিত অংশ নেই');
    }
  } else if(shortcut === 'search'){
    goToView('home');
    const input = document.getElementById('searchInput');
    if(input){
      // Give the view switch a moment to finish before focusing/scrolling.
      setTimeout(() => { input.focus(); input.scrollIntoView({ block: 'center' }); }, 200);
    }
  } else if(shortcut === 'qibla'){
    if(typeof openQiblaModal === 'function') openQiblaModal();
  } else if(shortcut === 'stats'){
    goToView('stats');
  }

  const cleanUrl = window.location.pathname + window.location.hash;
  window.history.replaceState({}, '', cleanUrl);
}

// ---------- App init ----------
(async function init(){
  if(typeof IDBKV !== 'undefined') await IDBKV.init();
  loadPrefs();
  if(typeof initAuth === 'function') initAuth();
  if(typeof loadCustomTheme === 'function') loadCustomTheme();
  initTheme();
  initFontControls();
  initHeaderOffset();
  initNav();
  initMenu();
  initTopics();
  if(typeof initHadith === 'function') initHadith();
  initPlanner();
  initStats();
  initRamadan();
  initConnectionStatus();
  initInstallPrompt();
  initServiceWorker();
  if(typeof initSmartStorage === 'function') initSmartStorage();
  if(typeof initForegroundPush === 'function') initForegroundPush();
  if(typeof initDonationBanner === 'function') initDonationBanner();
  if(typeof initExam === 'function') initExam();
  initSearch();
  initPlayer();
  fetchSurahList();
  renderHomeExtras();
  handleShortcutLaunch();
  if(typeof initOnboarding === 'function') initOnboarding();
})();
