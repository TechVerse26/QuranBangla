// ---------- Settings / Prayer Times / Dictionary / Share / Help & Support ----------
// Everything the hamburger drawer needs beyond simple navigation lives here.

// ---- Small generic modal helpers (each modal is its own full-screen overlay,
// so no shared scrim element is needed — clicking the dark backdrop or
// pressing Escape closes whichever modal is open). ----
function openModal(id){
  const el = document.getElementById(id);
  if(!el) return;
  el.style.display = 'flex';
  document.addEventListener('keydown', modalEscHandler);
}
function closeModal(id){
  const el = document.getElementById(id);
  if(!el) return;
  el.style.display = 'none';
  document.removeEventListener('keydown', modalEscHandler);
  if(id === 'prayerModal') stopPrayerTicker();
  if(id === 'qiblaModal' && typeof stopQiblaCompass === 'function') stopQiblaCompass();
  if(id === 'themeBuilderModal' && typeof tbCancelIfUnsaved === 'function') tbCancelIfUnsaved();
  if(id === 'settingsModal') showSettingsCatList();
}
function modalEscHandler(e){
  if(e.key === 'Escape'){
    ['settingsModal','prayerModal','qiblaModal','dictionaryModal','helpModal','taraweehModal','langPickerModal','themePickerModal','compareTrModal','surahInfoModal','downloadManagerModal','themeBuilderModal','translationHelpModal','aiTafsirModal'].forEach(id => {
      const el = document.getElementById(id);
      if(el && el.style.display === 'flex') closeModal(id);
    });
  }
}
function wireModalBackdrop(id){
  const el = document.getElementById(id);
  if(!el) return;
  el.addEventListener('click', (e) => { if(e.target === el) closeModal(id); });
}

// ---- A properly-styled replacement for the browser's native prompt() ----
// window.prompt() shows the raw site address ("localhost:8899 says…"),
// which looks broken/unprofessional. This builds the same little app-modal
// box used everywhere else, with a text/number field, so every "type a
// value" moment in the app looks consistent.
function showInputBox({title, placeholder, defaultValue, confirmLabel, inputType, onConfirm}){
  const old = document.getElementById('dynInputModal');
  if(old) old.remove();
  const wrap = document.createElement('div');
  wrap.className = 'app-modal';
  wrap.id = 'dynInputModal';
  wrap.style.display = 'flex';
  wrap.innerHTML = `
    <div class="app-modal-box input-box-modal">
      <div class="app-modal-head">
        <h3>${title}</h3>
        <button class="app-modal-close" id="dynInputClose">✕</button>
      </div>
      <div class="app-modal-body">
        <input type="${inputType||'text'}" class="input-box-field" id="dynInputField" placeholder="${placeholder||''}" value="${defaultValue||''}">
        <div class="input-box-actions">
          <button class="tw-cancel-btn" id="dynInputCancel">বাতিল</button>
          <button class="tw-save-btn" id="dynInputSave">${confirmLabel||'ঠিক আছে'}</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const remove = () => wrap.remove();
  wrap.addEventListener('click', (e) => { if(e.target === wrap) remove(); });
  document.getElementById('dynInputClose').onclick = remove;
  document.getElementById('dynInputCancel').onclick = remove;
  const field = document.getElementById('dynInputField');
  const submit = () => { const v = field.value.trim(); if(v){ remove(); onConfirm(v); } };
  document.getElementById('dynInputSave').onclick = submit;
  field.addEventListener('keydown', (e) => { if(e.key === 'Enter') submit(); });
  field.focus();
  field.select();
}

// ================= Language / i18n =================
// Interface language: applies whichever I18N[lang] dictionary is chosen,
// falling back to English for any key a language block hasn't got yet.
function applyLanguage(lang){
  state.language = I18N[lang] ? lang : 'bn';
  saveLanguage();
  trackLanguageUsed(state.language);
  const dict = I18N[state.language];
  const fallback = I18N.en;
  // A user's own contributed translations (js/translation-help.js) win over
  // the built-in dictionary for whichever keys they've filled in, so
  // "custom translation" for a key actually takes effect app-wide.
  const custom = (state.customTranslations && state.customTranslations[state.language]) || {};
  const t = (key) => (custom[key] ? custom[key] : (dict[key] !== undefined ? dict[key] : fallback[key]));
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const val = t(key);
    if(val !== undefined) el.textContent = val;
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    const key = el.getAttribute('data-i18n-ph');
    const val = t(key);
    if(val !== undefined) el.placeholder = val;
  });
  document.documentElement.lang = state.language;
  const meta = UI_LANG_META.find(m => m.code === state.language);
  document.documentElement.dir = (meta && meta.dir === 'rtl') ? 'rtl' : 'ltr';
  const labelEl = document.getElementById('settingsLanguageLabel');
  if(labelEl) labelEl.textContent = meta ? meta.label : state.language;
  if(typeof syncThemeSettingsLabel === 'function') syncThemeSettingsLabel();
  if(typeof openThemePicker === 'function'){
    const grid = document.getElementById('themePickerGrid');
    if(grid && document.getElementById('themePickerModal').style.display === 'flex') openThemePicker();
  }
}
function initLanguage(){
  applyLanguage(state.language);
}

// ---- Generic searchable picker modal, reused for both the interface
// language list (static, from UI_LANG_META) and the Qur'an translation
// language list (dynamic, fetched from the API — see loadTranslationEditions
// in js/reader.js). Keeping one implementation means adding more languages
// to either list later needs no new UI code. ----
function openLangPickerModal({titleKey, items, activeId, onPick}){
  const dict = I18N[state.language] || I18N.en;
  const t = (k) => dict[k] !== undefined ? dict[k] : I18N.en[k];
  let modal = document.getElementById('langPickerModal');
  if(!modal){
    modal = document.createElement('div');
    modal.className = 'app-modal';
    modal.id = 'langPickerModal';
    modal.innerHTML = `
      <div class="app-modal-box">
        <div class="app-modal-head">
          <h3 id="langPickerTitle"></h3>
          <button class="app-modal-close" id="langPickerClose">✕</button>
        </div>
        <div class="app-modal-body">
          <input type="text" id="langPickerSearch" class="input-box-field" style="margin-bottom:10px;">
          <div id="langPickerList" class="lang-picker-list"></div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    wireModalBackdrop('langPickerModal');
    document.getElementById('langPickerClose').onclick = () => closeModal('langPickerModal');
  }
  document.getElementById('langPickerTitle').textContent = t(titleKey);
  const searchInput = document.getElementById('langPickerSearch');
  searchInput.placeholder = t('lang_search_ph');
  searchInput.value = '';
  const listEl = document.getElementById('langPickerList');
  const renderList = (filter) => {
    const q = (filter || '').trim().toLowerCase();
    const filtered = !q ? items : items.filter(it => it.label.toLowerCase().includes(q) || (it.sub||'').toLowerCase().includes(q));
    listEl.innerHTML = filtered.length ? filtered.map(it => `
      <button class="lang-picker-item${it.id === activeId ? ' active' : ''}${it.icon ? ' has-avatar' : ''}" data-id="${it.id}">
        ${it.icon ? `<span class="lp-avatar">${it.icon}</span>` : ''}
        <span class="lp-text">
          <span class="lp-label">${it.label}</span>
          ${it.sub ? `<span class="lp-sub">${it.sub}</span>` : ''}
        </span>
        ${it.id === activeId ? '<i class="fa-solid fa-check"></i>' : ''}
      </button>`).join('') : `<div class="lang-picker-empty">—</div>`;
    listEl.querySelectorAll('.lang-picker-item').forEach(btn => {
      btn.onclick = () => { closeModal('langPickerModal'); onPick(btn.getAttribute('data-id')); };
    });
  };
  renderList('');
  searchInput.oninput = () => renderList(searchInput.value);
  openModal('langPickerModal');
  setTimeout(() => searchInput.focus(), 50);
}

function openUiLanguagePicker(){
  openLangPickerModal({
    titleKey: 'settings_language',
    items: UI_LANG_META.map(m => ({ id: m.code, label: m.label })),
    activeId: state.language,
    onPick: (code) => { applyLanguage(code); }
  });
}

async function openTranslationLanguagePicker(){
  const btn = document.getElementById('settingsTranslationBtn');
  const label = document.getElementById('settingsTranslationLabel');
  if(label) label.textContent = '…';
  const editions = await loadTranslationEditions();
  const items = editions
    .map(e => ({ id: e.identifier, label: e.language ? `${e.name || e.englishName} — ${languageDisplayName(e.language)}` : (e.name || e.englishName), sub: e.identifier }))
    .sort((a,b) => a.label.localeCompare(b.label));
  if(label) label.textContent = translationEditionLabel(state.translationEdition);
  openLangPickerModal({
    titleKey: 'translation_picker_title',
    items,
    activeId: state.translationEdition,
    onPick: (identifier) => {
      state.translationEdition = identifier;
      saveTranslationEdition();
      if(label) label.textContent = translationEditionLabel(identifier);
      reopenCurrentReaderView();
    }
  });
}

// ================= স্মার্ট ক্বারী (তিলাওয়াতকারী) পিকার =================
// প্লেন <select> ড্রপডাউনের বদলে সার্চযোগ্য, প্রতিটি ক্বারীর বাংলা নাম/দেশ/ধরন
// দেখানো একটি মডাল — প্লেয়ার-বার ও সেটিংস দুই জায়গা থেকেই একই ফাংশন খোলে,
// তাই ক্বারী বদলালে সব জায়গায় সঙ্গে সঙ্গে সিঙ্ক থাকে।
function reciterShortLabel(id){
  const r = reciters.find(x => x.id === id);
  return r ? r.bn : id;
}
function updateReciterLabels(){
  const r = reciters.find(x => x.id === state.reciter);
  const label = r ? `${r.flag ? r.flag + ' ' : ''}${r.bn}` : state.reciter;
  const playerLabel = document.getElementById('reciterFieldLabel');
  if(playerLabel) playerLabel.textContent = label;
  const settingsLabel = document.getElementById('settingsReciterLabel');
  if(settingsLabel) settingsLabel.textContent = label;
}
function openReciterPicker(){
  const items = reciters.map(r => ({
    id: r.id,
    label: `${r.bn} — ${r.name}`,
    sub: r.style || '',
    icon: r.flag || '🎙️'
  }));
  openLangPickerModal({
    titleKey: 'settings_reciter',
    items,
    activeId: state.reciter,
    onPick: (id) => {
      state.reciter = id;
      saveReciter();
      updateReciterLabels();
      // চলমান তিলাওয়াত থাকলে সঙ্গে সঙ্গে নতুন ক্বারীর কণ্ঠে পুনরায় চালু করে।
      if(state.playIndex >= 0 && state.isPlaying) playAtIndex(state.playIndex, true);
    }
  });
}

// Human-readable label for whichever edition is currently selected, used on
// the Settings row button (e.g. "Sahih International — English").
function translationEditionLabel(identifier){
  const e = findTranslationEdition(identifier);
  if(e) return `${e.name || e.englishName} — ${languageDisplayName(e.language)}`;
  return identifier;
}
// Best-effort native/English name for a 2-letter language code, used to
// label Qur'an translation editions the built-in UI dictionary doesn't cover.
function languageDisplayName(code){
  const meta = UI_LANG_META.find(m => m.code === code);
  if(meta) return meta.label;
  try{
    return new Intl.DisplayNames([state.language, 'en'], { type: 'language' }).of(code);
  }catch(e){ return code; }
}

// ================= Settings modal =================
// Drill-down navigation: the modal opens on a category list; picking a
// category swaps in just that panel (title + back button), so the whole
// settings surface isn't dumped on screen in one long scroll.
const SETTINGS_CAT_TITLES = {
  lang: 'ভাষা ও অনুবাদ',
  recite: 'তিলাওয়াত ও পাঠ',
  appearance: 'চেহারা',
  prayer: 'নামাজ',
  special: 'বিশেষ মোড'
};
function showSettingsCatList(){
  const listEl = document.getElementById('settingsCatList');
  const backBtn = document.getElementById('settingsBackBtn');
  const titleEl = document.getElementById('settingsModalTitle');
  if(!listEl) return;
  listEl.style.display = '';
  document.querySelectorAll('.settings-cat-panel').forEach(p => p.classList.remove('active'));
  if(backBtn) backBtn.style.display = 'none';
  if(titleEl){
    const dict = I18N[state.language] || I18N.en;
    titleEl.textContent = dict.settings_title !== undefined ? dict.settings_title : I18N.en.settings_title;
  }
  const body = document.getElementById('settingsBody') || listEl.closest('.settings-body');
  if(body) body.scrollTop = 0;
}
function showSettingsCat(cat){
  const listEl = document.getElementById('settingsCatList');
  const panel = document.querySelector(`.settings-cat-panel[data-cat="${cat}"]`);
  const backBtn = document.getElementById('settingsBackBtn');
  const titleEl = document.getElementById('settingsModalTitle');
  if(!panel) return;
  if(listEl) listEl.style.display = 'none';
  document.querySelectorAll('.settings-cat-panel').forEach(p => p.classList.remove('active'));
  panel.classList.add('active');
  if(backBtn) backBtn.style.display = 'flex';
  if(titleEl) titleEl.textContent = SETTINGS_CAT_TITLES[cat] || titleEl.textContent;
  const body = panel.closest('.settings-body');
  if(body) body.scrollTop = 0;
}
function wireSettingsNav(){
  document.querySelectorAll('.settings-cat-item').forEach(btn => {
    btn.onclick = () => showSettingsCat(btn.getAttribute('data-cat'));
  });
  const backBtn = document.getElementById('settingsBackBtn');
  if(backBtn) backBtn.onclick = showSettingsCatList;
  showSettingsCatList();
}

function initSettingsModal(){
  wireModalBackdrop('settingsModal');
  document.getElementById('settingsClose').onclick = () => closeModal('settingsModal');
  wireSettingsNav();

  // Interface language picker
  const langBtn = document.getElementById('settingsLanguageBtn');
  if(langBtn){
    const meta = UI_LANG_META.find(m => m.code === state.language);
    document.getElementById('settingsLanguageLabel').textContent = meta ? meta.label : state.language;
    langBtn.onclick = openUiLanguagePicker;
  }

  // Qur'an translation language picker (all 50+ languages the API offers)
  const trBtn = document.getElementById('settingsTranslationBtn');
  if(trBtn){
    document.getElementById('settingsTranslationLabel').textContent = translationEditionLabel(state.translationEdition);
    trBtn.onclick = openTranslationLanguagePicker;
    loadTranslationEditions().then(() => {
      document.getElementById('settingsTranslationLabel').textContent = translationEditionLabel(state.translationEdition);
    });
  }

  // স্মার্ট ক্বারী পিকার — প্লেয়ার-বারের বাটনের সাথে একই ফাংশন/লেবেল শেয়ার করে।
  const recBtn = document.getElementById('settingsReciterBtn');
  if(recBtn){ recBtn.onclick = openReciterPicker; }
  updateReciterLabels();

  // Prayer calculation method
  const methodSel = document.getElementById('settingsPrayerMethod');
  methodSel.innerHTML = PRAYER_METHODS.map(m => `<option value="${m.id}">${m.name}</option>`).join('');
  methodSel.value = state.prayerMethod;
  methodSel.onchange = () => {
    state.prayerMethod = parseInt(methodSel.value, 10);
    savePrayerMethod();
    updatePushLocationIfSubscribed();
    if(document.getElementById('prayerModal').style.display === 'flex' && state.prayerLocation){
      fetchPrayerTimes(state.prayerLocation);
    }
  };

  // Theme gallery (mirrors the header's own theme button so there's one source of truth)
  const themeBtn = document.getElementById('settingsThemeBtn');
  if(themeBtn){
    const themeIcon = themeBtn.querySelector('i');
    if(themeIcon) themeIcon.className = 'fa-solid fa-palette';
    syncThemeSettingsLabel();
    themeBtn.onclick = openThemePicker;
  }

  // Font size (reuses the same state.fontStep as the reader toolbar)
  document.getElementById('settingsIncFont').onclick = () => { document.getElementById('incFont').click(); };
  document.getElementById('settingsDecFont').onclick = () => { document.getElementById('decFont').click(); };

  // Prayer time notifications
  const notifyChk = document.getElementById('settingsPrayerNotify');
  notifyChk.checked = state.prayerNotify;
  notifyChk.onchange = async () => {
    if(notifyChk.checked){
      if(!('Notification' in window)){
        showToast('এই ব্রাউজারে বিজ্ঞপ্তি সমর্থিত নয়');
        notifyChk.checked = false;
        return;
      }
      const perm = await Notification.requestPermission();
      if(perm !== 'granted'){
        notifyChk.checked = false;
        showToast('বিজ্ঞপ্তির অনুমতি দেওয়া হয়নি');
        return;
      }
      if(!state.prayerLocation){
        showToast('আগে নামাজের সময়ের অপশন থেকে লোকেশন সেট করুন');
        notifyChk.checked = false;
        return;
      }
      const ok = await enablePrayerPush();
      if(!ok){
        showToast('বিজ্ঞপ্তি চালু করা যায়নি, আবার চেষ্টা করুন');
        notifyChk.checked = false;
        return;
      }
      markPrayerNotifyEverEnabled();
    } else {
      disablePrayerPush();
    }
    state.prayerNotify = notifyChk.checked;
    savePrayerNotify();
  };

  // Compare-translations picker (up to 3 side-by-side)
  const cmpBtn = document.getElementById('settingsCompareTrBtn');
  if(cmpBtn){
    syncCompareTrLabel();
    cmpBtn.onclick = openTranslationsComparePicker;
  }

  // Approximate tajweed color highlighting
  const twChk = document.getElementById('settingsTajweedMode');
  if(twChk){
    twChk.checked = !!state.tajweedMode;
    twChk.onchange = () => {
      state.tajweedMode = twChk.checked;
      saveTajweedMode();
      if(state.tajweedMode) markTajweedUsed();
      reopenCurrentReaderView();
    };
  }
}
function openSettingsModal(){
  openModal('settingsModal');
  if(typeof onbMaybeStart === 'function') onbMaybeStart('settings');
}

// ================= Compare translations (up to 3 side-by-side) =================
function syncCompareTrLabel(){
  const label = document.getElementById('settingsCompareTrLabel');
  if(!label) return;
  label.textContent = state.translationEditions.length ? `${toBn(state.translationEditions.length)}টি নির্বাচিত` : 'বন্ধ';
}

async function openTranslationsComparePicker(){
  const editions = await loadTranslationEditions();
  let modal = document.getElementById('compareTrModal');
  if(!modal){
    modal = document.createElement('div');
    modal.className = 'app-modal';
    modal.id = 'compareTrModal';
    modal.innerHTML = `
      <div class="app-modal-box">
        <div class="app-modal-head">
          <h3><i class="fa-solid fa-layer-group"></i> <span>তুলনামূলক অনুবাদ</span></h3>
          <button class="app-modal-close" id="compareTrClose">✕</button>
        </div>
        <div class="app-modal-body">
          <input type="text" id="compareTrSearch" class="input-box-field" placeholder="ভাষা বা অনুবাদক খুঁজুন..." style="margin-bottom:10px;">
          <div class="compare-tr-hint" id="compareTrHint"></div>
          <div id="compareTrList" class="lang-picker-list compare-tr-list"></div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    wireModalBackdrop('compareTrModal');
    document.getElementById('compareTrClose').onclick = () => closeModal('compareTrModal');
  }
  const listEl = document.getElementById('compareTrList');
  const hintEl = document.getElementById('compareTrHint');
  const defaultHint = 'সর্বোচ্চ ৩টি অনুবাদ একসাথে বেছে নিন — পাশাপাশি দেখাবে। কোনোটি না বাছলে প্রধান অনুবাদই দেখাবে।';
  const updateHint = () => {
    hintEl.textContent = state.translationEditions.length
      ? `${toBn(state.translationEditions.length)}/৩ নির্বাচিত — পরিবর্তন সাথে সাথে প্রয়োগ হবে`
      : defaultHint;
  };
  const render = (filter) => {
    const q = (filter || '').trim().toLowerCase();
    const items = editions
      .map(e => ({ id: e.identifier, label: e.language ? `${e.name || e.englishName} — ${languageDisplayName(e.language)}` : (e.name || e.englishName) }))
      .filter(it => !q || it.label.toLowerCase().includes(q))
      .sort((a,b) => a.label.localeCompare(b.label));
    listEl.innerHTML = items.length ? items.map(it => `
      <label class="compare-tr-item${state.translationEditions.includes(it.id) ? ' active' : ''}">
        <input type="checkbox" data-id="${it.id}" ${state.translationEditions.includes(it.id) ? 'checked' : ''}>
        <span class="lp-label">${it.label}</span>
      </label>`).join('') : `<div class="lang-picker-empty">—</div>`;
    listEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.onchange = () => {
        const id = cb.getAttribute('data-id');
        if(cb.checked){
          if(state.translationEditions.length >= 3){
            cb.checked = false;
            showToast('সর্বোচ্চ ৩টি অনুবাদ বেছে নেওয়া যাবে');
            return;
          }
          state.translationEditions = state.translationEditions.concat([id]);
        } else {
          state.translationEditions = state.translationEditions.filter(s => s !== id);
        }
        if(state.translationEditions.length >= 2) markCompareUsed();
        cb.closest('.compare-tr-item').classList.toggle('active', cb.checked);
        saveTranslationEditionsSelected();
        syncCompareTrLabel();
        updateHint();
        reopenCurrentReaderView();
      };
    });
  };
  updateHint();
  render('');
  document.getElementById('compareTrSearch').oninput = (e) => render(e.target.value);
  openModal('compareTrModal');
}

// ================= Prayer times modal =================
const PRAYER_ORDER = [
  { key: 'Fajr',    label: 'ফজর',     icon: 'fa-solid fa-cloud-sun' },
  { key: 'Sunrise', label: 'সূর্যোদয়', icon: 'fa-solid fa-sun', informational: true },
  { key: 'Dhuhr',   label: 'যোহর',    icon: 'fa-solid fa-sun' },
  { key: 'Asr',     label: 'আসর',     icon: 'fa-solid fa-cloud-sun' },
  { key: 'Maghrib', label: 'মাগরিব',  icon: 'fa-solid fa-cloud-moon' },
  { key: 'Isha',    label: 'ইশা',     icon: 'fa-solid fa-moon' }
];
let prayerTickHandle = null;

function initPrayerModal(){
  wireModalBackdrop('prayerModal');
  document.getElementById('prayerClose').onclick = () => closeModal('prayerModal');
}
function openPrayerModal(){
  openModal('prayerModal');
  if(typeof onbMaybeStart === 'function') onbMaybeStart('prayer');
  if(state.prayerLocation){
    fetchPrayerTimes(state.prayerLocation);
  } else {
    locatePrayerTimes();
  }
}
function locatePrayerTimes(){
  const body = document.getElementById('prayerBody');
  body.innerHTML = `<div class="prayer-status"><i class="fa-solid fa-location-crosshairs"></i> ${I18N[state.language].prayer_locating}</div>`;
  if(!('geolocation' in navigator)){
    renderManualLocationForm('এই ব্রাউজারে অবস্থান শনাক্তকরণ সমর্থিত নয়।');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const loc = { lat: pos.coords.latitude, lon: pos.coords.longitude, label: null };
      state.prayerLocation = loc;
      savePrayerLocation();
      updatePushLocationIfSubscribed();
      fetchPrayerTimes(loc);
    },
    () => renderManualLocationForm('অবস্থানের অনুমতি পাওয়া যায়নি। শহরের নাম লিখে খুঁজুন।'),
    { timeout: 10000 }
  );
}
function renderManualLocationForm(message){
  const body = document.getElementById('prayerBody');
  body.innerHTML = `
    ${message ? `<div class="prayer-error">${message}</div>` : ''}
    <div class="prayer-manual-row">
      <input type="text" id="prayerCityInput" placeholder="শহর, দেশ (যেমন Dhaka, Bangladesh)">
      <button id="prayerCityGo" data-i18n="prayer_manual_go">খুঁজুন</button>
    </div>`;
  document.getElementById('prayerCityGo').onclick = () => {
    const raw = document.getElementById('prayerCityInput').value.trim();
    if(!raw) return;
    const parts = raw.split(',').map(s => s.trim());
    const city = parts[0];
    const country = parts[1] || '';
    fetchPrayerTimesByCity(city, country);
  };
}
async function fetchPrayerTimes(loc){
  const body = document.getElementById('prayerBody');
  body.innerHTML = `<div class="prayer-status"><i class="fa-solid fa-spinner fa-spin"></i> ${I18N[state.language].prayer_locating}</div>`;
  try{
    const url = `${PRAYER_API}/timings?latitude=${loc.lat}&longitude=${loc.lon}&method=${state.prayerMethod}`;
    const res = await fetch(url);
    const json = await res.json();
    if(!json || !json.data) throw new Error('bad response');
    cachePrayerData(json.data, loc);
    renderPrayerTimes(json.data, loc.label || null);
  }catch(e){
    const cached = readPrayerCache();
    if(cached){
      renderPrayerTimes(cached.data, cached.label, true);
    } else {
      renderManualLocationForm('সময়সূচি আনা যায়নি। ইন্টারনেট সংযোগ পরীক্ষা করুন।');
    }
  }
}
async function fetchPrayerTimesByCity(city, country){
  const body = document.getElementById('prayerBody');
  body.innerHTML = `<div class="prayer-status"><i class="fa-solid fa-spinner fa-spin"></i> ${I18N[state.language].prayer_locating}</div>`;
  try{
    const url = `${PRAYER_API}/timingsByCity?city=${encodeURIComponent(city)}&country=${encodeURIComponent(country)}&method=${state.prayerMethod}`;
    const res = await fetch(url);
    const json = await res.json();
    if(!json || !json.data) throw new Error('bad response');
    const label = country ? `${city}, ${country}` : city;
    const loc = { lat: json.data.meta.latitude, lon: json.data.meta.longitude, label };
    state.prayerLocation = loc;
    savePrayerLocation();
    updatePushLocationIfSubscribed();
    cachePrayerData(json.data, loc);
    renderPrayerTimes(json.data, label);
  }catch(e){
    body.innerHTML = `<div class="prayer-error">শহরটি খুঁজে পাওয়া যায়নি। নাম সঠিকভাবে লিখুন (যেমন: Dhaka, Bangladesh)।</div>`;
    renderManualLocationForm();
  }
}
function cachePrayerData(data, loc){
  try{
    IDBKV.set('qr_prayer_cache', JSON.stringify({
      data, label: loc.label || null, date: new Date().toDateString()
    }));
  }catch(e){}
}
function readPrayerCache(){
  try{
    const raw = IDBKV.get('qr_prayer_cache');
    return raw ? JSON.parse(raw) : null;
  }catch(e){ return null; }
}
function renderPrayerTimes(data, locationLabel, isOffline){
  const timings = data.timings;
  state.lastPrayerTimings = timings;
  const body = document.getElementById('prayerBody');
  const locHtml = `<div class="prayer-location"><i class="fa-solid fa-location-dot"></i> ${locationLabel ? locationLabel : (data.meta ? data.meta.timezone : '')}${isOffline ? ' · অফলাইন (সর্বশেষ সংরক্ষিত)' : ''}</div>`;
  const grid = PRAYER_ORDER.map(p => `
    <div class="prayer-card" data-key="${p.key}">
      <div class="prayer-card-ic"><i class="${p.icon}"></i></div>
      <div class="prayer-card-name">${p.label}</div>
      <div class="prayer-card-time">${toBn(to12h(timings[p.key]))}</div>
    </div>`).join('');
  body.innerHTML = `
    ${locHtml}
    <div class="prayer-next-card" id="prayerNextCard"></div>
    <div class="prayer-grid">${grid}</div>
    <div class="prayer-manual-row">
      <input type="text" id="prayerCityInput" placeholder="শহর পরিবর্তন করুন (যেমন Dhaka, Bangladesh)">
      <button id="prayerCityGo" data-i18n="prayer_manual_go">খুঁজুন</button>
    </div>`;
  document.getElementById('prayerCityGo').onclick = () => {
    const raw = document.getElementById('prayerCityInput').value.trim();
    if(!raw) return;
    const parts = raw.split(',').map(s => s.trim());
    fetchPrayerTimesByCity(parts[0], parts[1] || '');
  };
  startPrayerTicker(timings);
}
// Converts an "HH:MM" (24h) string to Bengali-digit 12-hour display, e.g. "05:21" -> "৫:২১ AM"
function to12h(hhmm){
  if(!hhmm) return '--:--';
  const [hStr, mStr] = hhmm.split(' ')[0].split(':');
  let h = parseInt(hStr, 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if(h === 0) h = 12;
  return `${h}:${mStr} ${ampm}`;
}
// Real-time ticking: highlights the current/next prayer and counts down to it
// second by second, purely from the device clock — no extra network calls.
function startPrayerTicker(timings){
  stopPrayerTicker();
  const tick = () => {
    const now = new Date();
    const todays = PRAYER_ORDER.filter(p => !p.informational).map(p => {
      const [h, m] = timings[p.key].split(' ')[0].split(':').map(Number);
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
      return { key: p.key, label: p.label, time: d };
    });
    let next = todays.find(p => p.time > now);
    let current = null;
    if(!next){
      // Past Isha: next prayer is tomorrow's Fajr.
      next = { ...todays[0], time: new Date(todays[0].time.getTime() + 86400000) };
      current = todays[todays.length - 1];
    } else {
      const idx = todays.findIndex(p => p.key === next.key);
      current = idx > 0 ? todays[idx - 1] : todays[todays.length - 1];
    }
    document.querySelectorAll('.prayer-card').forEach(card => {
      card.classList.toggle('current', current && card.getAttribute('data-key') === current.key);
    });
    const diffMs = next.time - now;
    const totalSec = Math.max(0, Math.floor(diffMs / 1000));
    const hh = Math.floor(totalSec / 3600);
    const mm = Math.floor((totalSec % 3600) / 60);
    const ss = totalSec % 60;
    const card = document.getElementById('prayerNextCard');
    if(card){
      card.innerHTML = `
        <div class="prayer-next-label">${I18N[state.language].prayer_next}</div>
        <div class="prayer-next-name">${next.label}</div>
        <div class="prayer-next-countdown">${toBn(String(hh).padStart(2,'0'))}:${toBn(String(mm).padStart(2,'0'))}:${toBn(String(ss).padStart(2,'0'))} বাকি</div>`;
    }
  };
  tick();
  prayerTickHandle = setInterval(tick, 1000);
}
function stopPrayerTicker(){
  if(prayerTickHandle){ clearInterval(prayerTickHandle); prayerTickHandle = null; }
}
// ================= Dictionary modal =================
function initDictionaryModal(){
  wireModalBackdrop('dictionaryModal');
  document.getElementById('dictClose').onclick = () => closeModal('dictionaryModal');
  document.getElementById('dictSearchInput').oninput = (e) => renderDictList(e.target.value);
}
function openDictionaryModal(){
  document.getElementById('dictSearchInput').value = '';
  renderDictList('');
  openModal('dictionaryModal');
  if(typeof onbMaybeStart === 'function') onbMaybeStart('dictionary');
}
function renderDictList(query){
  const list = document.getElementById('dictList');
  const q = query.trim().toLowerCase();
  const items = q
    ? DICTIONARY_DATA.filter(d => d.term.toLowerCase().includes(q) || d.meaning.toLowerCase().includes(q))
    : DICTIONARY_DATA;
  if(!items.length){
    list.innerHTML = `<div class="dict-empty">কোনো শব্দ পাওয়া যায়নি।</div>`;
    return;
  }
  list.innerHTML = items.map(d => `
    <div class="dict-item">
      <div class="dict-term">${d.term}</div>
      <div class="dict-meaning">${d.meaning}</div>
    </div>`).join('');
}

// ================= Share =================
async function shareApp(){
  const shareData = {
    title: document.title,
    text: 'কুরআন বাংলা — আরবি টেক্সট, বাংলা অনুবাদ ও তিলাওয়াতসহ, সম্পূর্ণ অফলাইনে ব্যবহারযোগ্য।',
    url: location.href
  };
  if(navigator.share){
    try{ await navigator.share(shareData); }catch(e){ /* user cancelled, ignore */ }
    return;
  }
  try{
    await navigator.clipboard.writeText(shareData.url);
    showToast('লিংক কপি করা হয়েছে');
  }catch(e){
    showToast(shareData.url);
  }
}

// ================= Help & Support modal =================
const FAQ_ITEMS = [
  { q: 'ইন্টারনেট ছাড়া কি অ্যাপটি ব্যবহার করা যাবে?', a: 'হ্যাঁ। একবার একটি সূরা খোলা বা শোনা হলে সেটি অফলাইনেও পড়া/শোনা যাবে। "লাইব্রেরি" ট্যাবের "Offline" অংশ থেকে যেকোনো সূরা আগে থেকেই ডাউনলোড করে রাখা যায়।' },
  { q: 'কীভাবে কোনো আয়াত সংরক্ষণ (Bookmark) করবো?', a: 'কোনো আয়াত পড়ার সময় "☆ সংরক্ষণ করুন" বাটনে চাপুন। এটি "লাইব্রেরি" ট্যাবে পাওয়া যাবে।' },
  { q: 'ক্বারী (তিলাওয়াতকারী) কীভাবে পরিবর্তন করবো?', a: 'প্লেয়ার বারে বা সেটিংসে "ডিফল্ট ক্বারী"-তে ট্যাপ করলে ছবিসহ সার্চযোগ্য তালিকা খুলবে — সেখান থেকে পছন্দের ক্বারী বেছে নিন।' },
  { q: 'হাফেজ মোড কী এবং কীভাবে ব্যবহার করবো?', a: 'কোনো সূরা/পৃষ্ঠা খুলে টুলবারে "হাফেজ মোড" চাপুন — অনুবাদ লুকিয়ে শুধু আরবি টেক্সট মুসহাফের মতো একটানা দেখাবে। এরপর "মুখস্থ যাচাই" চালু করলে আয়াতগুলো ঝাপসা হয়ে যাবে, নির্দিষ্ট আয়াত দেখতে তাতে ট্যাপ করুন।' },
  { q: 'অ্যাপটি মোবাইলে ইনস্টল করা যাবে কি?', a: 'হ্যাঁ, ব্রাউজারে "⬇ install app" বাটনে চাপ দিয়ে হোম স্ক্রিনে অ্যাপ আকারে যোগ করা যাবে।' },
  { q: 'সালাতের সময়সূচি সঠিক মনে না হলে কী করবো?', a: 'সেটিংস থেকে "নামাজের সময় হিসাবের পদ্ধতি" পরিবর্তন করে দেখুন — বিভিন্ন অঞ্চলে ভিন্ন হিসাব পদ্ধতি ব্যবহৃত হয়।' }
];
function initHelpModal(){
  wireModalBackdrop('helpModal');
  document.getElementById('helpClose').onclick = () => closeModal('helpModal');
}
function openHelpModal(){
  const body = document.getElementById('helpBody');
  body.innerHTML = `
    <div class="help-section">
      <div class="help-section-title">প্রায়শই জিজ্ঞাসিত প্রশ্ন</div>
      ${FAQ_ITEMS.map((f, i) => `
        <div class="help-faq" data-idx="${i}">
          <div class="help-faq-q">${f.q} <i class="fa-solid fa-chevron-down"></i></div>
          <div class="help-faq-a">${f.a}</div>
        </div>`).join('')}
    </div>
    <div class="help-section">
      <div class="help-section-title">যোগাযোগ করুন</div>
      <div class="help-contact-row">
        <a class="help-contact-btn" href="${SOCIAL_LINKS.website}" target="_blank" rel="noopener"><i class="fa-solid fa-globe"></i> ওয়েবসাইট</a>
        <a class="help-contact-btn" href="${SOCIAL_LINKS.facebook}" target="_blank" rel="noopener"><i class="fa-brands fa-facebook"></i> ফেসবুক</a>
        <a class="help-contact-btn" href="${SOCIAL_LINKS.youtube}" target="_blank" rel="noopener"><i class="fa-brands fa-youtube"></i> ইউটিউব</a>
      </div>
    </div>`;
  body.querySelectorAll('.help-faq').forEach(el => {
    el.querySelector('.help-faq-q').onclick = () => el.classList.toggle('open');
  });
  openModal('helpModal');
}

// ================= Social links (drawer footer) =================
function initSocialLinks(){
  const w = document.getElementById('socialWebsite');
  const f = document.getElementById('socialFacebook');
  const y = document.getElementById('socialYoutube');
  if(w) w.href = SOCIAL_LINKS.website;
  if(f) f.href = SOCIAL_LINKS.facebook;
  if(y) y.href = SOCIAL_LINKS.youtube;
}

// ================= Init everything in this file =================
function initMenu(){
  initLanguage();
  initSettingsModal();
  initPrayerModal();
  initQiblaModal();
  initDictionaryModal();
  initHelpModal();
  if(typeof initTranslationHelpModal === 'function') initTranslationHelpModal();
  initSocialLinks();
}
