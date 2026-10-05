'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parse } = require('parse5');

const elements = node => (node.childNodes || []).filter(child => child.tagName);
const attr = (node, name) => node.attrs?.find(item => item.name === name)?.value;
const hasClass = (node, name) => (attr(node, 'class') || '').split(/\s+/).includes(name);
const text = node => node.nodeName === '#text' ? node.value : (node.childNodes || []).map(text).join('');
const all = node => [node, ...(node.childNodes || []).flatMap(all)];
const direct = (node, tag) => elements(node).filter(child => child.tagName === tag);

function validateLanding(html) {
  const errors = [];
  const document = parse(html, { sourceCodeLocationInfo: true, onParseError: error => errors.push(error.code) });
  assert.deepEqual(errors, [], 'landing HTML must parse without recovery errors');
  assert.equal(document.mode, 'no-quirks', 'the doctype must precede styles and content');
  const root = elements(document)[0];
  const head = direct(root, 'head')[0];
  const body = direct(root, 'body')[0];
  for (const node of [root, head, body]) {
    assert.ok(node?.sourceCodeLocation?.startTag && node.sourceCodeLocation.endTag, `${node?.tagName} must have explicit opening and closing tags`);
  }
  const nodes = all(document);
  assert.ok(elements(head).every(node => ['meta', 'title', 'link', 'script', 'style'].includes(node.tagName)), 'head must contain metadata only');
  for (const node of nodes.filter(node => node.tagName === 'link' || node.tagName === 'script')) {
    assert.equal(node.parentNode, head, `${node.tagName} assets must stay inside head`);
  }
  for (const node of [head, body]) {
    const location = node.sourceCodeLocation;
    for (const child of all(node).slice(1)) {
      if (!child.tagName) continue;
      const childLocation = child.sourceCodeLocation;
      assert.ok(childLocation && childLocation.startOffset >= location.startTag.endOffset && childLocation.endOffset <= location.endTag.startOffset, `${child.tagName} must be authored inside ${node.tagName}, not relocated by the parser`);
    }
  }
  assert.deepEqual(elements(body).map(node => node.tagName), ['style', 'header', 'main', 'footer'], 'page content must not be trapped inside a pricing card');
  const main = direct(body, 'main')[0];
  assert.ok(elements(main).every(node => node.tagName === 'section'), 'no detached pricing fragments may sit between sections');
  assert.ok((main.childNodes || []).filter(node => node.nodeName === '#text').every(node => !node.value.trim()), 'main must not contain orphaned CTA text');
  const ids = nodes.map(node => attr(node, 'id')).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, 'page IDs must be unique');
  const pricing = nodes.find(node => attr(node, 'id') === 'pricing');
  assert.equal(pricing?.parentNode, main, 'pricing must be a top-level main section');
  const grids = nodes.filter(node => hasClass(node, 'pricing-four'));
  assert.equal(grids.length, 1, 'exactly one four-plan grid must exist');
  const grid = grids[0];
  assert.equal(grid.parentNode, pricing, 'the plan grid belongs inside #pricing');
  assert.ok(hasClass(grid, 'pricing'));
  assert.deepEqual(elements(pricing).map(node => node === grid ? 'plans' : attr(node, 'class')), ['section-title', 'plans']);
  assert.ok((pricing.childNodes || []).filter(node => node.nodeName === '#text').every(node => !node.value.trim()), 'pricing must not contain an orphaned Start Pro label');
  const cards = elements(grid);
  assert.equal(cards.length, 4, 'all four plans must be siblings');
  assert.ok(cards.every(node => node.tagName === 'article'));
  assert.deepEqual(cards.map(card => text(direct(card, 'h3')[0])), ['Starter', 'Growth', 'Pro', 'Enterprise']);
  const plans = [
    { name: 'Starter', price: '$99/month', annual: '$990 annually.', users: 'Up to 10 users', projects: '5 active projects', href: '/signup.html?plan=starter' },
    { name: 'Growth', price: '$199/month', annual: '$1,990 annually.', users: 'Up to 30 users', projects: '25 active projects', href: '/signup.html?plan=growth' },
    { name: 'Pro', price: '$399/month', annual: '$3,990 annually.', users: 'Up to 75 users', projects: 'Unlimited active projects', href: '/signup.html?plan=pro' }
  ];
  plans.forEach((plan, index) => {
    const card = cards[index];
    assert.equal(text(direct(card, 'strong')[0]), plan.price);
    assert.ok(text(direct(card, 'p')[0]).startsWith(plan.annual));
    const benefits = direct(direct(card, 'ul')[0], 'li').map(text);
    assert.equal(benefits[0], plan.users);
    assert.equal(benefits[1], plan.projects);
    const links = direct(card, 'a');
    assert.equal(links.length, 1);
    assert.equal(attr(links[0], 'href'), plan.href);
    assert.equal(text(links[0]), `Start ${plan.name}`);
  });
  assert.ok(hasClass(cards[1], 'featured'), 'Growth retains its featured treatment');
  const enterprise = cards[3];
  assert.ok(hasClass(enterprise, 'enterprise'));
  assert.equal(text(direct(enterprise, 'strong')[0]), 'Let’s talk');
  assert.ok(text(direct(enterprise, 'p')[0]).includes('more than 75 users'));
  const contact = direct(enterprise, 'a');
  assert.equal(contact.length, 1);
  assert.equal(attr(contact[0], 'href'), '#book-demo');
  assert.equal(attr(contact[0], 'data-implementation'), 'Enterprise');
  assert.equal(text(contact[0]), 'Contact us');
  const footerLinks = all(direct(body, 'footer')[0]).filter(node => node.tagName === 'a').map(node => attr(node, 'href'));
  assert.ok(footerLinks.includes('/terms.html') && footerLinks.includes('/privacy.html'), 'legal links remain accessible');
}

if (require.main === module) {
  validateLanding(fs.readFileSync(path.join(__dirname, 'landing.html'), 'utf8'));
  console.log('Landing pricing DOM passed: standards mode, head/body boundaries, four complete plans, unchanged prices/limits/links, and no orphaned content.');
}

module.exports = { validateLanding };
