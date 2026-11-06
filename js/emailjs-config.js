// ---------- EmailJS config (for OTP + login-alert emails) ----------
// Used to email a 6-digit verification code before two sensitive
// actions: changing the password and permanently deleting the account.
// Also used to email a "new login" security alert (see js/session-security.js)
// every time someone actually signs in (not on every page reload).
// Everything else in the app works fine even if this is left unconfigured
// (the "পরিবর্তন করুন" / "মুছে ফেলুন" buttons will just show a toast saying
// OTP isn't set up yet, and login alerts are silently skipped).
//
// ---------- One-time setup (free, ~5 minutes) ----------
// 1) Go to https://www.emailjs.com and create a free account.
// 2) Email Services → Add New Service → connect Gmail (or any provider).
//    Copy the "Service ID" it gives you → paste below as serviceId.
// 3) Email Templates → Create New Template. Don't use the default plain
//    text editor — click the "</>" (Code Editor) icon top-right, then
//    paste the full HTML from email-templates/otp-template.html (it's
//    already themed to match this app and uses the exact variable names
//    below). Subject line: {{purpose}} — যাচাইকরণ কোড
//      {{to_email}}   — recipient address
//      {{to_name}}    — recipient's name
//      {{otp_code}}   — the 6-digit code
//      {{purpose}}    — e.g. "পাসওয়ার্ড পরিবর্তন" or "অ্যাকাউন্ট মুছে ফেলা"
//    Copy the "Template ID" → paste below as templateId.
// 4) Account → General → copy your "Public Key" → paste below as publicKey.
// 5) Save this file, redeploy. That's it — no server, no Cloud Functions.
//
// ---------- Second template: login-alert emails (optional but recommended) ----------
// 1) Email Templates → Create New Template (a second, separate one from the OTP template).
//    Code Editor → paste the full HTML from email-templates/login-alert-template.html.
//    Subject line: নতুন লগইন সনাক্ত হয়েছে — কুরআন বাংলা
//      {{to_email}}         — recipient address
//      {{to_name}}          — recipient's name
//      {{device_text}}      — e.g. "Google Chrome · Android · মোবাইল"
//      {{location_text}}    — e.g. "Dhaka, Bangladesh" (IP-based, approximate)
//      {{isp_text}}         — IP-based ISP/network name (approximate — this is the
//                              closest a browser can get to "which SIM/operator";
//                              exact WiFi names or carrier names aren't accessible
//                              to any website, by browser design)
//      {{ip_text}}          — IP address
//      {{login_time}}       — when the login happened
//      {{new_device_text}}  — extra warning line, only filled in for a never-seen-before device
//      {{revoke_url}}       — one-click "log me out everywhere" link (opens the app,
//                              asks the person to sign in if needed, then instantly
//                              revokes every active session including this new one)
//    Copy the "Template ID" → paste below as loginAlertTemplateId.
// 2) Save this file, redeploy. If loginAlertTemplateId is left as "PASTE_YOUR..."
//    below, login-alert emails are simply skipped — nothing else breaks.
//
// PRIVACY NOTE: the public key is safe to ship in client code by design
// (that's how EmailJS works) — but EmailJS's free tier is rate-limited
// per month, and anyone with your service/template IDs could technically
// trigger sends. For a personal/small-app project this is an acceptable
// tradeoff, same as the rest of this app's client-only Firebase setup.

const EMAILJS_CONFIG = {
  publicKey: "xZa-M7wzLohf1ciYM",
  serviceId: "service_iop4lfq",
  templateId: "template_m8kjuwq",
  loginAlertTemplateId: "template_zogfyaz"
};
