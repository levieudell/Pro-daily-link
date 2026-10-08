(function(root) {
  'use strict';
  const pages = { '/': 'Home', '/landing.html': 'Home', '/about.html': 'About', '/blog.html': 'Field Notes', '/signup.html': 'Signup', '/privacy.html': 'Privacy', '/terms.html': 'Terms' };
  const consentKey = 'pdl-public-analytics-consent-v1';
  function safePage(href, config) {
    const url = new URL(href);
    if (!Object.hasOwn(pages, url.pathname) || !config.hosts.includes(url.hostname) || url.protocol !== 'https:') return null;
    const safe = new URL(url.origin + url.pathname);
    // Campaign values need explicit review for attribution. Unreviewed UTM values
    // are discarded, so a consenting public visit can still count canonically.
    // Other unknown/private query values suppress the entire visit.
    for (const [key, value] of url.searchParams) {
      if (key === 'plan' && ['starter', 'growth', 'pro'].includes(value)) continue;
      if (url.pathname === '/blog.html' && key === 'post' && config.blogSlugs?.includes(value)) { safe.searchParams.set(key, value); continue; }
      if (/^utm_(source|medium|campaign|term|content)$/.test(key)) {
        if (config.campaignValues[key]?.includes(value)) safe.searchParams.set(key, value);
        continue;
      }
      return null;
    }
    if (url.hash && !['#how', '#demo', '#features', '#pricing', '#faq', '#book-demo', '#onboarding'].includes(url.hash)) return null;
    return { location: safe.href, title: pages[url.pathname] };
  }
  function safeReferrer(value) {
    try { const url = new URL(value); return /^https?:$/.test(url.protocol) ? url.origin + '/' : ''; } catch { return ''; }
  }
  function campaignLink(current, target, config) {
    const page = safePage(current, config), link = new URL(target, current);
    if (!page || link.origin !== new URL(current).origin || link.pathname !== '/signup.html') return target;
    const campaign = new URL(page.location).searchParams;
    for (const [key, value] of campaign) if (key.startsWith('utm_') && !link.searchParams.has(key)) link.searchParams.set(key, value);
    return link.href;
  }
  if (typeof module !== 'undefined' && module.exports) { module.exports = { safePage, safeReferrer, campaignLink, pages }; return; }
  const config = root.PDL_PUBLIC_ANALYTICS;
  if (!config?.enabled || !/^G-[A-Z0-9]+$/.test(config.measurementId) || root.__pdlPublicAnalytics) return;
  root.__pdlPublicAnalytics = true;
  const doc = root.document, nav = root.navigator;
  let loaded = false, lastPage = '', choice = '';
  const optedOut = () => nav.globalPrivacyControl === true || nav.doNotTrack === '1' || root.doNotTrack === '1';
  const privateSession = () => /(?:^|;\s*)pdl_company=/.test(doc.cookie);
  const eligible = () => !optedOut() && !privateSession() && safePage(root.location.href, config);
  try { choice = root.localStorage.getItem(consentKey) || ''; } catch { /* No storage means ask on each page. */ }
  if (!eligible()) return;
  function tag() { root.dataLayer.push(arguments); }
  function view() {
    const page = eligible();
    if (choice !== 'accepted' || !page) { root['ga-disable-' + config.measurementId] = true; return; }
    root['ga-disable-' + config.measurementId] = false;
    // Update actual hrefs so keyboard, middle-click and context-menu opens work too.
    for (const link of doc.querySelectorAll('a[href]')) link.href = campaignLink(root.location.href, link.href, config);
    if (!loaded) {
      loaded = true; root.dataLayer = root.dataLayer || [];
      tag('consent', 'default', { analytics_storage: 'denied', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' });
      tag('consent', 'update', { analytics_storage: 'granted' });
      tag('js', new Date());
      tag('config', config.measurementId, { send_page_view: false, allow_google_signals: false, allow_ad_personalization_signals: false, cookie_expires: 2592000, cookie_update: false, page_location: page.location, page_title: page.title, page_referrer: safeReferrer(doc.referrer) });
      const script = doc.createElement('script'); script.async = true; script.referrerPolicy = 'no-referrer';
      script.src = 'https://www.googletagmanager.com/gtag/js?id=' + config.measurementId;
      doc.head.appendChild(script);
    }
    if (lastPage === page.location) return;
    tag('set', { page_location: page.location, page_title: page.title, page_referrer: safeReferrer(doc.referrer) });
    tag('event', 'page_view', { send_to: config.measurementId, page_location: page.location, page_title: page.title, page_referrer: safeReferrer(doc.referrer) });
    lastPage = page.location;
  }
  function clearCookies() {
    for (const cookie of doc.cookie.split(';')) {
      const name = cookie.trim().split('=')[0];
      if (!/^_ga(?:_|$)/.test(name)) continue;
      const parts = root.location.hostname.split('.');
      doc.cookie = name + '=; Max-Age=0; Path=/';
      for (let i = 0; i < parts.length - 1; i++) doc.cookie = name + '=; Max-Age=0; Path=/; Domain=.' + parts.slice(i).join('.');
    }
  }
  const panel = doc.createElement('section'); panel.className = 'pdl-analytics-consent'; panel.setAttribute('aria-label', 'Optional website analytics');
  panel.innerHTML = '<p>Allow optional Google Analytics on public pages and signup? It measures visits, pages, referral sources, approved campaign labels and approximate location. Private workspaces and form entries are excluded. <a href="/privacy.html">Privacy details</a></p><button type="button" data-choice="accepted">Allow analytics</button> <button type="button" data-choice="declined">Decline analytics</button>';
  const settings = doc.createElement('button'); settings.type = 'button'; settings.className = 'pdl-analytics-settings'; settings.textContent = 'Analytics preferences';
  settings.onclick = () => { panel.hidden = false; };
  panel.onclick = event => {
    const value = event.target.dataset.choice; if (!value) return;
    choice = value;
    try { root.localStorage.setItem(consentKey, choice); } catch { }
    panel.hidden = true;
    if (choice === 'declined') { root['ga-disable-' + config.measurementId] = true; clearCookies(); root.location.reload(); return; }
    view();
  };
  panel.hidden = Boolean(choice); doc.body.append(panel, settings);
  root.addEventListener('storage', event => { if (event.key === consentKey) { root['ga-disable-' + config.measurementId] = true; root.location.reload(); } });
  for (const method of ['pushState', 'replaceState']) {
    const original = root.history[method];
    root.history[method] = function(...args) { const result = original.apply(this, args); view(); return result; };
  }
  root.addEventListener('popstate', view); root.addEventListener('hashchange', view);
  doc.addEventListener('click', event => {
    const link = event.target.closest('a[href]');
    if (link && choice === 'accepted' && eligible()) link.href = campaignLink(root.location.href, link.href, config);
  });
  view();
})(typeof window === 'undefined' ? globalThis : window);
