/* Change order document — customer-facing approve-by-link page.
   Opens with ?c=<changeId>&t=<token>; the token is the only credential. */
(function(){
  'use strict';
  const host = document.getElementById('co-document');
  const params = new URLSearchParams(location.search);
  const token = params.get('t') || '';
  const money = value => '$' + (Number(value) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const date = iso => iso ? new Date(String(iso).length === 10 ? iso + 'T12:00:00' : iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '—';
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const lineTotal = line => (Number(line.materialCost) || 0);

  function statusBanner(doc){
    if (doc.status === 'Approved') return `<div class="banner ok">Approved by ${esc(doc.decidedBy)} on ${date(doc.decidedAt)}${doc.decisionNote ? ` — “${esc(doc.decisionNote)}”` : ''}</div>`;
    if (doc.status === 'Rejected') return `<div class="banner no">Declined by ${esc(doc.decidedBy)} on ${date(doc.decidedAt)}${doc.decisionNote ? ` — “${esc(doc.decisionNote)}”` : ''}</div>`;
    if (doc.status === 'Void') return '<div class="banner no">This change order was voided by the contractor.</div>';
    return '';
  }

  function decisionBlock(doc){
    if (!['Potential', 'Pricing', 'Submitted'].includes(doc.status)) {
      return `<section class="decision ${doc.status === 'Approved' ? 'approved' : doc.status === 'Rejected' ? 'declined' : ''}">
        <h2>Customer decision</h2>
        <p class="signature">${doc.status === 'Approved' ? 'Approved' : doc.status === 'Rejected' ? 'Declined' : esc(doc.status)} by <strong>${esc(doc.decidedBy || '—')}</strong> on ${date(doc.decidedAt)}</p>
        ${doc.decisionNote ? `<p class="reason">“${esc(doc.decisionNote)}”</p>` : ''}
      </section>`;
    }
    return `<section class="decision pending" id="decision-block">
      <h2>Your decision</h2>
      <p class="reason">Review the change above, type your name to sign, and approve or decline. The contractor is notified immediately.</p>
      <label for="decision-name">Type your full name to sign</label>
      <input type="text" id="decision-name" maxlength="120" autocomplete="name" placeholder="e.g. Jordan Avery">
      <label for="decision-note">Note (optional)</label>
      <textarea id="decision-note" maxlength="500" placeholder="Anything the contractor should know"></textarea>
      <div class="decision-actions">
        <button type="button" class="approve" id="decision-approve">Approve change order</button>
        <button type="button" class="decline" id="decision-decline">Decline</button>
      </div>
      <p class="decision-error" id="decision-error" hidden></p>
    </section>`;
  }

  function render(doc){
    const lines = (doc.lines || []);
    const photos = (doc.photos || []);
    const hasMoney = lines.some(line => Number(line.materialCost) > 0) || Number(doc.amount) > 0;
    host.innerHTML = `
      <header class="co-head">
        <div><small>${esc(doc.company.name || 'Contractor')}</small><h1>Change Order</h1></div>
        <div class="co-number">Change order no.<strong>${esc(doc.number)}</strong><span>Issued ${date(doc.submittedAt || doc.createdAt)}</span></div>
      </header>
      ${statusBanner(doc)}
      <div class="meta">
        <div><small>Project</small><strong>${esc(doc.project.name || '—')}</strong></div>
        <div><small>Customer</small><strong>${esc(doc.project.customer || '—')}</strong></div>
        <div><small>Site</small><strong>${esc(doc.project.site || '—')}</strong></div>
        ${doc.createdBy ? `<div><small>Reported by</small><strong>${esc(doc.createdBy)}</strong></div>` : ''}
      </div>
      <h2>Description of change</h2>
      <p class="description">${esc(doc.title)}</p>
      ${doc.reason ? `<p class="reason">Basis: ${esc(doc.reason)}</p>` : ''}
      ${doc.detail ? `<p class="reason">Field note: ${esc(doc.detail)}</p>` : ''}
      ${lines.length ? `<h2>Line items</h2>
      <table class="lines">
        <thead><tr><th>Description</th><th>Qty</th><th>Unit</th><th class="num">Labor hrs</th>${hasMoney ? '<th class="num">Material</th>' : ''}</tr></thead>
        <tbody>${lines.map(line => `<tr><td>${esc(line.description)}</td><td>${Number(line.quantity) || '—'}</td><td>${esc(line.unit || '—')}</td><td class="num">${Number(line.laborHours) || '—'}</td>${hasMoney ? `<td class="num">${money(line.materialCost)}</td>` : ''}</tr>`).join('')}
        ${hasMoney ? `<tr class="total"><td colspan="${lines.length ? 4 : 4}">Total change</td><td class="num">${money(doc.amount)}</td></tr>` : ''}</tbody>
      </table>` : hasMoney ? `<h2>Price</h2><p class="description">${money(doc.amount)}</p>` : ''}
      ${photos.length ? `<h2>Photos</h2><div class="photos">${photos.map(photo => `<figure><img src="${esc(photo.url)}" alt="${esc(photo.caption || 'Change photo')}" loading="lazy"><figcaption>${esc(photo.caption || '')} · ${date(photo.capturedAt)}</figcaption></figure>`).join('')}</div>` : ''}
      <p class="terms">Work proceeds upon approval of this change order. The total above will be billed as an addition to the contract. Questions? Reply to whoever sent you this link — this document was generated automatically by Pro Daily Link from the contractor’s field records.</p>
      ${decisionBlock(doc)}`;
    wireDecision(doc);
  }

  function wireDecision(doc){
    const approve = document.getElementById('decision-approve');
    if (!approve) return;
    const decline = document.getElementById('decision-decline'), name = document.getElementById('decision-name'), note = document.getElementById('decision-note'), error = document.getElementById('decision-error');
    const submit = async decision => {
      error.hidden = true;
      if (!name.value.trim()) { error.textContent = 'Type your name to sign the decision.'; error.hidden = false; name.focus(); return; }
      approve.disabled = decline.disabled = true;
      try {
        const response = await fetch('/api/change-order/' + encodeURIComponent(token) + '/decision', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision, name: name.value.trim(), note: note.value.trim() }) });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || 'The decision could not be recorded.');
        load();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        approve.disabled = decline.disabled = false;
      }
    };
    approve.onclick = () => submit('approved');
    decline.onclick = () => submit('declined');
  }

  async function load(){
    host.innerHTML = '<p class="empty">Loading change order…</p>';
    try {
      const response = await fetch('/api/change-order/' + encodeURIComponent(token));
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'This change order link is invalid or has been revoked.');
      render(payload);
    } catch (err) {
      host.innerHTML = `<div class="banner no">${esc(err.message)}</div><p class="empty">If you expected a change order here, contact your contractor for a fresh link.</p>`;
    }
  }

  if (!token) {
    host.innerHTML = '<div class="banner no">This change order link is missing its access token.</div><p class="empty">Ask your contractor to resend the link.</p>';
    return;
  }
  load();
})();
