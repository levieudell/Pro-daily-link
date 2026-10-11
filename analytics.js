// HeyCatch analytics — consent-first client loader.
//
// Privacy posture (owner-approved after review):
// - This file is included on PUBLIC pages only. The signed-in app
//   (index.html) and subcontractor guest access (guest.html) never load it.
// - Trackers initialize only after the visitor explicitly accepts.
// - No identity is ever set client-side: no names, no emails, no user IDs.
//   Server-side billing lifecycle events (plan changes, invoices) are
//   disclosed in privacy.html.
// The project key is publishable by design.
const PDL_ANALYTICS_PROJECT_KEY = 'hck_pk_Ytw7NVIoMAahVhRRPN0UCxwmyuLEo70-';
const PDL_FACEBOOK_PIXEL_ID = '2581023075730326';
const CONSENT_KEY = 'pdl-analytics-consent';

async function startAnalytics() {
  if (window.PDLAnalytics) return window.PDLAnalytics;
  const { analytics } = await import('https://esm.sh/@heycatch/sdk@0.8.3');
  analytics.init({
    projectKey: PDL_ANALYTICS_PROJECT_KEY,
    install: { framework: 'web', agent: 'other' },
  });
  window.PDLAnalytics = analytics;
  return analytics;
}

// Meta (Facebook) ad-measurement pixel — same consent gate and public-pages
// only rule as HeyCatch. Loads after acceptance, never identifies anyone,
// and is disclosed in privacy.html.
function startFacebookPixel() {
  if (window.fbq) return;
  !function(f, b, e, v, n, t, s) {
    if (f.fbq) return;
    n = f.fbq = function() { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
    if (!f._fbq) f._fbq = n;
    n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
    t = b.createElement(e); t.async = !0; t.src = v;
    s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
  }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
  window.fbq('init', PDL_FACEBOOK_PIXEL_ID);
  window.fbq('track', 'PageView');
}

function readConsent() {
  try { return localStorage.getItem(CONSENT_KEY); } catch { return null; }
}

function writeConsent(value) {
  try { localStorage.setItem(CONSENT_KEY, value); } catch { /* storage blocked — banner simply won't persist */ }
}

function showConsentBanner() {
  if (document.getElementById('pdl-consent-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'pdl-consent-banner';
  banner.setAttribute('role', 'dialog');
  banner.setAttribute('aria-label', 'Analytics consent');
  banner.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:99999;display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;justify-content:center;padding:14px 18px;border-radius:12px;background:#10251e;color:#f4f2ec;font:14px/1.45 "DM Sans",Arial,sans-serif;box-shadow:0 10px 32px rgba(0,0,0,.35)';
  const text = document.createElement('span');
  text.style.cssText = 'flex:1 1 280px;max-width:560px';
  text.innerHTML = 'We use privacy-friendly analytics and Meta&#39;s ad measurement pixel to understand how this site is used and to measure our ads. No personal details are collected — nothing is ever taken from your account. <a href="/privacy.html" style="color:#ffd9a8">Privacy policy</a>';
  const accept = document.createElement('button');
  accept.type = 'button';
  accept.textContent = 'Accept';
  accept.style.cssText = 'min-height:40px;padding:8px 18px;border:0;border-radius:8px;background:#ff6b1a;color:#fff;font:600 14px "DM Sans",Arial,sans-serif;cursor:pointer';
  const decline = document.createElement('button');
  decline.type = 'button';
  decline.textContent = 'Decline';
  decline.style.cssText = 'min-height:40px;padding:8px 18px;border:1px solid #4a5f56;border-radius:8px;background:transparent;color:#f4f2ec;font:600 14px "DM Sans",Arial,sans-serif;cursor:pointer';
  accept.onclick = () => { writeConsent('accepted'); banner.remove(); startAnalytics().catch(() => {}); startFacebookPixel(); };
  decline.onclick = () => { writeConsent('declined'); banner.remove(); };
  banner.append(text, accept, decline);
  (document.body || document.documentElement).appendChild(banner);
}

const consent = readConsent();
if (consent === 'accepted') { startAnalytics().catch(() => {}); startFacebookPixel(); }
else if (consent !== 'declined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', showConsentBanner);
  else showConsentBanner();
}

export { startAnalytics };
