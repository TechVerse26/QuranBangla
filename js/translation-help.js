// ---------- Translation help modal ----------
// Lets a user pick any interface language and, for any UI text key, save
// their own custom wording. Custom entries are stored per-language in
// state.customTranslations (see js/storage.js) and are applied live on top
// of the built-in I18N dictionaries by applyLanguage() in js/menu.js — so a
// contributed translation actually changes the app immediately, not just in
// this modal. Nothing is sent anywhere automatically; the "কপি করুন" button
// lets a user copy their custom set as JSON to share with us for review.

let trHelpActiveLang = null;

function trHelpDict(){
  return I18N[state.language] || I18N.en;
}
function trHelpT(key){
  const dict = trHelpDict();
  return dict[key] !== undefined ? dict[key] : I18N.en[key];
}

function initTranslationHelpModal(){
  const modal = document.getElementById('translationHelpModal');
  if(!modal) return;
  wireModalBackdrop('translationHelpModal');
  document.getElementById('trHelpClose').onclick = () => closeModal('translationHelpModal');
  document.getElementById('trHelpBackBtn').onclick = trHelpShowLangStep;

  const searchInput = document.getElementById('trHelpSearch');
  if(searchInput){
    searchInput.oninput = () => trHelpRenderList(searchInput.value);
  }

  document.getElementById('trHelpExportBtn').onclick = trHelpExportCustom;
  document.getElementById('trHelpResetAllBtn').onclick = trHelpResetAllForLang;
}

function openTranslationHelpModal(){
  trHelpShowLangStep();
  openModal('translationHelpModal');
  if(typeof onbMaybeStart === 'function') onbMaybeStart('translationHelp');
}

function trHelpShowLangStep(){
  trHelpActiveLang = null;
  document.getElementById('trHelpLangStep').style.display = '';
  document.getElementById('trHelpEditorStep').style.display = 'none';
  document.getElementById('trHelpBackBtn').style.display = 'none';
  document.getElementById('trHelpTitleText').textContent = trHelpT('menu_translation_help');
  trHelpRenderLangList();
}

function trHelpRenderLangList(){
  const listEl = document.getElementById('trHelpLangList');
  if(!listEl) return;
  listEl.innerHTML = UI_LANG_META.map(m => {
    const count = Object.keys((state.customTranslations && state.customTranslations[m.code]) || {}).length;
    return `
      <button class="lang-picker-item" data-lang="${m.code}">
        <span class="lp-text">
          <span class="lp-label">${m.label}</span>
          ${count ? `<span class="lp-sub">${count}টি কাস্টম অনুবাদ</span>` : ''}
        </span>
        <i class="fa-solid fa-chevron-right settings-chevron"></i>
      </button>`;
  }).join('');
  listEl.querySelectorAll('.lang-picker-item').forEach(btn => {
    btn.onclick = () => trHelpOpenEditor(btn.getAttribute('data-lang'));
  });
}

function trHelpOpenEditor(lang){
  trHelpActiveLang = lang;
  document.getElementById('trHelpLangStep').style.display = 'none';
  document.getElementById('trHelpEditorStep').style.display = '';
  document.getElementById('trHelpBackBtn').style.display = 'flex';
  const meta = UI_LANG_META.find(m => m.code === lang);
  document.getElementById('trHelpTitleText').textContent = meta ? meta.label : lang;
  const searchInput = document.getElementById('trHelpSearch');
  if(searchInput) searchInput.value = '';
  trHelpRenderList('');
}

function trHelpRenderList(filter){
  const listEl = document.getElementById('trHelpList');
  if(!listEl || !trHelpActiveLang) return;
  const lang = trHelpActiveLang;
  const dict = I18N[lang] || {};
  const custom = (state.customTranslations && state.customTranslations[lang]) || {};
  const q = (filter || '').trim().toLowerCase();

  // I18N.en's key set is the canonical list of every translatable string
  // in the app, so every language — even ones missing a few keys — gets
  // a complete, consistent list to fill in.
  const keys = Object.keys(I18N.en).filter(key => {
    if(!q) return true;
    const ref = I18N.en[key] || '';
    const current = custom[key] || dict[key] || '';
    return key.toLowerCase().includes(q) || ref.toLowerCase().includes(q) || current.toLowerCase().includes(q);
  });

  if(!keys.length){
    listEl.innerHTML = `<div class="tr-help-empty">কিছু পাওয়া যায়নি</div>`;
    return;
  }

  listEl.innerHTML = keys.map(key => {
    const ref = I18N.en[key] || key;
    const hasCustom = custom[key] !== undefined && custom[key] !== '';
    const value = hasCustom ? custom[key] : (dict[key] !== undefined ? dict[key] : '');
    return `
      <div class="tr-help-row" data-key="${key}">
        <div class="tr-help-row-ref">${ref}${hasCustom ? '<span class="tr-help-custom-badge">কাস্টম</span>' : ''}</div>
        <div class="tr-help-row-input-wrap">
          <input type="text" class="tr-help-input" data-key="${key}" value="${value.replace(/"/g, '&quot;')}">
          <button class="tr-help-reset-btn" data-key="${key}" title="মূল অনুবাদে ফিরে যান" style="${hasCustom ? '' : 'display:none;'}">
            <i class="fa-solid fa-rotate-left"></i>
          </button>
        </div>
      </div>`;
  }).join('');

  listEl.querySelectorAll('.tr-help-input').forEach(input => {
    input.addEventListener('change', () => trHelpSaveKey(input.getAttribute('data-key'), input.value));
  });
  listEl.querySelectorAll('.tr-help-reset-btn').forEach(btn => {
    btn.onclick = () => trHelpResetKey(btn.getAttribute('data-key'));
  });
}

function trHelpSaveKey(key, value){
  const lang = trHelpActiveLang;
  if(!lang) return;
  const dict = I18N[lang] || {};
  const trimmed = value.trim();
  if(!state.customTranslations[lang]) state.customTranslations[lang] = {};
  // Saving back exactly what's already the built-in value isn't a "custom"
  // contribution — drop it so the row doesn't stay flagged as customized.
  if(!trimmed || trimmed === dict[key]){
    delete state.customTranslations[lang][key];
  } else {
    state.customTranslations[lang][key] = trimmed;
  }
  saveCustomTranslations();
  if(lang === state.language) applyLanguage(state.language);
  trHelpRenderList(document.getElementById('trHelpSearch').value);
}

function trHelpResetKey(key){
  const lang = trHelpActiveLang;
  if(!lang || !state.customTranslations[lang]) return;
  delete state.customTranslations[lang][key];
  saveCustomTranslations();
  if(lang === state.language) applyLanguage(state.language);
  trHelpRenderList(document.getElementById('trHelpSearch').value);
}

function trHelpResetAllForLang(){
  const lang = trHelpActiveLang;
  if(!lang) return;
  const count = Object.keys((state.customTranslations && state.customTranslations[lang]) || {}).length;
  if(!count){ showToast('কোনো কাস্টম অনুবাদ নেই'); return; }
  state.customTranslations[lang] = {};
  saveCustomTranslations();
  if(lang === state.language) applyLanguage(state.language);
  trHelpRenderList(document.getElementById('trHelpSearch').value);
  showToast('সব কাস্টম অনুবাদ রিসেট করা হয়েছে');
}

async function trHelpExportCustom(){
  const lang = trHelpActiveLang;
  if(!lang) return;
  const custom = (state.customTranslations && state.customTranslations[lang]) || {};
  if(!Object.keys(custom).length){
    showToast('কপি করার মতো কোনো কাস্টম অনুবাদ নেই');
    return;
  }
  const json = JSON.stringify({ lang, translations: custom }, null, 2);
  try{
    await navigator.clipboard.writeText(json);
    showToast('কপি করা হয়েছে — ফীডব্যাকে পাঠিয়ে দিন');
  }catch(e){
    const ta = document.createElement('textarea');
    ta.value = json;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try{ document.execCommand('copy'); showToast('কপি করা হয়েছে — ফীডব্যাকে পাঠিয়ে দিন'); }
    catch(e2){ showToast('কপি করা যায়নি'); }
    ta.remove();
  }
}
