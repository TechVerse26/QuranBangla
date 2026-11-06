// ---------- Error logger (এডমিন কন্ট্রোল রুমের জন্য) ----------
// এই ফাইলটা মূল AlQuran অ্যাপে যোগ করতে হবে (js/ ফোল্ডারে রাখুন এবং
// index.html-এ firebase-config.js লোড হওয়ার পরে <script src="js/error-logger.js" defer></script>
// যোগ করুন)।
//
// কাজ: ব্রাউজারে যেকোনো JS এরর বা unhandled promise rejection ধরে ফেলে
// Firestore-এর `system_errors` কালেকশনে জমা করে। এডমিন প্যানেল সেটা
// রিয়েল-টাইমে দেখায় এবং লাল অ্যালার্ট মার্ক করে।
//
// প্রাইভেসি: কোনো ইউজারের নাম/ইমেইল পাঠানো হয় না — শুধু uid (যদি লগইন
// করা থাকে), এরর মেসেজ, স্ট্যাক, পেজ পাথ এবং ব্রাউজার তথ্য।

(function(){
  if(typeof fbDb === 'undefined'){
    console.warn('error-logger: fbDb পাওয়া যায়নি, firebase-config.js আগে লোড করুন');
    return;
  }

  const MAX_PER_SESSION = 20; // এক সেশনে সর্বোচ্চ কতগুলো এরর পাঠানো হবে (spam প্রতিরোধ)
  let sentCount = 0;
  const seenMessages = new Set(); // একই এরর বারবার পাঠানো বন্ধ করতে

  async function logError(message, stack, severity){
    try{
      if(sentCount >= MAX_PER_SESSION) return;
      const key = (message || '') + '|' + (stack || '').slice(0, 120);
      if(seenMessages.has(key)) return;
      seenMessages.add(key);
      sentCount++;

      await fbDb.collection('system_errors').add({
        message: String(message || 'অজানা এরর').slice(0, 500),
        stack: String(stack || '').slice(0, 2000),
        severity: severity || 'error',
        page: location.pathname + location.hash,
        userAgent: navigator.userAgent,
        uid: (typeof state !== 'undefined' && state.user) ? state.user.uid : null,
        resolved: false,
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
      });
    }catch(e){
      // এরর লগ করতে গিয়ে নিজেই ব্যর্থ হলে চুপচাপ থামুন — ইউজারকে বিরক্ত করবেন না
      console.warn('error-logger নিজেই ব্যর্থ হয়েছে:', e);
    }
  }

  window.addEventListener('error', (e) => {
    logError(e.message, e.error?.stack, 'error');
  });

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    logError(
      reason?.message || String(reason),
      reason?.stack,
      'error'
    );
  });

  // ম্যানুয়ালি কোথাও থেকে লগ করতে চাইলে: logAppError('বার্তা', 'warning')
  window.logAppError = (message, severity) => logError(message, new Error().stack, severity || 'warning');
})();
