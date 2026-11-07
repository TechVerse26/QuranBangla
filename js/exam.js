// ---------- পরীক্ষা (Exam) — full-page realtime exam-link list ----------
// Admin adds/edits/deletes exam links from admin.html (Firestore `exams`
// collection). This file only READS that collection in realtime and shows
// each link to normal users on its own bottom-nav page (view-exam) — no
// admin controls live in the main app at all, so a regular visitor can
// never see or touch anything admin-only.
// Firestore security is enforced server-side in firestore.rules
// (`allow write: if isAdmin()` on the `exams` collection) — anything here
// is only for the UI.
//
// ---- Admin button (admins/{uid}) ----
// Same check admin.html itself uses: a signed-in user counts as admin only
// if their own admins/{uid} Firestore doc exists AND has isAdmin:true (see
// firestore.rules `isAdmin()`; that doc can only be added/removed manually
// from the Firebase Console). Verified fresh each time this page is opened
// so promoting/demoting someone in the Console takes effect on their very
// next visit — cached per uid within the session so repeat visits don't
// re-query Firestore needlessly, and reset the moment the signed-in user
// changes (sign-out, or a different account signs in).

let examUnsub = null;
let examListCache = [];
let examListenerStarted = false;
let examAdminCheckedUid = null; // uid the last admin check was run for
let examIsAdminCache = false;

// ---------- Live "প্রকাশের সময়" countdown ----------
// examDoc.publishAt (optional Firestore Timestamp, set from admin.html) —
// while it's in the future the card shows a locked, ticking countdown
// instead of the normal clickable card. examCountdowns maps examId -> the
// target Date, for every card currently counting down inside the DOM.
// A single shared 1s interval updates every visible countdown's digits in
// place (no full re-render, so it stays smooth), and the moment one hits
// zero its card is swapped for the normal unlocked exam-card automatically
// — no refresh, no waiting for a new Firestore snapshot.
let examCountdowns = new Map(); // examId -> target Date
let examCountdownTickHandle = null;
let examListContainerEl = null;

function examPublishDate(exam){
  return (exam && exam.publishAt && typeof exam.publishAt.toDate === 'function')
    ? exam.publishAt.toDate() : null;
}

// Called once from js/app.js during startup. The listener is opened right
// away (not only when the tab is first tapped) so the page is already
// populated the instant someone switches to it — same as how the surah
// list is fetched once up front instead of on first tab-open.
function initExam(){
  startExamRealtime();
  const adminBtn = document.getElementById('examAdminBtn');
  if(adminBtn) adminBtn.onclick = () => {
    if(typeof AdminPanel !== 'undefined') AdminPanel.open();
  };
}

// Called every time the "পরীক্ষা" tab (bottom nav or drawer) is opened.
function onExamViewOpened(){
  const container = document.getElementById('examListContainer');
  if(!container) return;
  if(examListenerStarted) renderExamList(container);
  else startExamRealtime();
  checkExamAdminStatus();
}

// Verifies (or re-uses a cached verification of) admins/{uid} for whoever
// is currently signed in, and shows/hides the "এডমিন প্যানেল" button
// accordingly — never shown to a signed-out visitor or a regular account.
async function checkExamAdminStatus(){
  const btn = document.getElementById('examAdminBtn');
  if(!btn) return;
  const user = (typeof state !== 'undefined') ? state.user : null;

  if(!user){
    examAdminCheckedUid = null;
    examIsAdminCache = false;
    btn.style.display = 'none';
    return;
  }

  // Already verified this exact account this session — just apply it.
  if(examAdminCheckedUid === user.uid){
    btn.style.display = examIsAdminCache ? 'flex' : 'none';
    return;
  }

  btn.style.display = 'none'; // hide while (re-)verifying, never flash a wrong state
  if(typeof fbDb === 'undefined' || !fbDb || !firebaseReady) return; // Firebase not ready yet — next visit/refresh will re-check

  try{
    const doc = await fbDb.collection('admins').doc(user.uid).get();
    examIsAdminCache = doc.exists && doc.data().isAdmin === true;
  }catch(e){
    examIsAdminCache = false;
  }
  examAdminCheckedUid = user.uid;

  // The signed-in account may have changed while the query was in flight
  // (e.g. a quick sign-out) — only apply the result if it's still current.
  const stillSameUser = (typeof state !== 'undefined') && state.user && state.user.uid === user.uid;
  if(stillSameUser) btn.style.display = examIsAdminCache ? 'flex' : 'none';
}

function startExamRealtime(){
  const container = document.getElementById('examListContainer');
  if(!container) return;

  if(typeof fbDb === 'undefined' || !fbDb || !firebaseReady){
    // Firebase not ready yet (e.g. still loading on first paint) — retry
    // shortly instead of showing a false "failed" message.
    if(!examListenerStarted) setTimeout(startExamRealtime, 800);
    return;
  }
  if(examUnsub) return; // already listening

  examListenerStarted = true;
  // asc: প্রথমে যোগ করা পরীক্ষাগুলো উপরে থাকবে, নতুন যোগ হওয়া পরীক্ষা
  // সবসময় তালিকার নিচে যুক্ত হবে (সিরিয়াল ধরে রাখতে)।
  examUnsub = fbDb.collection('exams').orderBy('createdAt', 'asc')
    .onSnapshot(
      (snap) => {
        examListCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderExamList(container);
      },
      (err) => {
        console.warn('Exam list listener failed:', err);
        container.innerHTML = `<div class="error-box">পরীক্ষার তালিকা লোড করা যায়নি।<br><button onclick="startExamRealtimeRetry()">আবার চেষ্টা করুন</button></div>`;
      }
    );
}

function startExamRealtimeRetry(){
  if(examUnsub){ examUnsub(); examUnsub = null; }
  examListenerStarted = false;
  startExamRealtime();
}

// Modern "exam card" list — replaces the old generic .list-item rendering.
// Each card shows, when the admin set them on the exam doc, the exam's
// duration (durationMinutes) and question count (questionCount) as small
// info chips, so a student knows what they're getting into before tapping.
function renderExamList(container){
  examListContainerEl = container;
  examCountdowns.clear(); // full rebuild below re-registers whichever are still locked

  if(!examListCache.length){
    container.innerHTML = `<div class="error-box">এখন কোনো পরীক্ষা চালু নেই। নতুন পরীক্ষা যোগ হলে এখানেই দেখা যাবে।</div>`;
    stopExamCountdownTicker();
    return;
  }
  container.innerHTML = '';
  examListCache.forEach(exam => {
    const publishDate = examPublishDate(exam);
    const isLocked = publishDate && publishDate.getTime() > Date.now();
    const card = isLocked ? buildLockedExamCard(exam, publishDate) : buildUnlockedExamCard(exam);
    if(isLocked) examCountdowns.set(exam.id, publishDate);
    container.appendChild(card);
  });
  ensureExamCountdownTicker();
}

function examChipsHtml(exam){
  const chips = [];
  if(Number.isFinite(exam.durationMinutes)){
    chips.push(`<span class="exam-chip"><i class="fa-regular fa-clock"></i> ${exam.durationMinutes} মিনিট</span>`);
  }
  if(Number.isFinite(exam.questionCount)){
    chips.push(`<span class="exam-chip"><i class="fa-solid fa-list-ol"></i> ${exam.questionCount} টি প্রশ্ন</span>`);
  }
  return chips.length ? `<div class="exam-card-meta">${chips.join('')}</div>` : '';
}

// Normal, clickable card — used once an exam is (or becomes) published.
function buildUnlockedExamCard(exam){
  const card = document.createElement('div');
  card.className = 'exam-card';
  card.dataset.examId = exam.id;
  card.setAttribute('role', 'button');
  card.tabIndex = 0;

  card.innerHTML = `
    <div class="exam-card-icon"><i class="fa-solid fa-pen-to-square"></i></div>
    <div class="exam-card-body">
      <div class="exam-card-title">${escapeHtml(exam.title || 'পরীক্ষা')}</div>
      ${exam.description ? `<div class="exam-card-desc">${escapeHtml(exam.description)}</div>` : ''}
      ${examChipsHtml(exam)}
    </div>
    <div class="exam-card-cta"><i class="fa-solid fa-arrow-right"></i></div>`;

  const open = () => openExamConsentModal(exam.link);
  card.onclick = open;
  card.onkeydown = (e) => { if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); open(); } };
  return card;
}

// Locked card — shown while exam.publishAt is still in the future. Not
// clickable; shows a live D/H/M/S countdown that ticks down to zero on its
// own (see tickExamCountdowns), at which point this card is replaced with
// buildUnlockedExamCard's version automatically.
function buildLockedExamCard(exam, publishDate){
  const card = document.createElement('div');
  card.className = 'exam-card exam-card-locked';
  card.dataset.examId = exam.id;

  card.innerHTML = `
    <div class="exam-card-icon exam-card-icon-locked"><i class="fa-solid fa-hourglass-half"></i></div>
    <div class="exam-card-body">
      <div class="exam-locked-badge"><i class="fa-solid fa-hourglass-half"></i> শীঘ্রই আসছে</div>
      <div class="exam-card-title">${escapeHtml(exam.title || 'পরীক্ষা')}</div>
      ${exam.description ? `<div class="exam-card-desc">${escapeHtml(exam.description)}</div>` : ''}
      <div class="exam-countdown" role="timer" aria-live="off">
        ${examCountdownUnitHtml('d','দিন')}
        <div class="ecd-sep">:</div>
        ${examCountdownUnitHtml('h','ঘণ্টা')}
        <div class="ecd-sep">:</div>
        ${examCountdownUnitHtml('m','মিনিট')}
        <div class="ecd-sep">:</div>
        ${examCountdownUnitHtml('s','সেকেন্ড')}
      </div>
      <div class="exam-publish-line"><i class="fa-regular fa-calendar-clock"></i> প্রকাশ পাবে: ${escapeHtml(formatExamPublishDate(publishDate))}</div>
      ${examChipsHtml(exam)}
    </div>`;

  writeExamCountdownDigits(card, publishDate.getTime() - Date.now());
  return card;
}

function examCountdownUnitHtml(unit, label){
  return `<div class="ecd-unit"><span class="ecd-val" data-unit="${unit}">00</span><span class="ecd-label">${label}</span></div>`;
}

function formatExamPublishDate(d){
  try{
    return d.toLocaleString('bn-BD', { year:'numeric', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
  }catch(e){
    return d.toLocaleString();
  }
}

// Updates just the four digit spans inside one locked card — called every
// tick, so it must stay cheap (no innerHTML rebuild).
function writeExamCountdownDigits(card, diffMs){
  const clamped = Math.max(0, diffMs);
  const totalSeconds = Math.floor(clamped / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = n => String(n).padStart(2, '0');
  const set = (unit, val) => { const el = card.querySelector(`.ecd-val[data-unit="${unit}"]`); if(el) el.textContent = val; };
  set('d', pad(days)); set('h', pad(hours)); set('m', pad(minutes)); set('s', pad(seconds));
}

function ensureExamCountdownTicker(){
  if(examCountdownTickHandle || !examCountdowns.size) return;
  examCountdownTickHandle = setInterval(tickExamCountdowns, 1000);
}

function stopExamCountdownTicker(){
  if(examCountdownTickHandle){ clearInterval(examCountdownTickHandle); examCountdownTickHandle = null; }
}

// Runs every second: updates every still-locked card's digits, and the
// instant one's target time is reached, swaps that single card for its
// unlocked version with a smooth reveal — fully client-side, no reload and
// no need to wait for another Firestore snapshot.
function tickExamCountdowns(){
  if(!examListContainerEl || !examCountdowns.size){ stopExamCountdownTicker(); return; }

  examCountdowns.forEach((publishDate, examId) => {
    const card = examListContainerEl.querySelector(`.exam-card-locked[data-exam-id="${cssEscapeExamId(examId)}"]`);
    const diff = publishDate.getTime() - Date.now();

    if(diff > 0){
      if(card) writeExamCountdownDigits(card, diff);
      return;
    }

    // Time's up — reveal the real card in place.
    examCountdowns.delete(examId);
    const exam = examListCache.find(e => e.id === examId);
    if(card && exam){
      const unlocked = buildUnlockedExamCard(exam);
      unlocked.classList.add('exam-card-reveal');
      card.replaceWith(unlocked);
      setTimeout(() => unlocked.classList.remove('exam-card-reveal'), 900);
    }
  });

  if(!examCountdowns.size) stopExamCountdownTicker();
}

function cssEscapeExamId(id){
  return (window.CSS && CSS.escape) ? CSS.escape(id) : id.replace(/"/g, '\\"');
}

// ---------- Exam consent modal ----------
// Shown instead of opening the exam link directly: explains the exam runs
// on the TechVerse platform (account / Google sign-in required there),
// links out to their privacy policy + help pages, and requires the "I
// agree" checkbox before "এগিয়ে যান" will actually open the link.
let examConsentPendingLink = null;
let examConsentWired = false;

function openExamConsentModal(link){
  if(!link) return;
  examConsentPendingLink = link;
  wireExamConsentModal();
  const modal = document.getElementById('examConsentModal');
  const check = document.getElementById('examConsentCheck');
  const proceedBtn = document.getElementById('examConsentProceed');
  if(check) check.checked = false;
  if(proceedBtn) proceedBtn.disabled = true;
  if(modal) modal.style.display = 'flex';
}

function closeExamConsentModal(){
  const modal = document.getElementById('examConsentModal');
  if(modal) modal.style.display = 'none';
  examConsentPendingLink = null;
}

function wireExamConsentModal(){
  if(examConsentWired) return;
  examConsentWired = true;

  const modal = document.getElementById('examConsentModal');
  const check = document.getElementById('examConsentCheck');
  const proceedBtn = document.getElementById('examConsentProceed');
  const cancelBtn = document.getElementById('examConsentCancel');
  const closeBtn = document.getElementById('examConsentClose');

  if(check && proceedBtn){
    check.addEventListener('change', () => { proceedBtn.disabled = !check.checked; });
  }
  if(proceedBtn){
    proceedBtn.onclick = () => {
      if(proceedBtn.disabled || !examConsentPendingLink) return;
      window.open(examConsentPendingLink, '_blank', 'noopener');
      closeExamConsentModal();
    };
  }
  if(cancelBtn) cancelBtn.onclick = closeExamConsentModal;
  if(closeBtn) closeBtn.onclick = closeExamConsentModal;
  // ব্যাকড্রপে ট্যাপ করলেও বন্ধ হবে (বক্সের ভেতরে ক্লিক করলে বন্ধ হবে না)
  if(modal){
    modal.addEventListener('click', (e) => { if(e.target === modal) closeExamConsentModal(); });
  }
}
