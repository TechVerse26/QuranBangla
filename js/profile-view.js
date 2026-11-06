// ---------- Profile section: dedicated bottom-nav PAGE, not a popup ----------
// Everything the old "stats page → sign up/login popup" and "stats page →
// profile popup" used to do now lives directly inside #view-profile (see
// index.html + js/nav.js VIEW_IDS). Tapping the "প্রোফাইল" tab always
// lands on a real page: the sign-up/login screens when signed out, the
// full profile when signed in — never an overlay.
//
// Contextual "you need to sign in to do X" prompts elsewhere in the app
// (re-authenticating for a security action, etc.) still use the original
// overlay in js/auth.js (openAuthFlow) — that one makes sense as an
// interruption over whatever the person was doing. Only the primary entry
// point (bottom nav + the stats page's account row) now goes to this page.

// Which signed-out screen to land on next time the page renders — set by
// goToProfilePage()/wireAuthPageScreens() so "সাইন আপ করুন" vs the account
// row can each open on the right screen.
let profilePageAuthScreen = 'choice';

function renderProfileView(){
  const container = document.getElementById('profileViewContainer');
  if(!container) return;
  if(state.user){
    container.innerHTML = profileContentHtml(state.user);
    wireProfileContent(state.user);
  } else {
    if(!firebaseReady){
      container.innerHTML = `<div class="profile-page-loading">${
        (typeof isFirebaseConfigured === 'function' && !isFirebaseConfigured())
          ? 'এখনো এই ফিচারটি উপলব্ধ করা হয়নি'
          : 'লোড হচ্ছে...'
      }</div>`;
      return;
    }
    container.innerHTML = authPageHtml();
    wireAuthPageScreens(container);
    showProfilePageAuthScreen(profilePageAuthScreen);
  }
}

// Called from the bottom-nav tab, the stats page's account row, and any
// other spot that used to call openProfileModal()/openAuthFlow() as the
// PRIMARY entry point — jumps straight to the page instead of a popup.
function goToProfilePage(screen){
  profilePageAuthScreen = screen || 'choice';
  goToView('profile');
}

// ================= Signed-out: sign up / login / forgot, inline =================
function authPageHtml(){
  return `
    <div class="profile-page-auth" id="profilePageAuth">
      <div class="auth-screen active" id="ppAuthChoice">
        <div class="auth-topbar is-root"><span>সাইন আপ / লগইন করুন</span></div>
        <div class="auth-body">
          <div class="auth-scene auth-scene-choice">
            <div class="auth-icon-box"><i class="fa-solid fa-book-open"></i></div>
            <div class="auth-medal"><i class="fa-solid fa-star"></i></div>
            <i class="fa-solid fa-sparkles auth-spark s1"></i>
            <i class="fa-solid fa-sparkles auth-spark s2"></i>
            <span class="auth-dot" style="top:8px;left:6px;"></span>
          </div>
          <h2 class="auth-title">অ্যাকাউন্ট তৈরি করুন</h2>
          <p class="auth-sub">আপনার অর্জন ও পড়ার অগ্রগতি সুরক্ষিত রাখুন। আপনার সম্পূর্ণ পরিসংখ্যান এক জায়গায় দেখুন।</p>
          <button class="auth-cta-btn" id="ppGoSignup">ইমেইল দিয়ে সাইন আপ করুন</button>
          ${socialAuthButtonsHtml()}
          <div class="auth-switch">অলরেডি অ্যাকাউন্ট আছে? <a href="javascript:void(0)" id="ppGoLogin">লগইন করুন</a></div>
        </div>
      </div>

      <div class="auth-screen" id="ppAuthSignup">
        <div class="auth-topbar">
          <button class="auth-back" data-pp-back="choice"><i class="fa-solid fa-arrow-left"></i></button>
          <span>সাইন আপ</span>
        </div>
        <div class="auth-body">
          <div class="auth-scene auth-scene-signup">
            <div class="auth-card-tile"></div>
            <div class="auth-plus-mock">
              <div class="auth-plus-circle"><i class="fa-solid fa-plus"></i></div>
              <div class="auth-plus-row"><span class="dot"></span><span class="bar"></span></div>
              <div class="auth-plus-row"><span class="dot"></span><span class="bar short"></span></div>
            </div>
          </div>
          <h2 class="auth-title">কুরআন বাংলা অ্যাকাউন্ট তৈরি করুন</h2>
          <p class="auth-sub">আমাদের যেকোনো অ্যাপে এই অ্যাকাউন্ট দিয়ে লগইন এবং সিঙ্ক করুন।</p>
          <input class="auth-field" id="ppSuName" type="text" placeholder="নাম">
          <input class="auth-field" id="ppSuPosition" type="text" placeholder="পদবি (ঐচ্ছিক)">
          <input class="auth-field" id="ppSuEmail" type="email" placeholder="ইমেইল">
          <input class="auth-field" id="ppSuPassword" type="password" placeholder="পাসওয়ার্ড">
          <input class="auth-field" id="ppSuPasswordConfirm" type="password" placeholder="পাসওয়ার্ড নিশ্চিত করুন">
          <div class="auth-error" id="ppSuError"></div>
          <button class="auth-cta-btn has-icon" id="ppSuSubmit"><span>সাইন আপ</span><span class="cta-icon-dot"><i class="fa-solid fa-plus"></i></span></button>
          ${socialAuthButtonsHtml()}
        </div>
      </div>

      <div class="auth-screen" id="ppAuthLogin">
        <div class="auth-topbar">
          <button class="auth-back" data-pp-back="choice"><i class="fa-solid fa-arrow-left"></i></button>
          <span>লগইন করুন</span>
        </div>
        <div class="auth-body">
          <div class="auth-scene auth-scene-login">
            <div class="auth-icon-box"><i class="fa-solid fa-right-to-bracket"></i></div>
            <span class="auth-leaf l1"></span>
            <span class="auth-leaf l2"></span>
            <i class="fa-solid fa-sparkles auth-spark s3"></i>
          </div>
          <h2 class="auth-title">বিদ্যমান অ্যাকাউন্টে লগইন করুন</h2>
          <input class="auth-field" id="ppLiEmail" type="email" placeholder="ইমেইল">
          <input class="auth-field" id="ppLiPassword" type="password" placeholder="পাসওয়ার্ড">
          <div class="auth-error" id="ppLiError"></div>
          <button class="auth-cta-btn" id="ppLiSubmit">লগইন করুন</button>
          <div class="auth-switch"><a href="javascript:void(0)" id="ppLiForgot">পাসওয়ার্ড ভুলে গেছেন?</a></div>
          ${socialAuthButtonsHtml()}
        </div>
      </div>

      <div class="auth-screen" id="ppAuthForgot">
        <div class="auth-topbar">
          <button class="auth-back" data-pp-back="login"><i class="fa-solid fa-arrow-left"></i></button>
          <span>পাসওয়ার্ড পুনরুদ্ধার করুন</span>
        </div>
        <div class="auth-body">
          <h2 class="auth-title">পুনরুদ্ধার করতে নিবন্ধিত ইমেইলটি প্রবেশ করুন</h2>
          <p class="auth-sub">চিন্তা করবেন না, আমরা আপনার ইমেইলে একটি পাসওয়ার্ড পুনরুদ্ধারের লিঙ্ক পাঠাবো।</p>
          <input class="auth-field" id="ppFgEmail" type="email" placeholder="ইমেইল">
          <div class="auth-error" id="ppFgError"></div>
          <button class="auth-cta-btn" id="ppFgSubmit">পুনরুদ্ধারের লিঙ্ক ইমেইল করুন</button>
        </div>
      </div>
    </div>`;
}

function showProfilePageAuthScreen(name){
  profilePageAuthScreen = name;
  ['choice','signup','login','forgot'].forEach(n => {
    const el = document.getElementById('ppAuth' + n.charAt(0).toUpperCase() + n.slice(1));
    if(el) el.classList.toggle('active', n === name);
  });
  window.scrollTo(0,0);
}

function wireAuthPageScreens(container){
  container.querySelectorAll('[data-pp-back]').forEach(b => b.onclick = () => showProfilePageAuthScreen(b.getAttribute('data-pp-back')));
  document.getElementById('ppGoSignup').onclick = () => showProfilePageAuthScreen('signup');
  document.getElementById('ppGoLogin').onclick = () => showProfilePageAuthScreen('login');
  document.getElementById('ppLiForgot').onclick = () => showProfilePageAuthScreen('forgot');
  container.querySelectorAll('[data-social-provider]').forEach(btn => {
    btn.onclick = () => handleSocialSignIn(btn.getAttribute('data-social-provider'), btn);
  });
  document.getElementById('ppSuSubmit').onclick = handleEmailSignupPage;
  document.getElementById('ppLiSubmit').onclick = handleEmailLoginPage;
  document.getElementById('ppFgSubmit').onclick = handlePasswordResetPage;
}

// Same Firebase calls as js/auth.js's handleEmailSignup/handleEmailLogin/
// handlePasswordReset, just reading from this page's own ppSu*/ppLi*/ppFg*
// fields (kept ID-distinct from the overlay's su*/li*/fg* fields so the
// two never collide if a contextual sign-in overlay is ever open at the
// same time as this page).
async function handleEmailSignupPage(){
  const name = document.getElementById('ppSuName').value.trim();
  const position = document.getElementById('ppSuPosition').value.trim();
  const email = document.getElementById('ppSuEmail').value.trim();
  const pass = document.getElementById('ppSuPassword').value;
  const pass2 = document.getElementById('ppSuPasswordConfirm').value;
  const errBox = document.getElementById('ppSuError');
  errBox.textContent = '';

  if(!name || !email || !pass){ errBox.textContent = 'সব ঘর পূরণ করুন।'; return; }
  if(pass.length < 6){ errBox.textContent = 'পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।'; return; }
  if(pass !== pass2){ errBox.textContent = 'পাসওয়ার্ড দুটি মিলছে না।'; return; }

  const btn = document.getElementById('ppSuSubmit');
  const btnOriginal = btn.innerHTML;
  btn.disabled = true; btn.textContent = 'অপেক্ষা করুন...';
  if(typeof markFreshLoginIntent === 'function') markFreshLoginIntent();
  try{
    const cred = await fbAuth.createUserWithEmailAndPassword(email, pass);
    await cred.user.updateProfile({ displayName: name });
    await fbDb.collection('users').doc(cred.user.uid).set({
      name, position, email, createdAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    // No overlay to close — onAuthStateChanged → refreshCurrentView() will
    // swap this page over to the signed-in profile automatically.
  }catch(e){
    errBox.textContent = authErrorMessageBn(e);
    btn.disabled = false; btn.innerHTML = btnOriginal;
  }
}

async function handleEmailLoginPage(){
  const email = document.getElementById('ppLiEmail').value.trim();
  const pass = document.getElementById('ppLiPassword').value;
  const errBox = document.getElementById('ppLiError');
  errBox.textContent = '';
  if(!email || !pass){ errBox.textContent = 'ইমেইল ও পাসওয়ার্ড দিন।'; return; }

  const btn = document.getElementById('ppLiSubmit');
  btn.disabled = true; btn.textContent = 'অপেক্ষা করুন...';
  if(typeof markFreshLoginIntent === 'function') markFreshLoginIntent();
  try{
    await fbAuth.signInWithEmailAndPassword(email, pass);
  }catch(e){
    errBox.textContent = authErrorMessageBn(e);
    btn.disabled = false; btn.textContent = 'লগইন করুন';
  }
}

// js/auth.js এর handlePasswordReset() এর মতোই — Firebase Authentication-এর
// নিজস্ব built-in sendPasswordResetEmail() ব্যবহার করে, actionCodeSettings
// আসছে js/firebase-config.js থেকে (PASSWORD_RESET_ACTION_CODE_SETTINGS)।
async function handlePasswordResetPage(){
  const email = document.getElementById('ppFgEmail').value.trim();
  const errBox = document.getElementById('ppFgError');
  errBox.textContent = '';
  if(!email){ errBox.textContent = 'ইমেইল দিন।'; return; }
  const btn = document.getElementById('ppFgSubmit');
  btn.disabled = true; btn.textContent = 'পাঠানো হচ্ছে...';
  try{
    await fbAuth.sendPasswordResetEmail(email, PASSWORD_RESET_ACTION_CODE_SETTINGS);
    showToast('পুনরুদ্ধারের লিঙ্ক ইমেইলে পাঠানো হয়েছে');
    showProfilePageAuthScreen('login');
  }catch(e){
    // কোন ইমেইল রেজিস্টার্ড আছে তা বাইরের কেউ যেন বুঝতে না পারে, তাই
    // user-not-found তেও একই সফল বার্তা দেখানো হয়।
    if(e && e.code === 'auth/user-not-found'){
      showToast('পুনরুদ্ধারের লিঙ্ক ইমেইলে পাঠানো হয়েছে');
      showProfilePageAuthScreen('login');
    }else if(e && e.code === 'auth/invalid-email'){
      errBox.textContent = 'সঠিক ইমেইল দিন।';
    }else{
      errBox.textContent = 'ইন্টারনেট সংযোগ পরীক্ষা করুন।';
    }
  }finally{
    btn.disabled = false; btn.textContent = 'পুনরুদ্ধারের লিঙ্ক ইমেইল করুন';
  }
}

// ================= Signed-in: full profile page =================
// Same content/behaviour as the old openProfileModal() popup (view/edit
// hero card, completeness bar, stats, badges, mini heatmap, account info,
// linked accounts, security actions, danger zone) — just rendered straight
// into the page instead of an app-modal overlay, and with no close button
// since there's nothing to dismiss back to.
function profileContentHtml(user){
  const avatarColor = user.avatarColor || PROFILE_AVATAR_COLORS[0];
  const avatarIcon = (user.avatarIcon && isKnownAvatarIcon(user.avatarIcon)) ? user.avatarIcon : '';
  const providerIds = user.providerIds || [user.provider || 'password'];
  const isPasswordUser = providerIds.includes('password');
  const linkedAccountCount = SOCIAL_PROVIDERS.filter(p => providerIds.includes(p.id)).length;
  const activity = (typeof loadActivity === 'function') ? loadActivity() : {};
  const streak = (typeof computeStreak === 'function') ? computeStreak(activity) : 0;
  const badgeTotal = (typeof BADGES !== 'undefined') ? BADGES.length : 0;
  const badgeUnlocked = (typeof unlockedBadgesCount === 'function') ? unlockedBadgesCount() : 0;
  const ayahCount = (typeof ayahsReadCount === 'function') ? ayahsReadCount() : 0;
  const bestStreak = Math.max(state.bestStreak||0, streak);
  const completion = profileCompletionPct(user, avatarIcon);

  const topBadges = (typeof BADGES !== 'undefined') ? BADGES.slice().sort((a,b) => {
    const au = a.progress() >= a.goal, bu = b.progress() >= b.goal;
    if(au !== bu) return au ? -1 : 1;
    return (b.progress()/b.goal) - (a.progress()/a.goal);
  }).slice(0, 4) : [];

  const filledChips = PROFILE_OPTIONAL_FIELDS.filter(f => user[f.key] && String(user[f.key]).trim());
  const hasBio = !!(user.bio && user.bio.trim());

  return `
    <div class="profile-page-body">

      <!-- ---- Hero: cover + overlapping avatar + name/position ---- -->
      <div class="profile-hero">
        <div class="profile-hero-cover"></div>
        <div class="profile-hero-avatar-wrap">
          <div class="profile-avatar-lg profile-hero-avatar" id="profileAvatarPreview" style="${user.photoData ? `background-image:url('${user.photoData}');background-size:cover;background-position:center;` : `background:${avatarColor}`}">${user.photoData ? '' : avatarGlyph(user)}</div>
          <button type="button" class="profile-hero-camera-badge" id="profileHeroCameraBadge" aria-label="${tr('profile_avatar_choose')}"><i class="fa-solid fa-camera"></i></button>
        </div>
        <div class="profile-hero-name" id="viewHeroName">${escapeHtml(user.name||'')}</div>
        <div class="profile-hero-position" id="viewHeroPosition"${user.position ? '' : ' style="display:none"'}>${escapeHtml(user.position||'')}</div>
        ${user.joinedAt ? `<div class="profile-joined"><i class="fa-regular fa-calendar"></i> ${tr('profile_joined')}: ${formatJoinDate(user.joinedAt)}</div>` : ''}
      </div>

      <!-- ---- Profile completeness ---- -->
      <div class="profile-completion-row">
        <div class="profile-completion-label"><span>${tr('profile_completion')}</span><span id="completionPctText">${localNum(completion)}%</span></div>
        <div class="badges-summary-bar"><div class="badges-summary-fill" id="completionFill" style="width:0%"></div></div>
      </div>

      <!-- ---- View mode: bio + info chips ---- -->
      <div class="profile-view-card" id="profileViewCard">
        ${hasBio ? `<p class="profile-bio-text" id="viewBioText">${escapeHtml(user.bio)}</p>` : ''}
        ${filledChips.length ? `<div class="profile-chip-row" id="viewChipRow">${filledChips.map(f => `<div class="profile-chip" title="${escapeHtml(tr(f.labelKey))}"><i class="fa-solid fa-${f.icon}"></i><span>${escapeHtml(f.fmt ? f.fmt(user[f.key]) : user[f.key])}</span></div>`).join('')}</div>` : ''}
        ${(!hasBio && !filledChips.length) ? `<p class="profile-empty-hint" id="viewEmptyHint">${tr('profile_empty_hint')}</p>` : ''}
      </div>

      <!-- ---- Highlights: permanently-saved status items (js/status-highlights.js) ---- -->
      <div id="statusHighlightsRow" class="profile-highlights-row"></div>

      <button type="button" class="settings-btn profile-action-btn profile-edit-toggle-btn" id="profEditToggleBtn">
        <i class="fa-solid fa-pen-to-square"></i><span>${tr('profile_edit')}</span>
      </button>

      <!-- ---- Edit mode: avatar picker + full form (collapsed by default) ---- -->
      <div class="profile-edit-form" id="profileEditForm" style="display:none">
        <div class="profile-avatar-row">
          <button type="button" class="profile-avatar-toggle" id="avatarToggle" aria-expanded="false" aria-controls="avatarGridWrap">
            <span>${tr('profile_avatar_choose')}</span>
            <i class="fa-solid fa-chevron-down profile-avatar-toggle-icon" id="avatarToggleIcon"></i>
          </button>
          <div class="profile-avatar-grid" id="avatarGridWrap">
            <label class="profile-avatar-tile profile-avatar-photo-tile${user.photoData?' active has-photo':''}" id="avatarPhotoTile" aria-label="${tr('profile_avatar_upload_photo')}" style="${user.photoData ? `background-image:url('${user.photoData}');` : ''}">
              <i class="fa-solid fa-camera"></i>
              <input type="file" accept="image/*" id="profilePhotoInput" style="display:none;">
            </label>
            <button type="button" class="profile-avatar-tile none-tile${(avatarIcon || user.photoData)?'':' active'}" data-icon="" data-color="" aria-label="${tr('profile_avatar_use_initial')}">Aa</button>
            ${PROFILE_AVATARS.map(a => `<button type="button" class="profile-avatar-tile${(a.icon===avatarIcon && !user.photoData)?' active':''}" data-icon="${a.icon}" data-color="${a.color}" style="background:${a.color}" aria-label="avatar"><i class="fa-solid fa-${a.icon}"></i></button>`).join('')}
          </div>
          <div class="profile-photo-remove-row" id="profilePhotoRemoveRow" style="${user.photoData ? '' : 'display:none;'}">
            <button type="button" id="profilePhotoRemoveBtn"><i class="fa-solid fa-trash"></i> ${tr('profile_avatar_remove_photo')}</button>
          </div>

          <div class="profile-field-label" style="margin-top:4px;">${tr('profile_initial_color')}</div>
          <div class="profile-color-swatches">
            ${PROFILE_AVATAR_COLORS.map(c => `<button type="button" class="profile-color-dot${(c===avatarColor && !avatarIcon && !user.photoData)?' active':''}" data-color="${c}" style="background:${c}" aria-label="avatar color"></button>`).join('')}
          </div>
        </div>

        <label class="profile-field-label" for="profName">${tr('profile_field_name')}</label>
        <input class="auth-field" id="profName" type="text" value="${escapeHtml(user.name||'')}" placeholder="${tr('profile_field_name')}">

        <label class="profile-field-label" for="profPosition">${tr('profile_field_position')}</label>
        <input class="auth-field" id="profPosition" type="text" value="${escapeHtml(user.position||'')}" placeholder="${tr('profile_field_position_ph')}">

        <label class="profile-field-label" for="profEmail">${tr('profile_field_email')}</label>
        <input class="auth-field" id="profEmail" type="text" value="${escapeHtml(user.email||'')}" disabled>

        <label class="profile-field-label" for="profPhone">${tr('profile_field_phone')}</label>
        <input class="auth-field" id="profPhone" type="tel" value="${escapeHtml(user.phone||'')}" placeholder="${tr('profile_field_phone_ph')}">

        <label class="profile-field-label" for="profDistrict">${tr('profile_field_district')}</label>
        <input class="auth-field" id="profDistrict" type="text" value="${escapeHtml(user.district||'')}" placeholder="${tr('profile_field_district_ph')}">

        <label class="profile-field-label" for="profBirthDate">${tr('profile_field_birthdate')}</label>
        <input class="auth-field" id="profBirthDate" type="date" value="${escapeHtml(user.birthDate||'')}">

        <label class="profile-field-label" for="profBio">${tr('profile_field_bio')}</label>
        <textarea class="auth-field" id="profBio" rows="3" placeholder="${tr('profile_field_bio_ph')}">${escapeHtml(user.bio||'')}</textarea>

        <label class="profile-field-label" for="profQari">${tr('profile_field_qari')}</label>
        <input class="auth-field" id="profQari" type="text" value="${escapeHtml(user.favoriteQari||'')}" placeholder="${tr('profile_field_qari_ph')}">

        <label class="profile-field-label" for="profSurah">${tr('profile_field_surah')}</label>
        <input class="auth-field" id="profSurah" type="text" value="${escapeHtml(user.favoriteSurah||'')}" placeholder="${tr('profile_field_surah_ph')}">

        <div class="profile-error" id="profError"></div>
        <div class="profile-edit-btn-row">
          <button type="button" class="settings-btn profile-action-btn" id="profCancelBtn">${tr('profile_cancel')}</button>
          <button class="auth-cta-btn profile-save-btn" id="profSaveBtn"><span id="profSaveBtnLabel">${tr('profile_save')}</span></button>
        </div>
      </div>

      <!-- ---- Stats ---- -->
      <div class="section-title-sm">${tr('profile_stats_title')}</div>
      <div class="profile-stats-grid">
        <div class="profile-stat-box">
          <div class="profile-stat-icon"><i class="fa-solid fa-award"></i></div>
          <div class="profile-stat-val"><span id="statBadges">${localNum(0)}</span>/${localNum(badgeTotal)}</div>
          <div class="profile-stat-lbl">${tr('profile_stat_badges')}</div>
        </div>
        <div class="profile-stat-box">
          <div class="profile-stat-icon"><i class="fa-solid fa-fire"></i></div>
          <div class="profile-stat-val"><span id="statStreak">${localNum(0)}</span></div>
          <div class="profile-stat-lbl">${tr('profile_stat_streak')}</div>
        </div>
        <div class="profile-stat-box">
          <div class="profile-stat-icon"><i class="fa-solid fa-book-quran"></i></div>
          <div class="profile-stat-val"><span id="statAyah">${localNum(0)}</span></div>
          <div class="profile-stat-lbl">${tr('profile_stat_ayah')}</div>
        </div>
      </div>

      <!-- ---- Mini badge showcase ---- -->
      ${topBadges.length ? `
      <div class="badges-head">
        <span>${tr('profile_badges_title')}</span>
        <a href="javascript:void(0)" id="profSeeAllBadges">${tr('profile_badges_seeall')}</a>
      </div>
      <div class="badges-grid">${topBadges.map(badgeCardHtml).join('')}</div>` : ''}

      <!-- ---- Mini activity heatmap ---- -->
      ${renderMiniHeatmap(activity)}

      <div class="section-title-sm">${tr('profile_account_info_title')}</div>
      <div class="profile-meta-box">
        <div class="profile-meta-row">
          <div class="profile-meta-text">
            <span class="profile-meta-label">${tr('profile_uid_label')}</span>
            <code class="profile-meta-value">${escapeHtml(user.uid)}</code>
          </div>
          <button type="button" class="profile-copy-btn" id="profUidCopy" aria-label="${tr('profile_uid_copy_aria')}"><i class="fa-regular fa-copy"></i></button>
        </div>
        <div class="profile-meta-row">
          <div class="profile-meta-text">
            <span class="profile-meta-label">${tr('profile_server_label')}</span>
            <code class="profile-meta-value">${escapeHtml(window.location.host)}</code>
          </div>
          <button type="button" class="profile-copy-btn" id="profServerCopy" aria-label="${tr('profile_server_copy_aria')}"><i class="fa-regular fa-copy"></i></button>
        </div>
      </div>

      <div class="section-title-sm">${tr('profile_linked_title')}</div>
      <button type="button" class="profile-link-account-btn" id="profOpenLinkAccounts">
        <span class="profile-link-account-icon"><i class="fa-solid fa-link"></i></span>
        <span class="profile-link-account-text">
          <span class="profile-link-account-title">${tr('profile_link_account_title')}</span>
          <span class="profile-link-account-sub" id="profLinkAccountsSub">${linkedAccountCount ? `${localNum(linkedAccountCount)} ${tr('profile_link_sub_count_suffix')}` : tr('profile_link_sub_none')}</span>
        </span>
        <span class="profile-link-account-chevron"><i class="fa-solid fa-chevron-right"></i></span>
      </button>

      <div class="section-title-sm">${tr('profile_security_title')}</div>
      <div class="profile-actions">
        ${isPasswordUser ? `<button class="settings-btn profile-action-btn" id="profChangePass"><i class="fa-solid fa-key"></i><span>${tr('profile_change_password')}</span></button>` : ''}
        <button class="settings-btn profile-action-btn" id="profMfaBtn"><i class="fa-solid fa-shield-halved"></i><span>টু-ফ্যাক্টর অথেনটিকেশন</span>${user.mfa && user.mfa.enabled ? `<span class="mfa-status-pill is-on" style="margin-left:auto;"><i class="fa-solid fa-check"></i></span>${(user.mfa.method === 'totp' && (user.mfa.backupCodeHashes || []).length <= 2) ? '<span class="mfa-low-dot" title="ব্যাকআপ কোড কমে গেছে"></span>' : ''}` : ''}</button>
        <button class="settings-btn profile-action-btn" id="profLoginHistoryBtn"><i class="fa-solid fa-clock-rotate-left"></i><span>${tr('profile_login_history')}</span></button>
        <button class="settings-btn profile-action-btn" id="profLogoutBtn"><i class="fa-solid fa-right-from-bracket"></i><span>${tr('profile_logout')}</span></button>
      </div>

      <div class="profile-danger-zone">
        <div class="profile-danger-zone-title"><i class="fa-solid fa-triangle-exclamation"></i> ${tr('profile_danger_zone')}</div>
        <p class="profile-danger-zone-desc">${tr('profile_danger_desc')}</p>
        <button class="settings-btn profile-action-btn profile-action-danger" id="profDeleteBtn"><i class="fa-solid fa-trash"></i><span>${tr('profile_delete_account')}</span></button>
      </div>
    </div>`;
}

// প্রোফাইল ছবি Firestore-এর একটা ডকুমেন্ট-ফিল্ডে (base64 data URL হিসেবে) সেভ
// হয়, আর একটা Firestore ডকুমেন্টের মোট সাইজ-সীমা ~1MB — তাই সাধারণ কম্প্রেসের
// (480px/86%) পরও কোনো খুব ডিটেইলড/জটিল ছবি বড় থেকে গেলে, ধাপে ধাপে আরও ছোট
// করে দেখা হয়, যতক্ষণ না নিরাপদ সাইজে আসে। compressImageFile() (js/status.js)
// অপরিবর্তিত রেখে এটা তার উপরে একটা পাতলা wrapper — শুধু প্রোফাইল ছবির জন্যই
// এই অতিরিক্ত নিরাপত্তা প্রয়োজন (স্ট্যাটাস/স্টোরির ছবি IndexedDB-তে যায়, এই
// সীমার আওতায় পড়ে না)।
async function compressProfilePhoto(file){
  const ATTEMPTS = [
    { maxDim: 480, quality: 0.86 },
    { maxDim: 400, quality: 0.75 },
    { maxDim: 320, quality: 0.7 },
    { maxDim: 256, quality: 0.6 }
  ];
  const MAX_BYTES = 700 * 1024; // Firestore ডকুমেন্টে বাকি সব ফিল্ডের জন্য যথেষ্ট জায়গা রেখে
  let last = null;
  for(const { maxDim, quality } of ATTEMPTS){
    last = await compressImageFile(file, maxDim, quality);
    const approxBytes = (last.length - last.indexOf(',') - 1) * 0.75; // base64 → বাইট আনুমানিক হিসাব
    if(approxBytes <= MAX_BYTES) return last;
  }
  return last; // সব চেষ্টার পরও বড় থাকলে, সবচেয়ে ছোট ভার্সনটাই ফেরত
}

function wireProfileContent(user){
  const root = document.getElementById('profileViewContainer');
  if(!root) return;
  const avatarColor = user.avatarColor || PROFILE_AVATAR_COLORS[0];
  const avatarIcon = (user.avatarIcon && isKnownAvatarIcon(user.avatarIcon)) ? user.avatarIcon : '';
  const badgeUnlocked = (typeof unlockedBadgesCount === 'function') ? unlockedBadgesCount() : 0;
  const activity = (typeof loadActivity === 'function') ? loadActivity() : {};
  const streak = (typeof computeStreak === 'function') ? computeStreak(activity) : 0;
  const bestStreak = Math.max(state.bestStreak||0, streak);
  const ayahCount = (typeof ayahsReadCount === 'function') ? ayahsReadCount() : 0;
  const completion = profileCompletionPct(user, avatarIcon);

  // ---- Micro-interaction: animate stat numbers + completion bar in ----
  requestAnimationFrame(() => {
    animateCountUp(document.getElementById('statBadges'), badgeUnlocked);
    animateCountUp(document.getElementById('statStreak'), bestStreak);
    animateCountUp(document.getElementById('statAyah'), ayahCount);
    const fill = document.getElementById('completionFill');
    if(fill) setTimeout(() => { fill.style.width = completion + '%'; }, 60);
  });

  // ---- View <-> edit mode toggle ----
  const viewCard = document.getElementById('profileViewCard');
  const editForm = document.getElementById('profileEditForm');
  const editToggleBtn = document.getElementById('profEditToggleBtn');
  const heroNameEl = document.getElementById('viewHeroName');
  const heroPositionEl = document.getElementById('viewHeroPosition');
  const setEditMode = (on) => {
    editForm.style.display = on ? 'block' : 'none';
    viewCard.style.display = on ? 'none' : 'block';
    editToggleBtn.style.display = on ? 'none' : 'flex';
  };
  editToggleBtn.onclick = () => setEditMode(true);

  const cancelBtn = document.getElementById('profCancelBtn');
  if(cancelBtn) cancelBtn.onclick = () => setEditMode(false);

  const avatarToggleBtn = document.getElementById('avatarToggle');
  const avatarGridWrap = document.getElementById('avatarGridWrap');
  const avatarPreviewEl = document.getElementById('profileAvatarPreview');
  const setAvatarGridOpen = (open) => {
    avatarGridWrap.classList.toggle('open', open);
    avatarToggleBtn.classList.toggle('open', open);
    avatarToggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  setAvatarGridOpen(false);
  avatarToggleBtn.onclick = () => setAvatarGridOpen(!avatarGridWrap.classList.contains('open'));
  if(avatarPreviewEl){
    avatarPreviewEl.style.cursor = 'pointer';
    avatarPreviewEl.onclick = () => { setEditMode(true); setAvatarGridOpen(true); };
  }

  let pickedColor = avatarColor;
  let pickedIcon = avatarIcon;
  let pickedPhotoData = user.photoData || null;

  const photoTile = document.getElementById('avatarPhotoTile');
  const photoInput = document.getElementById('profilePhotoInput');
  const photoRemoveRow = document.getElementById('profilePhotoRemoveRow');

  // src দিয়ে হিরো অ্যাভাটার + এভাটার-গ্রিডের ফটো-টাইল, দুই জায়গাতেই একসাথে
  // ছবিটা বসায় — যেখানেই তাকান, ঠিক যে ছবিটা বেছেছেন সেটাই দেখা যায়।
  const setPreviewImage = (src) => {
    const preview = document.getElementById('profileAvatarPreview');
    if(preview){
      preview.style.backgroundImage = `url('${src}')`;
      preview.style.backgroundSize = 'cover';
      preview.style.backgroundPosition = 'center';
      preview.style.background = '';
      preview.innerHTML = '';
    }
    if(photoTile){ photoTile.style.backgroundImage = `url('${src}')`; photoTile.classList.add('has-photo'); }
  };

  const updatePreview = () => {
    const preview = document.getElementById('profileAvatarPreview');
    if(!preview) return;
    if(pickedPhotoData){
      setPreviewImage(pickedPhotoData);
    } else {
      preview.style.backgroundImage = '';
      preview.style.background = pickedColor;
      preview.innerHTML = pickedIcon
        ? `<i class="fa-solid fa-${pickedIcon}"></i>`
        : escapeHtml((user.name || user.email || '?').trim().charAt(0).toUpperCase());
      if(photoTile){ photoTile.style.backgroundImage = ''; photoTile.classList.remove('has-photo'); }
    }
  };

  const bouncePreview = () => {
    const preview = document.getElementById('profileAvatarPreview');
    if(!preview) return;
    preview.classList.remove('avatar-pop');
    void preview.offsetWidth;
    preview.classList.add('avatar-pop');
  };

  const setTileActiveStates = (activeBtn) => {
    root.querySelectorAll('.profile-avatar-tile').forEach(b => b.classList.toggle('active', b === activeBtn));
    root.querySelectorAll('.profile-color-dot').forEach(b => b.classList.remove('active'));
  };
  const clearPhoto = () => {
    pickedPhotoData = null;
    if(photoRemoveRow) photoRemoveRow.style.display = 'none';
    if(photoTile){ photoTile.classList.remove('active', 'has-photo'); photoTile.style.backgroundImage = ''; }
  };

  if(photoInput){
    // কম্প্রেস শেষ হওয়ার আগেই বাছাই করা ছবিটা তাৎক্ষণিকভাবে দেখানোর জন্য
    // অস্থায়ী object URL — চূড়ান্ত কম্প্রেসড ভার্সন বসানোর সাথে সাথেই নিচে
    // revoke করে মেমোরি ফাঁকা করে দেওয়া হয়।
    let tempPreviewUrl = null;
    const releaseTempPreview = () => { if(tempPreviewUrl){ URL.revokeObjectURL(tempPreviewUrl); tempPreviewUrl = null; } };

    photoInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if(!file) return;
      if(!file.type || file.type.indexOf('image/') !== 0){ showToast('একটি ছবি বাছুন'); return; }
      if(file.size > 25 * 1024 * 1024){ showToast('ছবিটি অনেক বড়, একটু ছোট ছবি বাছুন'); return; }

      releaseTempPreview();
      tempPreviewUrl = URL.createObjectURL(file);
      pickedIcon = '';
      setPreviewImage(tempPreviewUrl); // ধাপ ১: তাৎক্ষণিক প্রিভিউ, কম্প্রেস শেষ হওয়ার আগেই
      if(photoTile) photoTile.classList.add('loading');
      try{
        // EXIF অনুযায়ী সঠিক দিকে ঘোরানো + Firestore-এ নির্বিঘ্নে সেভ হওয়ার
        // মতো ছোট সাইজ — দুটোই নিশ্চিত করে (js/status.js + উপরের wrapper)।
        const dataUrl = await compressProfilePhoto(file);
        pickedPhotoData = dataUrl;
        setTileActiveStates(photoTile);
        if(photoTile) photoTile.classList.add('active');
        if(photoRemoveRow) photoRemoveRow.style.display = 'flex';
        setPreviewImage(dataUrl); // ধাপ ২: চূড়ান্ত কম্প্রেসড ভার্সনে বদলে ফেলা — এটাই সেভ হবে
        bouncePreview();
      }catch(err){
        console.warn('profile photo compress failed:', err);
        showToast('ছবি প্রসেস করা যায়নি');
        pickedPhotoData = user.photoData || null; // ব্যর্থ হলে আগের অবস্থাতেই ফিরিয়ে নেওয়া
        updatePreview();
      }finally{
        if(photoTile) photoTile.classList.remove('loading');
        releaseTempPreview();
      }
    });
  }
  if(document.getElementById('profilePhotoRemoveBtn')){
    document.getElementById('profilePhotoRemoveBtn').onclick = () => {
      clearPhoto();
      // Falls back to whatever icon/colour was picked before the photo —
      // still the user's own real name-initial style, not a jarring reset.
      const noneTile = root.querySelector('.profile-avatar-tile.none-tile');
      setTileActiveStates(pickedIcon ? root.querySelector(`.profile-avatar-tile[data-icon="${pickedIcon}"]`) : noneTile);
      updatePreview();
      bouncePreview();
    };
  }

  const cameraBadge = document.getElementById('profileHeroCameraBadge');
  if(cameraBadge){
    cameraBadge.onclick = (e) => {
      e.stopPropagation();
      setEditMode(true);
      setAvatarGridOpen(true);
      if(photoInput) photoInput.click();
    };
  }

  root.querySelectorAll('.profile-color-dot').forEach(btn => {
    btn.onclick = () => {
      pickedColor = btn.getAttribute('data-color');
      pickedIcon = '';
      clearPhoto();
      root.querySelectorAll('.profile-color-dot').forEach(b => b.classList.toggle('active', b === btn));
      root.querySelectorAll('.profile-avatar-tile').forEach(b => b.classList.toggle('active', b.classList.contains('none-tile')));
      updatePreview();
      bouncePreview();
    };
  });

  // The photo tile is excluded here — it's wired above via its own file
  // input change handler, not this generic icon/initial picker.
  root.querySelectorAll('.profile-avatar-tile').forEach(btn => {
    if(btn === photoTile) return;
    btn.onclick = () => {
      pickedIcon = btn.getAttribute('data-icon') || '';
      const color = btn.getAttribute('data-color');
      if(color) pickedColor = color;
      clearPhoto();
      root.querySelectorAll('.profile-avatar-tile').forEach(b => b.classList.toggle('active', b === btn));
      if(pickedIcon){
        root.querySelectorAll('.profile-color-dot').forEach(b => b.classList.remove('active'));
      }
      updatePreview();
      bouncePreview();
    };
  });

  const nameInput = document.getElementById('profName');
  const positionInput = document.getElementById('profPosition');
  if(nameInput) nameInput.oninput = () => { heroNameEl.textContent = nameInput.value.trim() || (user.email||''); };
  if(positionInput) positionInput.oninput = () => {
    const v = positionInput.value.trim();
    heroPositionEl.textContent = v;
    heroPositionEl.style.display = v ? '' : 'none';
  };
  ['profPhone','profDistrict','profBirthDate','profBio','profQari','profSurah'].forEach(id => {
    const el = document.getElementById(id);
    if(!el) return;
    el.addEventListener('input', () => {
      const draft = {
        bio: document.getElementById('profBio').value,
        position: positionInput.value,
        phone: document.getElementById('profPhone').value,
        district: document.getElementById('profDistrict').value,
        birthDate: document.getElementById('profBirthDate').value,
        favoriteQari: document.getElementById('profQari').value,
        favoriteSurah: document.getElementById('profSurah').value
      };
      const pct = profileCompletionPct(draft, pickedIcon);
      const fill = document.getElementById('completionFill');
      const pctText = document.getElementById('completionPctText');
      if(fill) fill.style.width = pct + '%';
      if(pctText) pctText.textContent = localNum(pct) + '%';
    });
  });

  document.getElementById('profSaveBtn').onclick = async () => {
    const name = document.getElementById('profName').value.trim();
    const position = document.getElementById('profPosition').value.trim();
    const phone = document.getElementById('profPhone').value.trim();
    const district = document.getElementById('profDistrict').value.trim();
    const birthDate = document.getElementById('profBirthDate').value;
    const bio = document.getElementById('profBio').value.trim();
    const favoriteQari = document.getElementById('profQari').value.trim();
    const favoriteSurah = document.getElementById('profSurah').value.trim();
    const errBox = document.getElementById('profError');
    errBox.textContent = '';
    if(!name){ errBox.textContent = tr('profile_name_required'); return; }

    const btn = document.getElementById('profSaveBtn');
    const label = document.getElementById('profSaveBtnLabel');
    btn.disabled = true; label.textContent = tr('profile_saving');
    try{
      await saveProfileChanges({ name, position, avatarColor: pickedColor, avatarIcon: pickedIcon, photoData: pickedPhotoData, phone, district, birthDate, bio, favoriteQari, favoriteSurah });
      // Success micro-interaction: swap the button to a checkmark for a
      // beat, then drop back to view mode — no modal to close anymore.
      btn.classList.add('profile-save-success');
      label.innerHTML = `<i class="fa-solid fa-check"></i> ${tr('profile_saved')}`;
      showToast(tr('profile_updated_toast'));
      setTimeout(() => {
        btn.classList.remove('profile-save-success');
        btn.disabled = false; label.textContent = tr('profile_save');
        setEditMode(false);
      }, 650);
    }catch(e){
      errBox.textContent = (e && typeof e.message === 'string' && e.message.startsWith('restricted:'))
        ? e.message.slice('restricted:'.length).trim()
        : tr('profile_save_error');
      btn.disabled = false; label.textContent = tr('profile_save');
    }
  };

  const seeAllBadgesBtn = document.getElementById('profSeeAllBadges');
  if(seeAllBadgesBtn) seeAllBadgesBtn.onclick = () => { if(typeof openAllBadgesModal === 'function') openAllBadgesModal(); };

  if(typeof renderStatusHighlightsRow === 'function') renderStatusHighlightsRow();

  const changePassBtn = document.getElementById('profChangePass');
  if(changePassBtn) changePassBtn.onclick = () => confirmPasswordChange(user);

  const mfaBtn = document.getElementById('profMfaBtn');
  if(mfaBtn) mfaBtn.onclick = () => { if(typeof openMfaSettingsModal === 'function') openMfaSettingsModal(user); };

  const uidCopyBtn = document.getElementById('profUidCopy');
  if(uidCopyBtn) uidCopyBtn.onclick = () => copyProfileValue(user.uid, uidCopyBtn);

  const serverCopyBtn = document.getElementById('profServerCopy');
  if(serverCopyBtn) serverCopyBtn.onclick = () => copyProfileValue(window.location.host, serverCopyBtn);

  const openLinkAccountsBtn = document.getElementById('profOpenLinkAccounts');
  if(openLinkAccountsBtn) openLinkAccountsBtn.onclick = () => openLinkAccountsModal();

  const loginHistoryBtn = document.getElementById('profLoginHistoryBtn');
  if(loginHistoryBtn) loginHistoryBtn.onclick = () => { if(typeof openSessionHistoryModal === 'function') openSessionHistoryModal(); };

  document.getElementById('profLogoutBtn').onclick = () => confirmLogout();
  document.getElementById('profDeleteBtn').onclick = () => confirmDeleteAccount();
}
