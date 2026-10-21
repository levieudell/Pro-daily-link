'use strict';

const net = require('node:net');

function normalizedAddress(value) {
  let address = String(value || '').trim();
  if (address.startsWith('[')) {
    const closingBracket = address.indexOf(']');
    if (closingBracket > 0) address = address.slice(1, closingBracket);
  }
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(address)) address = address.slice(7);
  return net.isIP(address) ? address.toLowerCase() : null;
}

function trustedProxyHops(env = process.env) {
  const hops = Number(env.PDL_TRUST_PROXY_HOPS || 0);
  return Number.isSafeInteger(hops) && hops >= 0 && hops <= 8 ? hops : 0;
}

/**
 * Return an address suitable for abuse throttling without trusting an attacker-
 * supplied left-most X-Forwarded-For value. Render appends the real client to
 * the right side of the chain, so production explicitly trusts one proxy hop.
 */
function clientAddress(req, env = process.env) {
  const direct = normalizedAddress(req?.socket?.remoteAddress) || 'unknown';
  const hops = trustedProxyHops(env);
  if (!hops) return direct;
  const forwarded = String(req?.headers?.['x-forwarded-for'] || '')
    .split(',')
    .map(normalizedAddress)
    .filter(Boolean);
  if (forwarded.length < hops) return direct;
  return forwarded[forwarded.length - hops] || direct;
}

function platformDevelopmentBypassAllowed(env = process.env) {
  if (env.NODE_ENV === 'production') return false;
  // PDL_PLATFORM_DEV_BYPASS is the dedicated switch. PDL_REQUIRE_AUTH=0 is
  // retained as an explicit local-test compatibility switch only; neither can
  // weaken production authentication.
  return env.PDL_PLATFORM_DEV_BYPASS === '1' || env.PDL_REQUIRE_AUTH === '0';
}

function platformAuthRequired(env = process.env) {
  return !platformDevelopmentBypassAllowed(env);
}

module.exports = Object.freeze({
  normalizedAddress,
  trustedProxyHops,
  clientAddress,
  platformDevelopmentBypassAllowed,
  platformAuthRequired
});
