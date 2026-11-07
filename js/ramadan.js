// ---------- Ramadan mode + Taraweeh tracker ----------
// Ramadan mode is a visual decoration layer (a data-ramadan="on" attribute
// on <body>, styled in css/ramadan.css) that dresses the whole app up for the
// month: a twinkling starfield, a shimmering purple/gold header & bottom
// nav, a "রমজান মুবারক" banner on Home, and a gold glow on key cards — plus
// it surfaces the Taraweeh tracker. The tracker itself works year-round
// though — no need to gate it strictly to the month of Ramadan, since users
// may want to log Qiyam/Tarawih any time.

function applyRamadanVisual(){
  document.body.setAttribute('data-ramadan', state.ramadanMode ? 'on' : 'off');
}

function initRamadanToggle(){
  const chk = document.getElementById('settingsRamadanMode');
  if(!chk) return;
  chk.checked = state.ramadanMode;
  applyRamadanVisual();
  chk.onchange = () => {
    state.ramadanMode = chk.checked;
    // a manual tap always wins over the auto-detector from here on, until
    // the hijri month itself changes again (see checkAutoRamadanMode)
    state.ramadanAutoSet = false;
    saveRamadanMode();
    saveRamadanAutoState();
    if(state.ramadanMode) markRamadanModeUsed();
    applyRamadanVisual();
    showToast(state.ramadanMode ? '🌙 রমজান মোড চালু হয়েছে' : 'রমজান মোড বন্ধ করা হয়েছে');
  };
}

// ---------- Auto Ramadan detection (hijri calendar) ----------
// Turns Ramadan mode on by itself once the hijri month rolls over to
// Ramadan (month 9), and back off once it rolls into Shawwal (month 10) —
// but only for changes THIS function made; a manual toggle in settings
// always takes precedence until the hijri month itself changes again.
function todayLocalDateStr(d = new Date()){
  const y = d.getFullYear(), m = String(d.getMonth()+1).padStart(2,'0'), day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

async function fetchTodayHijriMonth(){
  const d = new Date();
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const yyyy = d.getFullYear();
  const res = await fetch(`${PRAYER_API}/gToH/${dd}-${mm}-${yyyy}`);
  if(!res.ok) throw new Error('hijri lookup failed');
  const json = await res.json();
  const month = json?.data?.hijri?.month?.number;
  if(!Number.isInteger(month)) throw new Error('unexpected hijri response');
  return month;
}

function syncRamadanCheckbox(){
  const chk = document.getElementById('settingsRamadanMode');
  if(chk) chk.checked = state.ramadanMode;
}

async function checkAutoRamadanMode(){
  const today = todayLocalDateStr();
  if(state.ramadanLastCheck === today) return; // already checked once today

  let hijriMonth;
  try{
    hijriMonth = await fetchTodayHijriMonth();
  }catch(e){
    return; // offline or API hiccup — just try again next app open, don't touch ramadanMode
  }

  state.ramadanLastCheck = today;
  state.ramadanLastHijriMonth = hijriMonth;
  saveRamadanAutoState();

  const isRamadan = hijriMonth === 9;

  if(isRamadan && !state.ramadanMode){
    state.ramadanMode = true;
    state.ramadanAutoSet = true;
    saveRamadanMode();
    saveRamadanAutoState();
    markRamadanModeUsed();
    applyRamadanVisual();
    syncRamadanCheckbox();
    showToast('🌙 রমজান শুরু হয়েছে — রমজান মোড অটোমেটিক চালু হয়ে গেছে');
  } else if(!isRamadan && state.ramadanMode && state.ramadanAutoSet){
    // only auto-switch it back off if the app itself turned it on;
    // a mode the user turned on by hand is left alone
    state.ramadanMode = false;
    state.ramadanAutoSet = false;
    saveRamadanMode();
    saveRamadanAutoState();
    applyRamadanVisual();
    syncRamadanCheckbox();
    showToast('রমজান শেষ হয়েছে — রমজান মোড অটোমেটিক বন্ধ হয়ে গেছে');
  }
}

// ---------- Taraweeh tracker modal ----------
function initTaraweehModal(){
  wireModalBackdrop('taraweehModal');
  document.getElementById('taraweehClose').onclick = () => closeModal('taraweehModal');
}

function openTaraweehModal(){
  renderTaraweehBody();
  openModal('taraweehModal');
  if(typeof onbMaybeStart === 'function') onbMaybeStart('taraweeh');
}

function taraweehCompletedCount(){
  const goal = state.taraweeh.goal || RAMADAN_DEFAULT_RAKAT_GOAL;
  return Object.values(state.taraweeh.days).filter(r => r >= goal).length;
}

function renderTaraweehBody(){
  const body = document.getElementById('taraweehBody');
  const goal = state.taraweeh.goal || RAMADAN_DEFAULT_RAKAT_GOAL;
  const completedNights = taraweehCompletedCount();

  let grid = '';
  for(let day = 1; day <= 30; day++){
    const rakats = state.taraweeh.days[day] || 0;
    const done = rakats >= goal;
    grid += `<div class="tw-day${done ? ' done' : (rakats>0 ? ' partial' : '')}" data-day="${day}">
      <div class="tw-day-num">${toBn(day)}</div>
      <div class="tw-day-rakat">${toBn(rakats)}/${toBn(goal)}</div>
    </div>`;
  }

  body.innerHTML = `
    <div class="tw-summary">
      <div class="tw-summary-big">${toBn(completedNights)}<span>/৩০</span></div>
      <div class="tw-summary-label">রাত সম্পন্ন হয়েছে</div>
    </div>
    <div class="tw-goal-row">
      <span>প্রতি রাতের রাকাত লক্ষ্য</span>
      <div class="tw-goal-controls">
        <button id="twGoalDec">−</button>
        <span id="twGoalVal">${toBn(goal)}</span>
        <button id="twGoalInc">+</button>
      </div>
    </div>
    <div class="tw-edit-panel" id="twEditPanel" style="display:none;"></div>
    <div class="tw-grid" id="twGrid">${grid}</div>
    <div class="tw-hint">প্রতিটি রাতের ঘরে চাপ দিয়ে সে রাতের সম্পন্ন করা রাকাত সংখ্যা বসান।</div>
  `;

  document.getElementById('twGoalDec').onclick = () => {
    state.taraweeh.goal = Math.max(2, (state.taraweeh.goal || RAMADAN_DEFAULT_RAKAT_GOAL) - 2);
    saveTaraweeh();
    renderTaraweehBody();
  };
  document.getElementById('twGoalInc').onclick = () => {
    state.taraweeh.goal = Math.min(40, (state.taraweeh.goal || RAMADAN_DEFAULT_RAKAT_GOAL) + 2);
    saveTaraweeh();
    renderTaraweehBody();
  };

  body.querySelectorAll('.tw-day').forEach(el => {
    el.onclick = () => {
      const day = parseInt(el.getAttribute('data-day'), 10);
      body.querySelectorAll('.tw-day').forEach(d => d.classList.toggle('editing', d === el));
      openTaraweehEditPanel(day);
    };
  });
}

// A small in-app "box" for entering a night's rakat count — replaces the
// browser's plain window.prompt() dialog (which shows the raw site address)
// with a properly styled stepper that matches the rest of the app.
function openTaraweehEditPanel(day){
  const panel = document.getElementById('twEditPanel');
  if(!panel) return;
  const goal = state.taraweeh.goal || RAMADAN_DEFAULT_RAKAT_GOAL;
  let value = state.taraweeh.days[day] || 0;

  const draw = () => {
    panel.innerHTML = `
      <div class="tw-edit-head">রাত ${toBn(day)} — সম্পন্ন রাকাত</div>
      <div class="tw-edit-stepper">
        <button class="tw-step-btn" id="twStepDec">−</button>
        <span class="tw-edit-value">${toBn(value)}</span>
        <button class="tw-step-btn" id="twStepInc">+</button>
      </div>
      <div class="tw-edit-quick">
        ${[0, Math.round(goal/2), goal].filter((v,i,arr)=>arr.indexOf(v)===i).map(v =>
          `<button class="tw-quick-btn${v===value?' active':''}" data-v="${v}">${toBn(v)}</button>`).join('')}
      </div>
      <div class="tw-edit-actions">
        <button class="tw-cancel-btn" id="twEditCancel">বাতিল</button>
        <button class="tw-save-btn" id="twEditSave">সংরক্ষণ করুন</button>
      </div>`;
    panel.querySelector('#twStepDec').onclick = () => { value = Math.max(0, value-1); draw(); };
    panel.querySelector('#twStepInc').onclick = () => { value = Math.min(goal, value+1); draw(); };
    panel.querySelectorAll('.tw-quick-btn').forEach(b => {
      b.onclick = () => { value = parseInt(b.getAttribute('data-v'),10); draw(); };
    });
    panel.querySelector('#twEditCancel').onclick = () => closeTaraweehEditPanel();
    panel.querySelector('#twEditSave').onclick = () => {
      setTaraweehDay(day, value);
      closeTaraweehEditPanel();
      renderTaraweehBody();
    };
  };
  draw();
  panel.style.display = 'block';
  panel.scrollIntoView({behavior:'smooth', block:'nearest'});
}
function closeTaraweehEditPanel(){
  const panel = document.getElementById('twEditPanel');
  if(panel){ panel.style.display = 'none'; panel.innerHTML = ''; }
  document.querySelectorAll('.tw-day.editing').forEach(d => d.classList.remove('editing'));
}

function initRamadan(){
  initRamadanToggle();
  initTaraweehModal();
  const bannerBtn = document.getElementById('ramadanBannerBtn');
  if(bannerBtn) bannerBtn.onclick = openTaraweehModal;
  // fire-and-forget: runs in the background, flips the mode on/off (and
  // updates the UI) once the network call resolves, without blocking init
  checkAutoRamadanMode();
}
