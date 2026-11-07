// ---------- Foundation donation popup (real-time, Firestore-driven) ----------
// Shows an occasional popup pointing people to your foundation's donation
// page. Content is NOT hardcoded — it's read live from Firestore, so you can
// change the title/message/link/image/on-off switch any time from the
// Firebase Console and every open app instantly reflects it (via onSnapshot),
// with no redeploy needed.
//
// Firestore doc read: siteConfig/donationBanner
//   {
//     enabled: true,              // master on/off switch
//     title: "সদকায়ে জারিয়ায় শরিক হোন",
//     message: "আপনার সামান্য অবদান হাজারো মানুষের কুরআন শেখা সহজ করতে পারে।",
//     imageUrl: "",                // optional banner image, leave "" to skip
//     buttonText: "ডোনেট করুন",
//     buttonLink: "https://your-foundation-site.example/donate",
//     frequencyHours: 24,          // minimum gap between two popups on one device
//     delaySeconds: 4              // wait this long after home loads before showing
//   }
//
// Add this to your Firestore rules so the doc is publicly READABLE but only
// writable by you (edit from the Firebase Console, which bypasses rules):
//   match /siteConfig/{doc} {
//     allow read: if true;
//     allow write: if false;
//   }
//
// Deliberately never shown while a surah is open in reader mode, and never
// stacks on top of another open modal — it only ever appears on the home
// screen, at most once per `frequencyHours`.

let donationCfg = null;
let donationUnsub = null;
const DONATION_LAST_SHOWN_KEY = 'donationBannerLastShown';

function isAnyOtherModalOpen(){
  return !!document.querySelector('.app-modal[style*="flex"]')
    || !!document.getElementById('authOverlay')?.classList.contains('open');
}

function ensureDonationModal(){
  let modal = document.getElementById('donationModal');
  if(modal) return modal;
  modal = document.createElement('div');
  modal.className = 'app-modal donation-modal';
  modal.id = 'donationModal';
  modal.innerHTML = `
    <div class="app-modal-box donation-box">
      <button class="app-modal-close donation-close" id="donationCloseBtn">✕</button>
      <div class="donation-img" id="donationImgWrap" style="display:none">
        <img id="donationImg" alt="">
      </div>
      <div class="donation-body">
        <i class="fa-solid fa-hand-holding-heart donation-icon"></i>
        <h3 id="donationTitle"></h3>
        <p id="donationMessage"></p>
        <div class="donation-actions">
          <a id="donationDonateBtn" class="donation-btn-primary" target="_blank" rel="noopener">
            <i class="fa-solid fa-hand-holding-dollar"></i> <span id="donationBtnLabel"></span>
          </a>
          <button class="donation-btn-later" id="donationLaterBtn">Skip Now</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  wireModalBackdrop('donationModal');
  const dismiss = () => { markDonationShownNow(); closeModal('donationModal'); };
  document.getElementById('donationCloseBtn').onclick = dismiss;
  document.getElementById('donationLaterBtn').onclick = dismiss;
  document.getElementById('donationDonateBtn').onclick = () => markDonationShownNow();
  return modal;
}

function markDonationShownNow(){
  try{ localStorage.setItem(DONATION_LAST_SHOWN_KEY, String(Date.now())); }catch(e){}
}

function renderDonationModal(cfg){
  ensureDonationModal();
  document.getElementById('donationTitle').textContent = cfg.title || '';
  document.getElementById('donationMessage').textContent = cfg.message || '';
  const btn = document.getElementById('donationDonateBtn');
  btn.href = cfg.buttonLink || '#';
  document.getElementById('donationBtnLabel').textContent = cfg.buttonText || 'দান করুন';
  const imgWrap = document.getElementById('donationImgWrap');
  const img = document.getElementById('donationImg');
  if(cfg.imageUrl){
    img.src = cfg.imageUrl;
    imgWrap.style.display = 'block';
  } else {
    imgWrap.style.display = 'none';
  }
}

function canShowDonationNow(cfg){
  if(!cfg || !cfg.enabled) return false;
  if(typeof readerArea !== 'undefined' && readerArea && readerArea.style.display !== 'none') return false; // never interrupt Quran reading
  const homeView = document.getElementById('view-home');
  if(!homeView || !homeView.classList.contains('active')) return false; // only on home
  if(isAnyOtherModalOpen()) return false;
  let last = 0;
  try{ last = parseInt(localStorage.getItem(DONATION_LAST_SHOWN_KEY) || '0', 10); }catch(e){}
  const gapMs = (cfg.frequencyHours != null ? cfg.frequencyHours : 24) * 3600 * 1000;
  return (Date.now() - last) >= gapMs;
}

function tryShowDonationPopup(){
  if(!donationCfg) return;
  if(!canShowDonationNow(donationCfg)) return;
  renderDonationModal(donationCfg);
  markDonationShownNow();
  openModal('donationModal');
}

// ---------- Real-time Firestore listener ----------
function initDonationBanner(){
  if(typeof firebase === 'undefined' || !isFirebaseConfigured()) return;
  try{
    const db = firebase.firestore();
    donationUnsub = db.collection('siteConfig').doc('donationBanner')
      .onSnapshot((snap) => {
        donationCfg = snap.exists ? snap.data() : null;
      }, (err) => { console.warn('Donation banner config unavailable:', err); });
  }catch(e){ console.warn('Donation banner init failed:', e); return; }

  const delayMs = 4000; // fallback delay before first attempt while cfg loads
  setTimeout(function attempt(){
    if(!donationCfg){ setTimeout(attempt, 1500); return; } // wait for first snapshot
    const delay = (donationCfg.delaySeconds != null ? donationCfg.delaySeconds : 4) * 1000;
    setTimeout(tryShowDonationPopup, Math.max(0, delay));
  }, 500);

  // Also re-check whenever the user navigates back to the home tab.
  document.querySelectorAll('.bn-item').forEach(btn => {
    btn.addEventListener('click', () => {
      if(btn.getAttribute('data-view') === 'home') setTimeout(tryShowDonationPopup, 800);
    });
  });
}
