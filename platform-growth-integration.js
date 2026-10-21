'use strict';

/*
  Accessible mutation dialogs for platform-growth-ui.js.

  Load after platform-growth-ui.js. This module listens for the bubbling
  `pdl:growth-action` event and calls window.PDLGrowthConsole.actions. It does
  not replace server-side authorization or validation. Create retries reuse the
  same idempotency key while the submitted payload is unchanged.
*/
(function growthIntegrationModule() {
  const TRANSITIONS = Object.freeze({
    new: Object.freeze(['contacted', 'qualified', 'demo_scheduled', 'lost']),
    contacted: Object.freeze(['qualified', 'demo_scheduled', 'lost']),
    qualified: Object.freeze(['demo_scheduled', 'demo_held', 'proposal', 'lost']),
    demo_scheduled: Object.freeze(['qualified', 'demo_held', 'lost']),
    demo_held: Object.freeze(['proposal', 'won', 'lost']),
    proposal: Object.freeze(['demo_held', 'won', 'lost']),
    won: Object.freeze([]),
    lost: Object.freeze([])
  });
  const LABELS = Object.freeze({
    new: 'New', contacted: 'Contacted', qualified: 'Qualified', demo_scheduled: 'Demo scheduled',
    demo_held: 'Demo held', proposal: 'Proposal', won: 'Won', lost: 'Lost'
  });
  const ZERO_DECIMAL = new Set('bif clp djf gnf jpy kmf krw mga pyg rwf vnd vuv xaf xof xpf'.split(' '));
  const THREE_DECIMAL = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);
  const ACTIONS = new Set(['create', 'edit', 'stage', 'next_action', 'note', 'complete_next_action']);
  const CSS = `
    .pdl-growth-dialog{--gd-ink:var(--ink,#151916);--gd-muted:var(--muted,#626c66);--gd-surface:var(--card,#fff);--gd-line:var(--line,#d5dcd6);--gd-soft:var(--soft,#f3f5f2);--gd-accent:var(--orange,#ff6b1a);--gd-danger:#9f211a;width:min(680px,calc(100vw - 24px));max-height:min(88vh,820px);padding:0;border:1px solid var(--gd-line);border-radius:18px;background:var(--gd-surface);color:var(--gd-ink);box-shadow:0 24px 80px rgb(0 0 0/.28)}
    .pdl-growth-dialog::backdrop{background:rgb(8 12 9/.62);backdrop-filter:blur(2px)}.pdl-growth-dialog *{box-sizing:border-box}
    .pdl-growth-dialog__form{display:grid;max-height:inherit}.pdl-growth-dialog__head,.pdl-growth-dialog__body,.pdl-growth-dialog__foot{padding:16px}.pdl-growth-dialog__head{display:flex;justify-content:space-between;gap:12px;border-bottom:1px solid var(--gd-line)}
    .pdl-growth-dialog__head h2{margin:0;font-size:1.3rem}.pdl-growth-dialog__head p{margin:5px 0 0;color:var(--gd-muted)}.pdl-growth-dialog__body{display:grid;gap:14px;overflow:auto}.pdl-growth-dialog__grid{display:grid;gap:12px}.pdl-growth-dialog__field{display:grid;gap:6px;font-size:.88rem;font-weight:750}.pdl-growth-dialog__field small{font-weight:500;color:var(--gd-muted)}
    .pdl-growth-dialog input,.pdl-growth-dialog select,.pdl-growth-dialog textarea,.pdl-growth-dialog button{font:inherit;min-height:44px}.pdl-growth-dialog input,.pdl-growth-dialog select,.pdl-growth-dialog textarea{width:100%;padding:10px 11px;border:1px solid var(--gd-line);border-radius:10px;background:var(--gd-surface);color:var(--gd-ink)}.pdl-growth-dialog textarea{min-height:112px;resize:vertical}.pdl-growth-dialog input:focus-visible,.pdl-growth-dialog select:focus-visible,.pdl-growth-dialog textarea:focus-visible,.pdl-growth-dialog button:focus-visible{outline:3px solid #1769e0;outline-offset:2px}
    .pdl-growth-dialog details{padding:12px;border:1px solid var(--gd-line);border-radius:12px}.pdl-growth-dialog summary{min-height:44px;display:flex;align-items:center;font-weight:800;cursor:pointer}.pdl-growth-dialog__error{min-height:22px;margin:0;color:var(--gd-danger);font-weight:700}.pdl-growth-dialog__foot{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;border-top:1px solid var(--gd-line)}
    .pdl-growth-dialog__button{border:1px solid var(--gd-line);border-radius:10px;padding:9px 14px;background:var(--gd-surface);color:var(--gd-ink);font-weight:800;cursor:pointer}.pdl-growth-dialog__button--primary{background:var(--gd-accent);border-color:var(--gd-accent);color:#17120e}.pdl-growth-dialog__button--icon{flex:none;width:44px;padding:0;font-size:1.25rem}.pdl-growth-dialog__button:disabled{opacity:.55;cursor:not-allowed}.pdl-growth-dialog[aria-busy="true"] .pdl-growth-dialog__body{opacity:.68}
    [data-theme="dark"] .pdl-growth-dialog,.theme-dark .pdl-growth-dialog,.dark .pdl-growth-dialog{--gd-ink:#f7f8f7;--gd-muted:#c0c8c3;--gd-surface:#202622;--gd-line:#4a554d;--gd-soft:#303833;--gd-danger:#ffb4ab}
    @media (min-width:620px){.pdl-growth-dialog__head,.pdl-growth-dialog__body,.pdl-growth-dialog__foot{padding:20px}.pdl-growth-dialog__grid{grid-template-columns:repeat(2,minmax(0,1fr))}.pdl-growth-dialog__field--wide{grid-column:1/-1}}
    @media (prefers-reduced-motion:reduce){.pdl-growth-dialog *{transition:none!important}}
  `;

  function node(document, tag, text, className) {
    const value = document.createElement(tag);
    if (text !== undefined) value.textContent = String(text ?? '');
    if (className) value.className = className;
    return value;
  }

  function text(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function formError(message) {
    return Object.assign(new TypeError(message), { code: 'growth_form_invalid' });
  }

  function currencyExponent(currency) {
    const code = text(currency).toLowerCase();
    if (!/^[a-z]{3}$/.test(code)) return null;
    if (ZERO_DECIMAL.has(code)) return 0;
    if (THREE_DECIMAL.has(code)) return 3;
    return 2;
  }

  function minorUnitsFromInput(value, currency) {
    const raw = text(value), exponent = currencyExponent(currency);
    if (!raw && !text(currency)) return null;
    if (!raw || exponent == null || !/^\d+(?:\.\d+)?$/.test(raw)) throw formError('Enter an amount and a three-letter currency code.');
    const [whole, fraction = ''] = raw.split('.');
    if (fraction.length > exponent) throw formError(`Use no more than ${exponent} decimal places for ${text(currency).toUpperCase()}.`);
    const result = Number(whole) * (10 ** exponent) + Number((fraction + '0'.repeat(exponent)).slice(0, exponent) || 0);
    if (!Number.isSafeInteger(result) || result < 0) throw formError('Expected MRR is too large.');
    return result;
  }

  function minorUnitsToInput(value, currency) {
    const exponent = currencyExponent(currency);
    if (!Number.isSafeInteger(value) || value < 0 || exponent == null) return '';
    if (!exponent) return String(value);
    return `${Math.floor(value / (10 ** exponent))}.${String(value % (10 ** exponent)).padStart(exponent, '0')}`;
  }

  function localDateTime(value) {
    if (!value || !Number.isFinite(Date.parse(value))) return '';
    const date = new Date(value), pad = number => String(number).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function isoDateTime(value) {
    if (!value || !Number.isFinite(Date.parse(value))) throw formError('Choose a valid due date and time.');
    return new Date(value).toISOString();
  }

  function safeUrl(value, { relative = false } = {}) {
    const raw = text(value);
    if (!raw) return null;
    if (relative && /^\/(?!\/)/.test(raw)) return raw;
    let parsed;
    try { parsed = new URL(raw); } catch { throw formError('Enter a full http:// or https:// web address.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw formError('Use a safe http:// or https:// web address without embedded credentials.');
    return parsed.toString();
  }

  function errorMessage(error) {
    if (error?.code === 'growth_form_invalid') return error.message;
    switch (error?.code) {
      case 'revision_conflict': return 'Someone changed this opportunity. Close the dialog, refresh, and try again.';
      case 'busy': return 'This update is already running. Wait a moment and try again.';
      case 'missing_identity': return 'Add a company, contact, email, or phone number.';
      case 'invalid_email': return 'Enter a valid email address.';
      case 'invalid_phone': return 'Enter a valid phone number.';
      case 'invalid_transition': return 'That stage move is no longer allowed. Refresh the pipeline.';
      case 'loss_reason_required': return 'Add a loss reason before closing this opportunity as lost.';
      case 'pending_action_exists': return 'Add a replacement reason, or complete the current follow-up first.';
      case 'no_change': return 'Change at least one field before saving.';
      case 'duplicate_opportunity': return 'This looks like an existing opportunity. Review the pipeline before adding another.';
      case 'growth_write_denied': return 'You no longer have permission to change growth records.';
      default: return 'The update could not be saved. Your entries are still here; try again.';
    }
  }

  function commonPayload(values, { includeNextAction = false, includeNote = false } = {}) {
    const companyName = text(values.companyName), contactName = text(values.contactName), email = text(values.email).toLowerCase(), phone = text(values.phone);
    if (![companyName, contactName, email, phone].some(Boolean)) throw formError('Add a company, contact, email, or phone number.');
    if (email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) throw formError('Enter a valid email address.');
    const digits = phone.replace(/\D/g, '');
    if (phone && (digits.length < 7 || digits.length > 15)) throw formError('Enter a valid phone number.');
    const currency = text(values.currency).toLowerCase();
    const expectedMrrMinor = minorUnitsFromInput(values.expectedMrr, currency);
    const payload = {
      companyName: companyName || null, contactName: contactName || null, email: email || null, phone: phone || null,
      ownerUserId: text(values.ownerUserId) || null, source: text(values.source) || null, medium: text(values.medium) || null,
      campaign: text(values.campaign) || null, referrer: safeUrl(values.referrer), landingPage: safeUrl(values.landingPage, { relative: true }),
      plan: text(values.plan) || null, expectedMrrMinor, currency: expectedMrrMinor == null ? null : currency,
      linkedCompanyId: text(values.linkedCompanyId) || null
    };
    if (includeNextAction) {
      const nextAction = text(values.nextAction), due = text(values.nextActionDueAt);
      if (Boolean(nextAction) !== Boolean(due)) throw formError('A next action needs both a description and due date.');
      payload.nextAction = nextAction || null; payload.nextActionDueAt = due ? isoDateTime(due) : null;
    }
    if (includeNote) payload.note = text(values.note) || null;
    return payload;
  }

  function injectStyles(document) {
    if (!document?.head || document.getElementById('pdl-growth-dialog-styles')) return;
    const style = node(document, 'style'); style.id = 'pdl-growth-dialog-styles'; style.textContent = CSS; document.head.append(style);
  }

  function createGrowthIntegration(env) {
    const document = env.document, window = env.window, UI = env.ui || window.PDLGrowthUI;
    if (!document?.body || !UI || document.__pdlGrowthIntegration) return null;
    document.__pdlGrowthIntegration = true;
    injectStyles(document);
    const dialog = node(document, 'dialog', undefined, 'pdl-growth-dialog'); dialog.id = 'pdl-growth-dialog'; dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'pdl-growth-dialog-title'); dialog.setAttribute('aria-describedby', 'pdl-growth-dialog-description');
    const form = node(document, 'form', undefined, 'pdl-growth-dialog__form'); form.noValidate = true;
    const head = node(document, 'header', undefined, 'pdl-growth-dialog__head'), heading = node(document, 'div');
    const title = node(document, 'h2', '', undefined); title.id = 'pdl-growth-dialog-title';
    const description = node(document, 'p', '', undefined); description.id = 'pdl-growth-dialog-description';
    heading.append(title, description);
    const closeButton = node(document, 'button', '×', 'pdl-growth-dialog__button pdl-growth-dialog__button--icon'); closeButton.type = 'button'; closeButton.setAttribute('aria-label', 'Close growth dialog');
    head.append(heading, closeButton);
    const body = node(document, 'div', undefined, 'pdl-growth-dialog__body');
    const error = node(document, 'p', '', 'pdl-growth-dialog__error'); error.setAttribute('role', 'alert'); error.setAttribute('aria-live', 'assertive'); error.setAttribute('aria-atomic', 'true');
    const foot = node(document, 'footer', undefined, 'pdl-growth-dialog__foot');
    const cancel = node(document, 'button', 'Cancel', 'pdl-growth-dialog__button'); cancel.type = 'button';
    const submit = node(document, 'button', 'Save', 'pdl-growth-dialog__button pdl-growth-dialog__button--primary'); submit.type = 'submit';
    foot.append(cancel, submit); form.append(head, body, error, foot); dialog.append(form); document.body.append(dialog);
    let current = null, returnFocus = null, busy = false;

    function field(config) {
      const wrapper = node(document, 'label', undefined, `pdl-growth-dialog__field${config.wide ? ' pdl-growth-dialog__field--wide' : ''}`);
      wrapper.append(node(document, 'span', config.label));
      const control = node(document, config.multiline ? 'textarea' : config.select ? 'select' : 'input');
      control.name = config.name; control.id = `pdl-growth-${config.name}`;
      if (!config.multiline && !config.select) control.type = config.type || 'text';
      if (config.maxLength) control.maxLength = config.maxLength;
      if (config.required) control.required = true;
      if (config.autocomplete) control.autocomplete = config.autocomplete;
      if (config.inputMode) control.inputMode = config.inputMode;
      if (config.placeholder) control.placeholder = config.placeholder;
      if (config.value != null) control.value = String(config.value);
      if (config.select) for (const optionValue of config.options || []) {
        const option = node(document, 'option', optionValue.label); option.value = optionValue.value;
        if (String(optionValue.value) === String(config.value ?? '')) option.selected = true;
        control.append(option);
      }
      wrapper.append(control);
      if (config.help) wrapper.append(node(document, 'small', config.help));
      return { wrapper, control };
    }

    function controller() {
      return env.growthConsole || window.PDLGrowthConsole;
    }

    function values() {
      return Object.fromEntries(Object.entries(current.controls).map(([name, control]) => [name, control.value]));
    }

    function addCommonFields(opportunity, create) {
      const controls = {}, grid = node(document, 'div', undefined, 'pdl-growth-dialog__grid');
      const owners = controller()?.getOwners?.() || [];
      const ownerOptions = [{ value: '', label: 'Unassigned' }, ...owners.map(owner => ({ value: String(owner.id), label: String(owner.name) }))];
      if (opportunity?.ownerUserId && !ownerOptions.some(item => item.value === String(opportunity.ownerUserId))) ownerOptions.push({ value: String(opportunity.ownerUserId), label: `Unknown owner (${opportunity.ownerUserId})` });
      const basics = [
        { name: 'companyName', label: 'Company', maxLength: 200, autocomplete: 'organization', value: opportunity?.companyName },
        { name: 'contactName', label: 'Contact', maxLength: 200, autocomplete: 'name', value: opportunity?.contactName },
        { name: 'email', label: 'Email', type: 'email', maxLength: 254, autocomplete: 'email', value: opportunity?.email },
        { name: 'phone', label: 'Phone', type: 'tel', maxLength: 40, autocomplete: 'tel', value: opportunity?.phone },
        { name: 'ownerUserId', label: 'Owner', select: true, options: ownerOptions, value: opportunity?.ownerUserId },
        { name: 'plan', label: 'Plan interest', maxLength: 80, value: opportunity?.plan },
        { name: 'expectedMrr', label: 'Expected monthly recurring revenue', inputMode: 'decimal', value: minorUnitsToInput(opportunity?.expectedMrrMinor, opportunity?.currency), help: 'Enter the amount in major currency units, such as 199.00.' },
        { name: 'currency', label: 'Currency', maxLength: 3, value: opportunity?.currency || 'usd', help: 'Three-letter code, such as USD.' },
        { name: 'linkedCompanyId', label: 'Linked customer ID', maxLength: 128, value: opportunity?.linkedCompanyId }
      ];
      for (const config of basics) { const made = field(config); controls[config.name] = made.control; grid.append(made.wrapper); }
      body.append(grid);
      const marketing = node(document, 'details'), summary = node(document, 'summary', 'Marketing attribution'); marketing.append(summary);
      const marketingGrid = node(document, 'div', undefined, 'pdl-growth-dialog__grid');
      for (const config of [
        { name: 'source', label: 'Source', maxLength: 160, value: opportunity?.attribution?.source },
        { name: 'medium', label: 'Medium', maxLength: 160, value: opportunity?.attribution?.medium },
        { name: 'campaign', label: 'Campaign', maxLength: 160, value: opportunity?.attribution?.campaign },
        { name: 'referrer', label: 'Referrer URL', maxLength: 2048, value: opportunity?.attribution?.referrer },
        { name: 'landingPage', label: 'Landing page', maxLength: 2048, value: opportunity?.attribution?.landingPage }
      ]) { const made = field(config); controls[config.name] = made.control; marketingGrid.append(made.wrapper); }
      marketing.append(marketingGrid); body.append(marketing);
      if (create) {
        const followGrid = node(document, 'div', undefined, 'pdl-growth-dialog__grid');
        for (const config of [
          { name: 'nextAction', label: 'Next action', maxLength: 500 },
          { name: 'nextActionDueAt', label: 'Due date and time', type: 'datetime-local' },
          { name: 'note', label: 'Opening note', maxLength: 5000, multiline: true, wide: true }
        ]) { const made = field(config); controls[config.name] = made.control; followGrid.append(made.wrapper); }
        body.append(followGrid);
      }
      return controls;
    }

    function show() {
      dialog.hidden = false;
      if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
      else dialog.setAttribute('open', '');
      Promise.resolve().then(() => Object.values(current?.controls || {})[0]?.focus?.() || closeButton.focus?.());
    }

    function close() {
      if (busy) return false;
      if (typeof dialog.close === 'function' && dialog.open) dialog.close();
      else dialog.removeAttribute('open');
      dialog.hidden = true; body.replaceChildren(); error.textContent = ''; current = null;
      returnFocus?.focus?.(); returnFocus = null;
      return true;
    }

    function unavailable(message) {
      title.textContent = 'Growth action unavailable'; description.textContent = message; body.replaceChildren();
      submit.hidden = true; cancel.textContent = 'Close'; current = { action: 'unavailable', controls: {} }; show();
    }

    function open(detail, trigger = document.activeElement) {
      if (!detail || !ACTIONS.has(detail.action)) return false;
      const api = controller();
      if (!api?.actions) { unavailable('The Growth workspace is still loading. Close this message and refresh.'); return false; }
      const opportunity = detail.opportunityId ? api.getOpportunity?.(detail.opportunityId) : null;
      if (detail.action !== 'create' && (!opportunity || !Number.isSafeInteger(detail.version))) {
        unavailable('This opportunity is no longer in the loaded pipeline. Close this message and refresh.'); return false;
      }
      returnFocus = trigger; body.replaceChildren(); error.textContent = ''; submit.hidden = false; cancel.textContent = 'Cancel';
      current = { action: detail.action, id: detail.opportunityId || null, version: detail.version || null, opportunity, controls: {}, attempt: null };
      if (detail.action === 'create' || detail.action === 'edit') {
        title.textContent = detail.action === 'create' ? 'New opportunity' : 'Edit opportunity';
        description.textContent = detail.action === 'create' ? 'Capture only what you know. Unknown values stay unknown.' : `Update ${opportunity.companyName || opportunity.contactName || 'this opportunity'}.`;
        current.controls = addCommonFields(opportunity, detail.action === 'create'); submit.textContent = detail.action === 'create' ? 'Create opportunity' : 'Save changes';
      } else if (detail.action === 'stage') {
        title.textContent = 'Move opportunity'; description.textContent = `Current stage: ${LABELS[opportunity.stage] || 'Unavailable'}.`;
        const options = (TRANSITIONS[opportunity.stage] || []).map(stage => ({ value: stage, label: LABELS[stage] }));
        if (!options.length) { unavailable('Closed opportunities cannot move to another stage.'); return false; }
        const grid = node(document, 'div', undefined, 'pdl-growth-dialog__grid');
        const stage = field({ name: 'stage', label: 'New stage', select: true, options, required: true });
        const reason = field({ name: 'reason', label: 'Stage note', maxLength: 1000, wide: true });
        const loss = field({ name: 'lossReason', label: 'Loss reason', maxLength: 1000, wide: true });
        const syncLoss = () => { const lost = stage.control.value === 'lost'; loss.wrapper.hidden = !lost; loss.control.required = lost; if (!lost) loss.control.value = ''; };
        stage.control.addEventListener('change', syncLoss); syncLoss(); grid.append(stage.wrapper, reason.wrapper, loss.wrapper); body.append(grid);
        current.controls = { stage: stage.control, reason: reason.control, lossReason: loss.control }; submit.textContent = 'Move stage';
      } else if (detail.action === 'next_action') {
        title.textContent = 'Set next action'; description.textContent = opportunity.nextAction ? `Replace the current follow-up: ${opportunity.nextAction}` : 'Every open opportunity should have one clear next step.';
        const grid = node(document, 'div', undefined, 'pdl-growth-dialog__grid');
        const configs = [
          { name: 'description', label: 'Next action', maxLength: 500, required: true, value: opportunity.nextAction },
          { name: 'dueAt', label: 'Due date and time', type: 'datetime-local', required: true, value: localDateTime(opportunity.nextActionDueAt) }
        ];
        if (opportunity.nextAction) configs.push({ name: 'replaceReason', label: 'Why is it changing?', maxLength: 1000, required: true, wide: true });
        for (const config of configs) { const made = field(config); current.controls[config.name] = made.control; grid.append(made.wrapper); }
        body.append(grid); submit.textContent = opportunity.nextAction ? 'Replace follow-up' : 'Set follow-up';
      } else if (detail.action === 'note') {
        title.textContent = 'Add note'; description.textContent = 'Notes become part of the opportunity history.';
        const made = field({ name: 'text', label: 'Note', multiline: true, required: true, maxLength: 5000, wide: true }); current.controls = { text: made.control }; body.append(made.wrapper); submit.textContent = 'Add note';
      } else {
        title.textContent = 'Complete follow-up'; description.textContent = `Mark “${opportunity.nextAction || 'this follow-up'}” complete?`;
        body.append(node(document, 'p', 'This records the outcome for follow-up reliability.')); submit.textContent = 'Mark complete';
      }
      show(); return true;
    }

    function setBusy(value) {
      busy = value; dialog.setAttribute('aria-busy', String(value));
      for (const control of [...Object.values(current?.controls || {}), submit, cancel, closeButton]) control.disabled = value;
    }

    async function save(event) {
      event.preventDefault();
      if (!current || busy || current.action === 'unavailable') return;
      error.textContent = '';
      if (typeof form.checkValidity === 'function' && !form.checkValidity()) { form.reportValidity?.(); return; }
      const api = controller();
      try {
        let operation;
        if (current.action === 'create') {
          const payload = commonPayload(values(), { includeNextAction: true, includeNote: true });
          const fingerprint = JSON.stringify(payload);
          if (current.attempt?.fingerprint !== fingerprint) current.attempt = { fingerprint, key: UI.createIdempotencyKey() };
          operation = () => api.actions.create(payload, { idempotencyKey: current.attempt.key });
        } else if (current.action === 'edit') operation = () => api.actions.update(current.id, current.version, commonPayload(values()));
        else if (current.action === 'stage') {
          const entry = values();
          if (!TRANSITIONS[current.opportunity.stage]?.includes(entry.stage)) throw formError('Choose a valid next stage.');
          if (entry.stage === 'lost' && !text(entry.lossReason)) throw formError('Add a loss reason before closing this opportunity as lost.');
          operation = () => api.actions.transition(current.id, current.version, { stage: entry.stage, reason: text(entry.reason) || null, lossReason: text(entry.lossReason) || null });
        } else if (current.action === 'next_action') {
          const entry = values();
          if (!text(entry.description)) throw formError('Enter the next action.');
          if (current.opportunity.nextAction && !text(entry.replaceReason)) throw formError('Explain why the current follow-up is being replaced.');
          operation = () => api.actions.setNextAction(current.id, current.version, { description: text(entry.description), dueAt: isoDateTime(entry.dueAt), replaceReason: text(entry.replaceReason) || null });
        } else if (current.action === 'note') {
          const note = text(values().text); if (!note) throw formError('Enter a note.'); operation = () => api.actions.addNote(current.id, current.version, note);
        } else operation = () => api.actions.completeNextAction(current.id, current.version);
        setBusy(true); await operation(); setBusy(false); close();
      } catch (caught) {
        setBusy(false); error.textContent = errorMessage(caught);
        Object.values(current.controls)[0]?.focus?.();
      }
    }

    function trapFocus(event) {
      if (event.key !== 'Tab' || dialog.hidden) return;
      const controls = [closeButton, ...Object.values(current?.controls || {}), cancel, submit].filter(item => !item.disabled && !item.hidden);
      if (!controls.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }

    function onAction(event) { open(event.detail, document.activeElement); }
    document.addEventListener('pdl:growth-action', onAction);
    form.addEventListener('submit', save); closeButton.addEventListener('click', close); cancel.addEventListener('click', close); dialog.addEventListener('keydown', trapFocus);
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.hidden = true;
    return Object.freeze({ open, close, dialog, destroy() { if (!busy) close(); document.removeEventListener?.('pdl:growth-action', onAction); dialog.remove?.(); document.__pdlGrowthIntegration = false; } });
  }

  const exported = Object.freeze({ TRANSITIONS, CSS, minorUnitsFromInput, minorUnitsToInput, localDateTime, isoDateTime, safeUrl, errorMessage, commonPayload, createGrowthIntegration });
  if (typeof module !== 'undefined' && module.exports) module.exports = exported;
  else {
    window.PDLGrowthIntegration = exported;
    const start = () => { window.PDLGrowthDialogs = createGrowthIntegration({ document, window, ui: window.PDLGrowthUI }); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
  }
})();
