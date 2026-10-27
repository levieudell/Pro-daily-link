'use strict';
(function () {
  const TRIAL = 'Start free trial';
  const SHORT = 'Free trial';

  function shown(el) {
    if (!el || el.hidden || el.closest('[hidden]')) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function textLines(el) {
    const tops = new Set();
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!node.textContent.trim()) continue;
      let parent = node.parentElement;
      let hidden = false;
      while (parent) {
        if (getComputedStyle(parent).display === 'none') { hidden = true; break; }
        if (parent === el) break;
        parent = parent.parentElement;
      }
      if (hidden) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width > 0.5 && rect.height > 0.5) tops.add(Math.round(rect.top));
      }
    }
    return tops.size;
  }

  function overlaps(a, b) {
    return a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
  }

  function overflows(header) {
    const view = document.documentElement.clientWidth;
    if (header.scrollWidth > header.clientWidth + 1) return true;
    const items = [...header.querySelectorAll('a,button')].filter(shown);
    const rects = [];
    for (const el of items) {
      if (textLines(el) > 1) return true;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      if (rect.left < -1 || rect.right > view + 1) return true;
      rects.push(rect);
    }
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) if (overlaps(rects[i], rects[j])) return true;
    }
    return false;
  }

  function trialLink(header) {
    return [...header.querySelectorAll('.header-actions a')].find(link => {
      const label = link.textContent.trim();
      return label === TRIAL || label === SHORT;
    }) || null;
  }

  function ensureMenu(header) {
    const nav = header.querySelector(':scope > nav');
    if (!nav) return null;
    if (!nav.id) nav.id = 'site-nav';
    let button = header.querySelector('.header-menu');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'header-menu';
      button.setAttribute('aria-controls', nav.id);
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-label', 'Open menu');
      button.innerHTML = '<span></span><span></span><span></span>';
      const actions = header.querySelector('.header-actions');
      if (actions) actions.appendChild(button);
      else header.appendChild(button);
    }
    return button;
  }

  function parkDemo(header, park) {
    const demo = header.querySelector('.header-demo');
    if (!demo) return;
    const nav = header.querySelector(':scope > nav');
    const actions = header.querySelector('.header-actions');
    const trial = trialLink(header);
    if (park) {
      if (nav && demo.parentElement !== nav) nav.appendChild(demo);
    } else if (actions && demo.parentElement !== actions) {
      if (trial && trial.parentElement === actions) actions.insertBefore(demo, trial);
      else actions.appendChild(demo);
    }
  }

  function menuVisible(header) {
    const button = header.querySelector('.header-menu');
    return Boolean(button && getComputedStyle(button).display !== 'none');
  }

  function setOpen(header, open) {
    const button = header.querySelector('.header-menu');
    const next = Boolean(open && menuVisible(header));
    header.classList.toggle('menu-open', next);
    if (!button) return;
    button.setAttribute('aria-expanded', next ? 'true' : 'false');
    button.setAttribute('aria-label', next ? 'Close menu' : 'Open menu');
  }

  let menuBound = false;
  function bindMenu() {
    if (menuBound) return;
    menuBound = true;
    document.addEventListener('click', event => {
      const header = document.querySelector('.site-header');
      if (!header) return;
      const button = event.target.closest('.header-menu');
      if (button && header.contains(button)) {
        setOpen(header, !header.classList.contains('menu-open'));
        return;
      }
      if (event.target.closest('.site-header nav a')) setOpen(header, false);
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      const header = document.querySelector('.site-header');
      if (header) setOpen(header, false);
    });
    document.addEventListener('pointerdown', event => {
      const header = document.querySelector('.site-header');
      if (!header || header.contains(event.target)) return;
      setOpen(header, false);
    });
  }

  function settle(header) {
    const narrow = window.matchMedia('(max-width: 480px)').matches;
    const link = trialLink(header);
    const apply = (collapsed, short) => {
      header.classList.toggle('nav-collapsed', collapsed);
      if (!link) return;
      const next = short ? SHORT : TRIAL;
      if (link.textContent !== next) link.textContent = next;
    };
    parkDemo(header, narrow);
    apply(false, false);
    if (overflows(header)) {
      apply(true, false);
      if (overflows(header)) apply(true, true);
    }
    if (!narrow && overflows(header) && header.querySelector('.header-actions .header-demo')) {
      parkDemo(header, true);
      apply(false, false);
      if (overflows(header)) {
        apply(true, false);
        if (overflows(header)) apply(true, true);
      }
    }
    if (!menuVisible(header)) setOpen(header, false);
  }

  function fit() {
    const header = document.querySelector('.site-header');
    if (!header || header.dataset.fitting === '1') return;
    header.dataset.fitting = '1';
    ensureMenu(header);
    bindMenu();
    settle(header);
    delete header.dataset.fitting;
  }

  let observer;
  function schedule() {
    if (observer) observer.disconnect();
    fit();
    const header = document.querySelector('.site-header');
    if (!header || !observer) return;
    observer.observe(header, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  }

  window.fitSiteHeader = () => schedule();
  if (!document.querySelector('.site-header')) return;
  observer = new MutationObserver(() => {
    const header = document.querySelector('.site-header');
    if (header?.dataset.fitting === '1') return;
    schedule();
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule);
  else schedule();
  window.addEventListener('resize', schedule);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
})();
