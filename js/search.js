// ---------- Full-Quran search ----------
// Supports two modes, auto-detected from the query:
//   - Translation search (default): searches the user's chosen translation edition.
//   - Arabic search: triggered when the query contains Arabic characters. Diacritics
//     (harakat) are stripped from the query and matched against the "quran-simple-clean"
//     edition (Arabic text without tashkeel), so search is harakat-insensitive.
// Results are paginated with a "load more" button instead of a hard 40-result cutoff.

const SEARCH_PAGE_SIZE = 20;
let allSearchMatches = [];
let searchRenderedCount = 0;
let currentSearchIsArabic = false;

function initSearch(){
  const searchInput = document.getElementById('searchInput');
  const searchPanel = document.getElementById('searchPanel');
  document.getElementById('closeSearch').onclick = () => { searchPanel.style.display='none'; };

  let searchTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if(!q){ searchPanel.style.display='none'; return; }
    searchTimer = setTimeout(() => runSearch(q), 500);
  });
}

// Strips Arabic diacritics/tatweel and normalizes common letter variants, so
// search matching doesn't depend on the exact harakat the user typed (or
// didn't type).
function normalizeArabic(str){
  return (str || '')
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '') // harakat/tashkeel marks
    .replace(/\u0640/g, '')                              // tatweel
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .trim();
}

async function runSearch(q){
  const searchPanel = document.getElementById('searchPanel');
  const searchResults = document.getElementById('searchResults');
  const searchTitle = document.getElementById('searchTitle');

  const isArabic = /[\u0600-\u06FF]/.test(q);
  currentSearchIsArabic = isArabic;
  const searchEdition = isArabic ? 'quran-simple-clean' : state.translationEdition;
  const queryForApi = isArabic ? normalizeArabic(q) : q;

  searchPanel.style.display='flex';
  searchTitle.textContent = `"${q}" এর জন্য ফলাফল`;
  searchResults.innerHTML = `<div class="loader"><div class="spinner"></div><span>খোঁজা হচ্ছে...</span></div>`;
  incrementSearchCount();
  try{
    const res = await fetch(`${API}/search/${encodeURIComponent(queryForApi)}/all/${searchEdition}`);
    const data = await res.json();
    const matches = (data.data && data.data.matches) || [];
    if(matches.length === 0){
      searchResults.innerHTML = `<div class="sr-empty">কোনো ফলাফল পাওয়া যায়নি।</div>`;
      return;
    }
    searchResults.innerHTML = '';
    allSearchMatches = matches;
    searchRenderedCount = 0;
    renderSearchResultsPage();
  }catch(e){
    searchResults.innerHTML = `<div class="sr-empty">Search failed, check internet connection.</div>`;
  }
}

function renderSearchResultsPage(){
  const searchResults = document.getElementById('searchResults');
  const oldBtn = document.getElementById('searchLoadMoreBtn');
  if(oldBtn) oldBtn.remove();

  const nextBatch = allSearchMatches.slice(searchRenderedCount, searchRenderedCount + SEARCH_PAGE_SIZE);
  nextBatch.forEach(m => {
    const div = document.createElement('div');
    div.className = 'search-result';
    const surahName = surahNamesBn[m.surah.number-1] || m.surah.englishName;
    const textHtml = currentSearchIsArabic
      ? `<div class="sr-text sr-text-ar" dir="rtl">${m.text}</div>`
      : `<div class="sr-text">${m.text}</div>`;
    div.innerHTML = `<div class="sr-ref">সূরা ${surahName} — আয়াত ${toBn(m.numberInSurah)}</div>${textHtml}`;
    div.onclick = () => {
      document.getElementById('searchPanel').style.display='none';
      openSurahAndScrollTo(m.surah.number, m.numberInSurah);
    };
    searchResults.appendChild(div);
  });
  searchRenderedCount += nextBatch.length;

  if(searchRenderedCount < allSearchMatches.length){
    const btn = document.createElement('button');
    btn.id = 'searchLoadMoreBtn';
    btn.className = 'search-load-more-btn';
    btn.textContent = `see more (${toBn(allSearchMatches.length - searchRenderedCount)} The rest)`;
    btn.onclick = renderSearchResultsPage;
    searchResults.appendChild(btn);
  }
}
