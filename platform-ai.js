'use strict';
/* Founder console: AI usage & estimated spend.
 *
 * Loaded by platform.html after platform.js. Renders on demand when the
 * "AI usage" view opens (showView calls window.loadAIUsageView). No chart
 * library — daily bars are plain divs so the view stays cheap and offline
 * of any CDN.
 */
(function () {
  const FEATURE_LABELS = {
    'daily-extract': 'Daily report extraction',
    'estimate-import': 'Estimate import (PDF)',
    'ticket-scan': 'Sub ticket scan',
    'template-draft': 'Template drafting',
    'assistant-proposal': 'Assistant proposals'
  };
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (micro) => {
    if (micro == null) return 'cost unknown';
    const dollars = Math.round(micro) / 1e6;
    if (dollars === 0) return '$0.00';
    return dollars < 0.01 ? '$' + dollars.toFixed(4) : '$' + dollars.toFixed(2);
  };
  const tokens = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);
  const featureLabel = (key) => FEATURE_LABELS[key] || key;

  function metric(label, value, detail) {
    return `<div class="metric"><small>${esc(label)}</small><strong>${esc(value)}</strong><span>${esc(detail)}</span></div>`;
  }
  function bucketRow(name, bucket, extra = '') {
    return `<div class="row"><span><b>${esc(name)}</b><small>${tokens(bucket.input)} in · ${tokens(bucket.output)} out</small></span><span class="badge">${bucket.calls} call${bucket.calls === 1 ? '' : 's'}</span><b>${esc(bucket.unknownCost ? '≥ ' + money(bucket.cost) + ' (unpriced model)' : money(bucket.cost))}${extra}</b></div>`;
  }
  function bars(series) {
    const days = series.slice(-14);
    if (!days.length) return '';
    const max = Math.max(...days.map((d) => d.cost || 0), 1);
    return `<div style="display:grid;gap:7px;margin-top:10px">${days.map((d) => {
      const width = Math.max(4, Math.round((d.cost / max) * 100));
      const fill = d.unknownCost ? '#9da5a9' : '#ff6b1a';
      const label = d.unknownCost ? '≥ ' + money(d.cost) : money(d.cost);
      return `<div style="display:grid;grid-template-columns:86px 1fr 84px;align-items:center;gap:10px"><small style="color:#66717a">${esc(d.day.slice(5))}</small><div style="background:#eee;height:14px;border-radius:7px;overflow:hidden"><div style="background:${fill};height:100%;width:${width}%" title="${esc(label)}${d.unknownCost ? ' (unpriced model used)' : ''}"></div></div><small style="text-align:right;color:#66717a">${esc(label)}</small></div>`;
    }).join('')}</div>`;
  }
  function assistantBlock(assistant) {
    if (!assistant) return `<div class="empty-state"><b>Assistant ledger unavailable</b><span>The project assistant budget lives in the cloud (Supabase) namespace. It will appear here once that store responds.</span></div>`;
    if (!assistant.days.length) return `<div class="empty-state"><b>No assistant usage yet</b><span>The project assistant meter records spend here as companies use it. Kept ${assistant.retentionDays} days.</span></div>`;
    return assistant.days.map((day) => `<div class="row"><span><b>${esc(day.day)}</b><small>${day.companies.map((c) => `${esc(c.name)} (${c.calls})`).join(' · ') || 'No company detail'}</small></span><span class="badge">${day.calls} call${day.calls === 1 ? '' : 's'}</span><b>${esc(money(day.cost))}</b></div>`).join('');
  }
  function render(payload) {
    const content = $('#ai-content');
    if (!content) return;
    const { totals, byFeature, byCompany, series } = payload.features;
    const days30 = series.reduce((sum, d) => sum + (d.cost || 0), 0);
    const unknownNote = totals.unknownCost ? ' · some calls used an unpriced model' : '';
    const metrics = [
      metric('Est. spend · 30 days', money(days30), `${payload.model} · ${money(totals.cost)} all-time${unknownNote}`),
      metric('AI calls · all time', String(totals.calls), `${series.length} active day${series.length === 1 ? '' : 's'} in the last 30`),
      metric('Input tokens', tokens(totals.input), 'Prompts, PDFs, and notes sent to the model'),
      metric('Output tokens', tokens(totals.output), 'Drafts and structured JSON returned')
    ].join('');
    const featureRows = Object.entries(byFeature).sort((a, b) => b[1].cost - a[1].cost).map(([key, bucket]) => bucketRow(featureLabel(key), bucket)).join('')
      || '<div class="empty-state"><b>No metered AI calls yet</b><span>Usage appears here the first time an account runs extraction, estimate import, a ticket scan, or template drafting.</span></div>';
    const companyRows = Object.entries(byCompany).sort((a, b) => b[1].cost - a[1].cost).map(([, bucket]) => bucketRow(bucket.name || 'Unknown account', bucket)).join('')
      || '<div class="empty-state"><b>No account-level usage yet</b><span>Calls are attributed to the signed-in account, or to a guest link when one was used.</span></div>';
    const assistantRetention = payload.assistant?.retentionDays || 4;
    content.innerHTML = `
      <section class="metrics ai-metrics">${metrics}</section>
      <section class="grid">
        <article><div class="section-heading"><div><h2>By feature</h2><p>Where the model calls happen.</p></div></div>${featureRows}</article>
        <article><div class="section-heading"><div><h2>By account</h2><p>Spend attributed to each customer workspace.</p></div></div>${companyRows}</article>
      </section>
      <article style="margin-top:14px"><div class="section-heading"><div><h2>Daily spend · last 14 days</h2><p>Estimated model cost per day.</p></div></div>${bars(series) || '<div class="empty-state"><b>No daily usage yet</b><span>Daily bars appear once metered calls start landing.</span></div>'}</article>
      <article style="margin-top:14px"><div class="section-heading"><div><h2>Project assistant</h2><p>Authoritative cloud budget ledger · ${assistantRetention}-day retention.</p></div></div>${assistantBlock(payload.assistant)}</article>
      <p style="font-size:11px;margin-top:14px">Cost estimate: ${esc(payload.price.model)} at $${payload.price.input}/$${payload.price.output} per 1M input/output tokens — <a href="${esc(payload.price.source)}" target="_blank" rel="noopener">approved pricing source</a>. Integer microdollar math matches the assistant budget gate.</p>`;
  }
  async function refresh() {
    const content = $('#ai-content');
    if (!content) return;
    content.innerHTML = '<div class="empty-state"><b>Loading AI usage…</b></div>';
    try {
      const response = await fetch('/api/platform/ai-usage', { credentials: 'include', cache: 'no-store' });
      if (response.status === 401) { location.href = '/platform-login.html'; return; }
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not load AI usage');
      render(payload);
    } catch (error) {
      content.innerHTML = `<div class="empty-state"><b>AI usage did not load</b><span>${esc(error.message)}</span></div>`;
    }
  }
  window.loadAIUsageView = refresh;
  document.addEventListener('click', (event) => { if (event.target?.closest('#ai-refresh')) refresh(); });
})();
