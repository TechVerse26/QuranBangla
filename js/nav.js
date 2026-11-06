// ---------- Bottom navigation: switches between the top-level views ----------
const VIEW_IDS = ['home','planner','topics','library','stats','hadith','exam','profile'];

function goToView(view){
  VIEW_IDS.forEach(v => {
    document.getElementById('view-' + v).classList.toggle('active', v === view);
  });
  document.querySelectorAll('.bn-item').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-view') === view);
  });
  // Lazily render each section's content the first time it's opened, and
  // refresh sections whose data can change between visits (stats/library).
  if(view === 'home' && homeLanding.style.display === 'none' && readerArea.style.display === 'none'){
    showHomeLanding();
  }
  if(view === 'planner') renderPlannerView();
  if(view === 'topics') renderTopicsList();
  if(view === 'library') renderActiveLibraryTab();
  if(view === 'stats') renderStatsView();
  if(view === 'hadith') showHadithBooksView();
  if(view === 'exam' && typeof onExamViewOpened === 'function') onExamViewOpened();
  if(view === 'profile' && typeof renderProfileView === 'function') renderProfileView();
  window.scrollTo(0,0);
  if(view !== 'home' && typeof onbMaybeStart === 'function') onbMaybeStart(view);
}

function initBottomNav(){
  document.querySelectorAll('.bn-item').forEach(btn => {
    btn.onclick = () => goToView(btn.getAttribute('data-view'));
  });
}

// ---------- Home: sub-tabs (Surah / Page / Para / Hizb / Ruku) ----------
function initHomeSubtabs(){
  const homeListContainer = document.getElementById('homeListContainer');
  document.querySelectorAll('#homeSubtabs button').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('#homeSubtabs button').forEach(b => b.classList.toggle('active', b === btn));
      const mode = btn.getAttribute('data-mode');
      state.mode = mode;
      homeListContainer.innerHTML = `<div class="loader"><div class="spinner"></div><span>Loading...</span></div>`;
      if(mode === 'surah') renderSurahList(homeListContainer);
      else if(mode === 'page') renderPageList(homeListContainer);
      else if(mode === 'juz') renderJuzList(homeListContainer);
      else if(mode === 'hizb') renderHizbList(homeListContainer);
      else if(mode === 'ruku') renderRukuList(homeListContainer);
    };
  });
}

// ---------- Library: sub-tabs (Reserved / Notes / History / Offline) ----------
function renderActiveLibraryTab(){
  const container = document.getElementById('libraryListContainer');
  if(document.getElementById('libTabBookmarks').classList.contains('active')) renderBookmarksList(container);
  else if(document.getElementById('libTabNotes').classList.contains('active')) renderNotesList(container);
  else if(document.getElementById('libTabHistory').classList.contains('active')) renderHistoryList(container);
  else renderOfflineList(container);
}

function initLibraryTabs(){
  const container = document.getElementById('libraryListContainer');
  const tabs = ['libTabBookmarks','libTabNotes','libTabHistory','libTabOffline'];
  document.getElementById('libTabBookmarks').onclick = () => {
    tabs.forEach(id => document.getElementById(id).classList.toggle('active', id === 'libTabBookmarks'));
    renderBookmarksList(container);
  };
  document.getElementById('libTabNotes').onclick = () => {
    tabs.forEach(id => document.getElementById(id).classList.toggle('active', id === 'libTabNotes'));
    renderNotesList(container);
  };
  document.getElementById('libTabHistory').onclick = () => {
    tabs.forEach(id => document.getElementById(id).classList.toggle('active', id === 'libTabHistory'));
    renderHistoryList(container);
  };
  document.getElementById('libTabOffline').onclick = () => {
    tabs.forEach(id => document.getElementById(id).classList.toggle('active', id === 'libTabOffline'));
    renderOfflineList(container);
  };
}

// ---------- Hamburger "more" drawer ----------
function initMoreDrawer(){
  const drawer = document.getElementById('moreDrawer');
  const scrim = document.getElementById('scrim');
  const open = () => {
    drawer.classList.add('open'); scrim.style.display = 'block';
    if(typeof onbMaybeStart === 'function') onbMaybeStart('drawer');
  };
  const close = () => { drawer.classList.remove('open'); scrim.style.display = 'none'; };
  document.getElementById('menuBtn').onclick = open;
  scrim.onclick = close;

  document.getElementById('drawerGoToAyah').onclick = () => {
    close();
    showInputBox({
      title: 'নির্দিষ্ট আয়াতে যান',
      placeholder: 'যেমন 2:255',
      confirmLabel: 'যান',
      onConfirm: (ref) => {
        const [s,a] = ref.split(':').map(n => parseInt(n,10));
        if(Number.isInteger(s) && s>=1 && s<=114) openSurahAndScrollTo(s, Number.isInteger(a) ? a : 1);
        else showToast('সঠিক ফরম্যাটে লিখুন, যেমন 2:255');
      }
    });
  };

  // Live-backed drawer items (implemented in js/menu.js).
  document.getElementById('drawerAiTafsir').onclick = () => { close(); openAiTafsirModal(null); };
  document.getElementById('drawerPrayerTimes').onclick = () => { close(); openPrayerModal(); };
  document.getElementById('drawerQibla').onclick = () => { close(); openQiblaModal(); };
  document.getElementById('drawerTaraweeh').onclick = () => { close(); openTaraweehModal(); };
  document.getElementById('drawerDictionary').onclick = () => { close(); openDictionaryModal(); };
  document.getElementById('drawerExam').onclick = () => { close(); goToView('exam'); };
  document.getElementById('drawerDownloads').onclick = () => { close(); openDownloadManager(); };
  document.getElementById('drawerSettings').onclick = () => { close(); openSettingsModal(); };
  document.getElementById('drawerShare').onclick = () => { close(); shareApp(); };
  document.getElementById('drawerHelp').onclick = () => { close(); openHelpModal(); };
  document.getElementById('drawerTranslationHelp').onclick = () => { close(); openTranslationHelpModal(); };

  // The remaining drawer items don't have a backing feature yet in this
  // build — show a lightweight "coming soon" toast instead of a dead click.
  ['drawerOtherApps','drawerFeedback'].forEach(id => {
    const el = document.getElementById(id);
    if(el) el.onclick = () => { close(); showToast('শীঘ্রই আসছে'); };
  });

  // Live filter for the drawer's own search box.
  const drawerSearch = document.getElementById('drawerSearchInput');
  if(drawerSearch){
    drawerSearch.oninput = () => {
      const q = drawerSearch.value.trim().toLowerCase();
      document.querySelectorAll('.drawer-item').forEach(btn => {
        const label = btn.textContent.trim().toLowerCase();
        btn.style.display = (!q || label.includes(q)) ? '' : 'none';
      });
    };
  }
}

function showToast(msg){
  let toast = document.getElementById('appToast');
  if(!toast){
    toast = document.createElement('div');
    toast.id = 'appToast';
    toast.className = 'app-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('visible');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove('visible'), 2200);
}

function initNav(){
  initBottomNav();
  initHomeSubtabs();
  initLibraryTabs();
  initMoreDrawer();
  initReaderBack();
  if(typeof initHafezToolbar === 'function') initHafezToolbar();
}
