// ---------- হাদিস (Hadith) — 6 major collections, Bengali translation ----------
// Data source: fawazahmed0/hadith-api (free, open, jsDelivr-hosted). Each book
// has a maintained Bengali edition ("ben-<book>", see HADITH_BOOKS in
// js/data.js). Everything fetched here is cached into IDBKV as plain JSON
// strings (same pattern as the rest of the app's offline storage) so a
// chapter you've already opened once still opens instantly, and works
// offline, without needing a separate "download manager" flow.
//
// Navigation is 3 levels, mirroring js/topics.js's list->detail pattern but
// one level deeper: Books -> Chapters (of one book) -> Hadiths (of one
// chapter). Tapping the bottom-nav "হাদিস" tab always resets back to the
// book list (same behaviour as the Topics tab).

const HADITH_STATE = {
  book: null,     // currently open book object from HADITH_BOOKS
  bookInfo: null, // slim {name, sections, section_details, last_hadithnumber} for that book
  section: null   // currently open section/chapter number (as a number)
};

// ---------- Fetch + cache helpers ----------
function hadithCacheKey(kind, a, b) {
  return 'hadith_' + kind + '_' + a + (b != null ? ('_' + b) : '');
}

async function fetchJsonCached(url, cacheKey) {
  const cached = IDBKV.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* fall through and refetch */ }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error('hadith-fetch-failed:' + url);
  const json = await res.json();
  try { IDBKV.set(cacheKey, JSON.stringify(json)); } catch (e) { /* offline storage full — still usable this session */ }
  return json;
}

// info.json bundles ALL books' chapter metadata in one (largeish) file. We
// fetch it once, then cache each book's own slim slice under its own key —
// so re-opening a specific book later never re-downloads the whole thing,
// and IndexedDB doesn't end up holding one giant blob per book.
async function getHadithBookInfo(bookId) {
  const slimKey = hadithCacheKey('info', bookId);
  const cachedSlim = IDBKV.get(slimKey);
  if (cachedSlim) {
    try { return JSON.parse(cachedSlim); } catch (e) { /* refetch below */ }
  }
  const all = await fetchJsonCached(HADITH_API_BASE + '/info.json', hadithCacheKey('info', 'all-raw'));
  Object.keys(all).forEach(bid => {
    const meta = all[bid] && all[bid].metadata;
    if (!meta) return;
    const slim = {
      name: meta.name,
      sections: meta.sections || {},
      section_details: meta.section_details || {},
      last_hadithnumber: meta.last_hadithnumber || 0
    };
    try { IDBKV.set(hadithCacheKey('info', bid), JSON.stringify(slim)); } catch (e) {}
  });
  // The raw combined file is large and only needed once to seed the slim
  // per-book entries above — drop it from storage right away.
  try { IDBKV.remove(hadithCacheKey('info', 'all-raw')); } catch (e) {}
  const nowCached = IDBKV.get(slimKey);
  return nowCached ? JSON.parse(nowCached) : null;
}

function getHadithSection(bookEdition, sectionNo) {
  const url = `${HADITH_API_BASE}/editions/${bookEdition}/sections/${sectionNo}.json`;
  return fetchJsonCached(url, hadithCacheKey('section', bookEdition, sectionNo));
}

// ---------- Grade badge helper ----------
// A hadith can carry grades from several scholars who don't always agree —
// show the most commonly cited one rather than listing every opinion inline.
const HADITH_GRADE_PRIORITY = ['Al-Albani', 'Zubair Ali Zai', 'Shuaib Al Arnaut', 'Muhammad Muhyi Al-Din Abdul Hamid'];
function pickHadithGrade(grades) {
  if (!Array.isArray(grades) || !grades.length) return null;
  for (const name of HADITH_GRADE_PRIORITY) {
    const g = grades.find(x => x.name === name);
    if (g) return g;
  }
  return grades[0];
}
function hadithGradeLabel(gradeText) {
  if (!gradeText) return '';
  if (HADITH_GRADE_BN[gradeText]) return HADITH_GRADE_BN[gradeText];
  // Composite grades like "Sahih Bukhari (142)" (cross-references, not a
  // grade word) — show as-is rather than guessing a translation.
  return gradeText;
}
function hadithGradeClass(gradeText) {
  if (!gradeText) return '';
  const t = gradeText.toLowerCase();
  if (t.startsWith('sahih') || t.startsWith('hasan sahih')) return 'hg-sahih';
  if (t.startsWith('hasan')) return 'hg-hasan';
  if (t.includes('daif') || t.includes("da'if")) return 'hg-daif';
  return 'hg-other';
}

// ---------- Screen 1: book list ----------
function renderHadithBooks() {
  const el = document.getElementById('hadithBooksContainer');
  el.innerHTML = '';
  HADITH_BOOKS.forEach(book => {
    const card = document.createElement('div');
    card.className = 'hadith-book-card';
    card.innerHTML = `
      <div class="hb-icon"><i class="fa-solid fa-book"></i></div>
      <div class="hb-text">
        <div class="hb-title">${book.nameBn}</div>
        <div class="hb-sub">${book.nameEn} · ${book.compilerBn}</div>
        <div class="hb-count">প্রায় ${toBn(book.total)}টি হাদিস</div>
      </div>
      <svg class="topic-chevron" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>`;
    card.onclick = () => openHadithBook(book.id);
    el.appendChild(card);
  });
}

function showHadithBooksView() {
  document.getElementById('hadithBooksContainer').style.display = 'block';
  document.getElementById('hadithChaptersContainer').style.display = 'none';
  document.getElementById('hadithListContainer').style.display = 'none';
  renderHadithBooks();
}

// ---------- Screen 2: chapter list (for one book) ----------
async function openHadithBook(bookId) {
  const book = HADITH_BOOKS.find(b => b.id === bookId);
  if (!book) return;
  HADITH_STATE.book = book;
  HADITH_STATE.bookInfo = null;

  document.getElementById('hadithBooksContainer').style.display = 'none';
  document.getElementById('hadithListContainer').style.display = 'none';
  const chaptersEl = document.getElementById('hadithChaptersContainer');
  chaptersEl.style.display = 'block';
  document.getElementById('hadithBookHead').innerHTML = `<h2 class="hadith-book-head-title">${book.nameBn}</h2><div class="topic-sub-en">${book.nameEn}</div>`;
  const listEl = document.getElementById('hadithChaptersList');
  listEl.innerHTML = `<div class="loader"><div class="spinner"></div><span>Loading...</span></div>`;

  try {
    const info = await getHadithBookInfo(bookId);
    HADITH_STATE.bookInfo = info;
    renderHadithChapters(info);
  } catch (e) {
    listEl.innerHTML = `<div class="hadith-error">অধ্যায় তালিকা লোড করা যায়নি — ইন্টারনেট সংযোগ পরীক্ষা করুন।</div>`;
  }
}

function renderHadithChapters(info) {
  const listEl = document.getElementById('hadithChaptersList');
  listEl.innerHTML = '';
  if (!info || !info.sections) return;
  const nums = Object.keys(info.sections)
    .filter(n => n !== '0' && info.sections[n] && String(info.sections[n]).trim() !== '')
    .map(n => parseInt(n, 10))
    .filter(n => Number.isInteger(n))
    .sort((a, b) => a - b);

  nums.forEach(n => {
    const title = info.sections[String(n)];
    const range = info.section_details && info.section_details[String(n)];
    const item = document.createElement('div');
    item.className = 'list-item hadith-chapter-item';
    item.innerHTML = `<div class="badge-num">${toBn(n)}</div>
      <div class="li-text">
        <div class="li-title">অধ্যায় ${toBn(n)}</div>
        <div class="li-sub hadith-chapter-title-en">${title}</div>
        ${range ? `<div class="hadith-chapter-range">হাদিস ${toBn(range.hadithnumber_first)}–${toBn(range.hadithnumber_last)}</div>` : ''}
      </div>`;
    item.onclick = () => openHadithChapter(n);
    listEl.appendChild(item);
  });

  if (!nums.length) {
    listEl.innerHTML = `<div class="hadith-error">এই বইয়ের অধ্যায় তথ্য এখনো পাওয়া যায়নি।</div>`;
  }
}

// "নির্দিষ্ট হাদিস নম্বর দিয়ে খুঁজুন" — resolves a hadith number to its
// section using the range data already loaded for this book, then jumps
// straight there and highlights it.
function openHadithNumberJump() {
  const info = HADITH_STATE.bookInfo;
  const book = HADITH_STATE.book;
  if (!info || !book) return;
  showInputBox({
    title: 'হাদিস নম্বর দিয়ে খুঁজুন',
    placeholder: `যেমন ১ থেকে ${book.total}`,
    confirmLabel: 'খুঁজুন',
    onConfirm: (raw) => {
      const num = parseInt(String(raw).trim(), 10);
      if (!Number.isInteger(num) || num < 1) { showToast('সঠিক হাদিস নম্বর লিখুন'); return; }
      const details = info.section_details || {};
      const match = Object.keys(details).find(secNo => {
        const r = details[secNo];
        return r && num >= r.hadithnumber_first && num <= r.hadithnumber_last;
      });
      if (!match) { showToast('এই নম্বরের হাদিস পাওয়া যায়নি'); return; }
      openHadithChapter(parseInt(match, 10), num);
    }
  });
}

// ---------- Screen 3: hadith list (for one chapter) ----------
async function openHadithChapter(sectionNo, highlightHadithNo) {
  const book = HADITH_STATE.book;
  if (!book) return;
  HADITH_STATE.section = sectionNo;

  document.getElementById('hadithChaptersContainer').style.display = 'none';
  const listContainer = document.getElementById('hadithListContainer');
  listContainer.style.display = 'block';
  const info = HADITH_STATE.bookInfo;
  const title = info && info.sections ? info.sections[String(sectionNo)] : '';
  document.getElementById('hadithChapterHead').innerHTML =
    `<h2 class="hadith-book-head-title">${book.nameBn} — অধ্যায় ${toBn(sectionNo)}</h2>
     <div class="topic-sub-en">${title || ''}</div>`;
  const bodyEl = document.getElementById('hadithListBody');
  bodyEl.innerHTML = `<div class="loader"><div class="spinner"></div><span>Loading...</span></div>`;

  try {
    const data = await getHadithSection(book.edition, sectionNo);
    renderHadithList(data, highlightHadithNo);
  } catch (e) {
    bodyEl.innerHTML = `<div class="hadith-error">হাদিস লোড করা যায়নি — ইন্টারনেট সংযোগ পরীক্ষা করুন।</div>`;
  }
}

function renderHadithList(data, highlightHadithNo) {
  const bodyEl = document.getElementById('hadithListBody');
  bodyEl.innerHTML = '';
  const hadiths = (data && data.hadiths) || [];
  if (!hadiths.length) {
    bodyEl.innerHTML = `<div class="hadith-error">এই অধ্যায়ে কোনো হাদিস পাওয়া যায়নি।</div>`;
    return;
  }
  hadiths.forEach(h => {
    const grade = pickHadithGrade(h.grades);
    const card = document.createElement('div');
    card.className = 'hadith-card';
    if (highlightHadithNo && h.hadithnumber === highlightHadithNo) card.classList.add('hadith-card-highlight');
    card.id = 'hadith-no-' + h.hadithnumber;
    card.innerHTML = `
      <div class="hadith-card-top">
        <span class="hadith-num-badge">হাদিস ${toBn(h.hadithnumber)}</span>
        ${grade ? `<span class="hadith-grade-badge ${hadithGradeClass(grade.grade)}">${hadithGradeLabel(grade.grade)}</span>` : ''}
      </div>
      <div class="hadith-text">${(h.text || '').replace(/\n+/g, '<br>')}</div>
      <div class="hadith-ref">রেফারেন্স: বই ${h.reference && h.reference.book != null ? toBn(h.reference.book) : '—'}, হাদিস ${h.reference && h.reference.hadith != null ? toBn(h.reference.hadith) : toBn(h.hadithnumber)}</div>`;
    bodyEl.appendChild(card);
  });

  if (highlightHadithNo) {
    const target = document.getElementById('hadith-no-' + highlightHadithNo);
    if (target) setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
  }
}

// ---------- Wiring ----------
function initHadith() {
  document.getElementById('hadithChaptersBackBtn').onclick = () => {
    document.getElementById('hadithChaptersContainer').style.display = 'none';
    document.getElementById('hadithBooksContainer').style.display = 'block';
  };
  document.getElementById('hadithListBackBtn').onclick = () => {
    document.getElementById('hadithListContainer').style.display = 'none';
    document.getElementById('hadithChaptersContainer').style.display = 'block';
  };
  const jumpBtn = document.getElementById('hadithJumpBtn');
  if (jumpBtn) jumpBtn.onclick = openHadithNumberJump;
}
