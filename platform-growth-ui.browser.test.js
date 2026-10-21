'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const EDGE_CANDIDATES = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);

function findEdge() {
  const executable = EDGE_CANDIDATES.find(candidate => fs.existsSync(candidate));
  if (!executable) {
    throw new Error(`Microsoft Edge was not found. Checked: ${EDGE_CANDIDATES.join(', ')}`);
  }
  return executable;
}

function fixtureReport() {
  return {
    status: 'ready',
    asOf: '2026-10-20T18:30:00.000Z',
    period: { startDate: '2026-10-01', endDate: '2026-10-20', timezone: 'UTC' },
    metrics: {
      cohortSize: 3,
      funnel: { new: 3, contacted: 2, qualified: 2, demo_scheduled: 1, demo_held: 1, proposal: 1, won: 1, lost: 0 },
      attribution: {
        source: [{ bucket: 'Referral partner', count: 2 }, { bucket: 'unknown', count: 1 }],
        medium: [{ bucket: 'Direct introduction', count: 2 }, { bucket: 'unknown', count: 1 }],
        campaign: [{ bucket: 'unknown', count: 3 }],
        plan: [{ bucket: 'Growth', count: 2 }, { bucket: 'unknown', count: 1 }]
      },
      pipeline: {
        count: 3,
        expectedMrr: [{ currency: 'usd', amountMinor: 29800 }, { currency: 'eur', amountMinor: 5000 }],
        expectedMrrUnknownCount: 1
      },
      overdue: {
        count: 1,
        items: [{ id: 'opp-1', ownerUserId: 'owner-1', dueAt: '2026-10-19T17:00:00.000Z' }]
      },
      leaderboard: [
        {
          ownerUserId: 'owner-1',
          opportunitiesCreated: 2,
          demosHeld: 1,
          wins: 1,
          losses: 0,
          winRate: 100,
          wonMrr: [{ currency: 'usd', amountMinor: 19900 }],
          wonMrrUnknownCount: 0,
          responseTime: { respondedCount: 1, awaitingResponseCount: 1, unknownCount: 0, averageMinutes: 35 },
          followUpReliability: { dueCount: 2, completedOnTime: 1, completedLate: 0, overdue: 1, cancelled: 0, rate: 50 }
        },
        {
          ownerUserId: 'unassigned',
          opportunitiesCreated: 1,
          demosHeld: 0,
          wins: 0,
          losses: 0,
          winRate: null,
          wonMrr: [],
          wonMrrUnknownCount: 0,
          responseTime: { respondedCount: 0, awaitingResponseCount: 1, unknownCount: 0, averageMinutes: null },
          followUpReliability: { dueCount: 0, completedOnTime: 0, completedLate: 0, overdue: 0, cancelled: 0, rate: null }
        }
      ]
    },
    opportunities: [
      {
        id: 'opp-1',
        version: 4,
        companyName: 'Atlas Concrete & Civil',
        contactName: 'Mia Flores',
        ownerUserId: 'owner-1',
        stage: 'proposal',
        expectedMrrMinor: 19900,
        currency: 'usd',
        nextAction: 'Call about the multi-project rollout',
        nextActionDueAt: '2026-10-19T17:00:00.000Z',
        attribution: { source: 'Referral partner' },
        plan: 'Growth'
      },
      {
        id: 'opp-2',
        version: 1,
        companyName: 'Northwest Sitework and Underground Utilities',
        contactName: null,
        ownerUserId: null,
        stage: 'new',
        expectedMrrMinor: null,
        currency: null,
        nextAction: null,
        nextActionDueAt: null,
        attribution: { source: null },
        plan: null
      }
    ],
    opportunityTotal: 3,
    owners: [{ id: 'owner-1', name: 'Jordan Lee' }]
  };
}

function pageSource(moduleUrl, width) {
  const report = JSON.stringify(fixtureReport()).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta id="browser-test-results" content="">
  <style>
    html,body{margin:0;padding:0;width:100%;min-width:0;background:#101512;color:#f7f8f7}
    *,*::before,*::after{box-sizing:border-box}
    body{padding:8px;font:16px/1.4 Arial,sans-serif}
    #fixture{width:100%;max-width:100%;min-width:0}
  </style>
  <script>
    (function () {
      function publish(value) {
        document.getElementById('browser-test-results').setAttribute('content', btoa(unescape(encodeURIComponent(JSON.stringify(value)))));
      }
      window.__publishBrowserTest = publish;
      window.addEventListener('error', function (event) {
        publish({ ok:false, width:${width}, error:String(event.error && event.error.stack || event.message || 'Browser script error') });
      });
    }());
  </script>
  <script src="${moduleUrl}"></script>
</head>
<body>
  <main id="fixture"></main>
  <script>
    (function () {
      function fail(message) { throw new Error(message); }
      function numericPixels(value) { return Number.parseFloat(value) || 0; }
      function rgba(value) {
        var match = String(value).match(/rgba?\\(([^)]+)\\)/);
        if (!match) fail('Could not parse computed color: ' + value);
        var parts = match[1].split(',').map(Number);
        return { r:parts[0], g:parts[1], b:parts[2], a:parts.length > 3 ? parts[3] : 1 };
      }
      function luminance(color) {
        var channels = [color.r,color.g,color.b].map(function (channel) {
          var value = channel / 255;
          return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
      }
      function contrast(foreground, background) {
        var light = Math.max(luminance(foreground), luminance(background));
        var dark = Math.min(luminance(foreground), luminance(background));
        return (light + 0.05) / (dark + 0.05);
      }
      function effectiveBackground(element) {
        for (var current = element; current; current = current.parentElement) {
          var color = rgba(getComputedStyle(current).backgroundColor);
          if (color.a > 0.99) return color;
        }
        return rgba(getComputedStyle(document.body).backgroundColor);
      }
      function visible(element) {
        var style = getComputedStyle(element);
        var rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      }

      var root = document.getElementById('fixture');
      if (!window.PDLGrowthUI) fail('platform-growth-ui.js did not expose PDLGrowthUI');
      window.PDLGrowthUI.renderGrowthReport(document, root, ${report}, { canWrite:true });

      var requestedWidth = ${width};
      if (window.innerWidth !== requestedWidth) fail('Edge viewport was ' + window.innerWidth + 'px, expected ' + requestedWidth + 'px');
      var scrollWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth, root.scrollWidth);
      if (scrollWidth > window.innerWidth + 1) fail('Horizontal overflow: content is ' + scrollWidth + 'px in a ' + window.innerWidth + 'px viewport');
      var outside = Array.from(document.querySelectorAll('#fixture *')).filter(function (element) {
        if (!visible(element)) return false;
        var rect = element.getBoundingClientRect();
        return rect.left < -0.5 || rect.right > window.innerWidth + 0.5;
      });
      if (outside.length) fail('Elements extend outside the viewport: ' + outside.slice(0,5).map(function (item) { return item.tagName + '.' + item.className; }).join(', '));

      var kpis = document.querySelector('section[aria-label="Growth key performance indicators"]');
      if (!kpis) fail('The KPI collection has no semantic accessible label');
      if (kpis.querySelectorAll('article').length !== 5) fail('Expected five semantic KPI cards');

      var actionButtons = Array.from(document.querySelectorAll('button[data-growth-action]'));
      if (!actionButtons.length) fail('No growth action buttons were rendered');
      actionButtons.forEach(function (button) {
        var card = button.closest('article');
        var opportunity = card && card.querySelector('h4');
        var label = button.getAttribute('aria-label') || '';
        if (!opportunity || !label.includes(opportunity.textContent)) fail('Action button is missing its opportunity-specific aria-label: ' + button.textContent);
        var rect = button.getBoundingClientRect();
        if (rect.width < 44 || rect.height < 44) fail('Touch target below 44px: ' + label + ' measured ' + rect.width + 'x' + rect.height);
      });

      var focusTarget = actionButtons[0];
      focusTarget.focus({ preventScroll:true });
      var focusStyle = getComputedStyle(focusTarget);
      if (document.activeElement !== focusTarget || !focusTarget.matches(':focus-visible')) fail('Keyboard-focus target is not visibly focusable');
      if (focusStyle.outlineStyle === 'none' || numericPixels(focusStyle.outlineWidth) < 3 || numericPixels(focusStyle.outlineOffset) < 2) {
        fail('Keyboard focus outline is not visibly distinct');
      }

      var surface = document.querySelector('.pdl-growth__card');
      if (getComputedStyle(surface).backgroundColor !== 'rgb(32, 38, 34)') fail('Dark theme surface variables were not applied');
      var mainText = document.querySelector('.pdl-growth__card h4');
      var mutedText = document.querySelector('.pdl-growth__kpi span');
      var mainContrast = contrast(rgba(getComputedStyle(mainText).color), effectiveBackground(mainText));
      var mutedContrast = contrast(rgba(getComputedStyle(mutedText).color), effectiveBackground(mutedText));
      if (mainContrast < 4.5) fail('Main text contrast is ' + mainContrast.toFixed(2) + ':1; expected at least 4.5:1');
      if (mutedContrast < 4.5) fail('Muted text contrast is ' + mutedContrast.toFixed(2) + ':1; expected at least 4.5:1');

      window.__publishBrowserTest({
        ok:true,
        width:window.innerWidth,
        scrollWidth:scrollWidth,
        actionCount:actionButtons.length,
        minimumTouchHeight:Math.min.apply(null, actionButtons.map(function (item) { return item.getBoundingClientRect().height; })),
        mainContrast:Number(mainContrast.toFixed(2)),
        mutedContrast:Number(mutedContrast.toFixed(2)),
        focusOutline:focusStyle.outlineWidth + ' ' + focusStyle.outlineStyle + ' / offset ' + focusStyle.outlineOffset
      });
    }());
  </script>
</body>
</html>`;
}

function decodeResult(encoded, width) {
  if (!encoded) throw new Error(`Edge ${width}px run did not return a browser-test result marker.`);
  let result;
  try {
    result = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch (error) {
    throw new Error(`Edge ${width}px returned an unreadable result marker: ${error.message}`);
  }
  if (!result.ok) throw new Error(`Edge ${width}px browser assertion failed: ${result.error || 'unknown error'}`);
  return result;
}

function launchEdgeCdp(edge, profilePath, width) {
  const child = childProcess.spawn(edge, [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--no-first-run',
    '--no-default-browser-check',
    '--allow-file-access-from-files',
    '--remote-debugging-pipe',
    `--user-data-dir=${profilePath}`,
    'about:blank'
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });

  let id = 0;
  let protocolBuffer = '';
  let stderr = '';
  let stopped = false;
  const pending = new Map();

  function rejectPending(error) {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  }

  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-4000); });
  child.on('error', error => rejectPending(new Error(`Microsoft Edge ${width}px could not start: ${error.message}`)));
  child.on('exit', (code, signal) => {
    stopped = true;
    if (pending.size) {
      const detail = stderr.trim();
      rejectPending(new Error(`Microsoft Edge ${width}px exited before completing (code ${code}, signal ${signal || 'none'}).${detail ? `\n${detail}` : ''}`));
    }
  });
  child.stdio[4].on('data', chunk => {
    protocolBuffer += chunk.toString('utf8');
    let boundary;
    while ((boundary = protocolBuffer.indexOf('\0')) >= 0) {
      const raw = protocolBuffer.slice(0, boundary);
      protocolBuffer = protocolBuffer.slice(boundary + 1);
      if (!raw) continue;
      let message;
      try { message = JSON.parse(raw); } catch (error) {
        rejectPending(new Error(`Microsoft Edge ${width}px returned malformed DevTools data: ${error.message}`));
        continue;
      }
      if (!message.id || !pending.has(message.id)) continue;
      const item = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(new Error(`DevTools ${item.method} failed: ${message.error.message}`));
      else item.resolve(message.result || {});
    }
  });

  function send(method, params = {}, sessionId) {
    if (stopped) return Promise.reject(new Error(`Microsoft Edge ${width}px is no longer running.`));
    const requestId = ++id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`Microsoft Edge ${width}px timed out waiting for DevTools ${method}.`));
      }, 10000);
      pending.set(requestId, { resolve, reject, timer, method });
      const message = { id: requestId, method, params };
      if (sessionId) message.sessionId = sessionId;
      child.stdio[3].write(JSON.stringify(message) + '\0', error => {
        if (!error) return;
        const item = pending.get(requestId);
        if (!item) return;
        pending.delete(requestId);
        clearTimeout(item.timer);
        reject(new Error(`Microsoft Edge ${width}px pipe write failed: ${error.message}`));
      });
    });
  }

  async function close() {
    if (stopped) return;
    try { await send('Browser.close'); } catch { child.kill(); }
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      new Promise(resolve => setTimeout(() => { if (!stopped) child.kill(); resolve(); }, 2000))
    ]);
  }

  return { send, close };
}

async function runViewport(edge, tempRoot, width) {
  const htmlPath = path.join(tempRoot, `growth-${width}.html`);
  const profilePath = path.join(tempRoot, `edge-profile-${width}`);
  const moduleUrl = pathToFileURL(path.join(__dirname, 'platform-growth-ui.js')).href;
  fs.writeFileSync(htmlPath, pageSource(moduleUrl, width), 'utf8');
  const cdp = launchEdgeCdp(edge, profilePath, width);
  try {
    await cdp.send('Browser.getVersion');
    const created = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const attached = await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true });
    const sessionId = attached.sessionId;
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: 1200,
      deviceScaleFactor: 1,
      mobile: true,
      screenWidth: width,
      screenHeight: 1200
    }, sessionId);
    await cdp.send('Page.navigate', { url: pathToFileURL(htmlPath).href }, sessionId);
    const deadline = Date.now() + 10000;
    let encoded = '';
    while (!encoded && Date.now() < deadline) {
      const evaluated = await cdp.send('Runtime.evaluate', {
        expression: `document.getElementById('browser-test-results')?.getAttribute('content') || ''`,
        returnByValue: true
      }, sessionId);
      encoded = evaluated.result?.value || '';
      if (!encoded) await new Promise(resolve => setTimeout(resolve, 50));
    }
    const result = decodeResult(encoded, width);

    // Use the browser input domain, not a synthetic DOM KeyboardEvent, so this
    // verifies the focus-visible treatment reached through an actual Tab key.
    await cdp.send('Runtime.evaluate', {
      expression: `document.activeElement?.blur();document.body.tabIndex=-1;document.body.focus({preventScroll:true});true`,
      returnByValue: true
    }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }, sessionId);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }, sessionId);
    const keyboard = await cdp.send('Runtime.evaluate', {
      expression: `(() => {const item=document.activeElement,style=getComputedStyle(item);return {action:item?.dataset?.growthAction||'',visible:item?.matches?.(':focus-visible')===true,outlineStyle:style.outlineStyle,outlineWidth:parseFloat(style.outlineWidth)||0,outlineOffset:parseFloat(style.outlineOffset)||0}})()`,
      returnByValue: true
    }, sessionId);
    const focus = keyboard.result?.value;
    if (!focus?.action || !focus.visible || focus.outlineStyle === 'none' || focus.outlineWidth < 3 || focus.outlineOffset < 2) {
      throw new Error(`Edge ${width}px keyboard Tab focus was not visibly distinct: ${JSON.stringify(focus || null)}`);
    }
    result.keyboardAction = focus.action;
    return result;
  } finally {
    await cdp.close();
  }
}

async function main() {
  const edge = findEdge();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pdl-growth-browser-'));
  try {
    const results = [];
    for (const width of [320, 390]) results.push(await runViewport(edge, tempRoot, width));
    for (const result of results) {
      assert.equal(result.scrollWidth <= result.width + 1, true);
      assert.equal(result.minimumTouchHeight >= 44, true);
      assert.equal(result.mainContrast >= 4.5, true);
      assert.equal(result.mutedContrast >= 4.5, true);
    }
    console.log('Growth UI real-browser checks passed:', results.map(result =>
      `${result.width}px (overflow ${result.scrollWidth}px, touch ${result.minimumTouchHeight}px, contrast ${result.mainContrast}/${result.mutedContrast})`
    ).join('; '));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
