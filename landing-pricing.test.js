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
    { name: 'Starter', price: '$990/year', monthly: '$99/month', annual: '$990 a year.', users: 'Up to 10 users', projects: '5 active projects', href: '/signup.html?plan=starter&cycle=annual', monthlyHref: '/signup.html?plan=starter&cycle=monthly' },
    { name: 'Growth', price: '$1,990/year', monthly: '$199/month', annual: '$1,990 a year.', users: 'Up to 30 users', projects: '25 active projects', href: '/signup.html?plan=growth&cycle=annual', monthlyHref: '/signup.html?plan=growth&cycle=monthly' },
    { name: 'Pro', price: '$3,990/year', monthly: '$399/month', annual: '$3,990 a year.', users: 'Up to 75 users', projects: 'Unlimited active projects', href: '/signup.html?plan=pro&cycle=annual', monthlyHref: '/signup.html?plan=pro&cycle=monthly' }
  ];
  const classed = (node, name) => all(node).find(child => hasClass(child, name));
  plans.forEach((plan, index) => {
    const card = cards[index];
    const strong = direct(card, 'strong')[0];
    assert.equal(text(classed(strong, 'when-annual')), plan.price);
    assert.equal(text(classed(strong, 'when-monthly')), plan.monthly);
    assert.ok(text(direct(card, 'p')[0]).startsWith(plan.annual));
    const benefits = direct(direct(card, 'ul')[0], 'li').map(text);
    assert.equal(benefits[0], plan.users);
    assert.equal(benefits[1], plan.projects);
    const links = direct(card, 'a');
    assert.equal(links.length, 2);
    const annualLink = links.find(node => hasClass(node, 'when-annual'));
    const monthlyLink = links.find(node => hasClass(node, 'when-monthly'));
    assert.equal(attr(annualLink, 'href'), plan.href);
    assert.equal(attr(monthlyLink, 'href'), plan.monthlyHref);
    assert.equal(text(annualLink), `Start ${plan.name}`);
    assert.equal(text(monthlyLink), `Start ${plan.name}`);
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
  const toggle = all(pricing).find(node => attr(node, 'id') === 'billing-cycle');
  assert.equal(toggle?.parentNode, elements(pricing)[0], 'the billing toggle stays inside the pricing title');
  assert.equal(attr(toggle, 'role'), 'radiogroup');
  const inputs = all(toggle).filter(node => node.tagName === 'input');
  assert.deepEqual(inputs.map(node => [attr(node, 'type'), attr(node, 'name'), attr(node, 'value'), attr(node, 'checked') != null]), [
    ['radio', 'billing-period', 'annual', true],
    ['radio', 'billing-period', 'monthly', false]
  ]);
  assert.deepEqual(elements(toggle).map(node => text(node).trim()), ['Annual', 'Monthly']);
  const style = all(elements(pricing)[0]).find(node => node.tagName === 'style');
  assert.match(text(style), /\.when-monthly\{display:none\}/);
  assert.match(text(style), /#FF6600/);
  assert.match(text(style), /input\[value="monthly"\]:checked/);
  assert.equal(all(pricing).filter(node => node.tagName === 'script').length, 0, 'price swapping must not depend on a script');
  const compare = nodes.find(node => attr(node, 'id') === 'compare');
  const cycleText = (id, cycle) => text(all(all(compare).find(node => attr(node, 'id') === id)).find(node => hasClass(node, cycle)));
  assert.equal(cycleText('compare-price-label', 'when-annual'), 'Annual price');
  assert.equal(cycleText('compare-price-label', 'when-monthly'), 'Monthly price');
  assert.deepEqual(['starter', 'growth', 'pro'].map(id => cycleText(`compare-${id}`, 'when-annual')), ['$990', '$1,990', '$3,990']);
  assert.deepEqual(['starter', 'growth', 'pro'].map(id => cycleText(`compare-${id}`, 'when-monthly')), ['$99', '$199', '$399']);
  assert.match(html, /"name":"Starter","price":"99"/);
  assert.match(html, /"name":"Growth","price":"199"/);
  assert.match(html, /"name":"Pro","price":"399"/);
  assert.doesNotMatch(html, /\$79|\$159|\$319|\$790|\$1,590|\$3,190/);
  const footerLinks = all(direct(body, 'footer')[0]).filter(node => node.tagName === 'a').map(node => attr(node, 'href'));
  assert.ok(footerLinks.includes('/terms.html') && footerLinks.includes('/privacy.html'), 'legal links remain accessible');
}

if (require.main === module) {
  validateLanding(fs.readFileSync(path.join(__dirname, 'landing.html'), 'utf8'));
  console.log('Landing pricing DOM passed: standards mode, head/body boundaries, four complete plans, annual catalog prices/limits/links, and no orphaned content.');
}

module.exports = { validateLanding };

