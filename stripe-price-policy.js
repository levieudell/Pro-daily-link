'use strict';

const CATALOG = Object.freeze([
  ['STRIPE_PRICE_STARTER', 'STRIPE_PRODUCT_STARTER', 9900, 'month'],
  ['STRIPE_PRICE_STARTER_ANNUAL', 'STRIPE_PRODUCT_STARTER', 99000, 'year'],
  ['STRIPE_PRICE_GROWTH', 'STRIPE_PRODUCT_GROWTH', 19900, 'month'],
  ['STRIPE_PRICE_GROWTH_ANNUAL', 'STRIPE_PRODUCT_GROWTH', 199000, 'year'],
  ['STRIPE_PRICE_PRO', 'STRIPE_PRODUCT_PRO', 39900, 'month'],
  ['STRIPE_PRICE_PRO_ANNUAL', 'STRIPE_PRODUCT_PRO', 399000, 'year'],
  ['STRIPE_PRICE_FOUNDER_STARTER', 'STRIPE_PRODUCT_FOUNDER_STARTER', 7900, 'month'],
  ['STRIPE_PRICE_FOUNDER_STARTER_ANNUAL', 'STRIPE_PRODUCT_FOUNDER_STARTER', 79000, 'year'],
  ['STRIPE_PRICE_FOUNDER_GROWTH', 'STRIPE_PRODUCT_FOUNDER_GROWTH', 15900, 'month'],
  ['STRIPE_PRICE_FOUNDER_GROWTH_ANNUAL', 'STRIPE_PRODUCT_FOUNDER_GROWTH', 159000, 'year'],
  ['STRIPE_PRICE_FOUNDER_PRO', 'STRIPE_PRODUCT_FOUNDER_PRO', 31900, 'month'],
  ['STRIPE_PRICE_FOUNDER_PRO_ANNUAL', 'STRIPE_PRODUCT_FOUNDER_PRO', 319000, 'year'],
  ['STRIPE_PRICE_ASSISTED_SETUP', 'STRIPE_PRODUCT_ASSISTED_SETUP', 49900, null]
]);

const PRICE_KEYS = Object.freeze(CATALOG.map(([key]) => key));
const PRODUCT_KEYS = Object.freeze([...new Set(CATALOG.map(([, key]) => key))]);

function productObject(price) {
  return price?.product && typeof price.product === 'object' && !Array.isArray(price.product) ? price.product : null;
}

function matches(price, specification, env = process.env, liveExpected = /^(?:sk|rk)_live_/.test(String(env.STRIPE_SECRET_KEY || ''))) {
  const [priceKey, productKey, unitAmount, interval] = specification;
  const priceId = String(env[priceKey] || '').trim();
  const productId = String(env[productKey] || '').trim();
  const product = productObject(price);
  const recurring = interval !== null;
  return Boolean(priceId && productId && price?.id === priceId && price.active === true && price.livemode === liveExpected &&
    price.currency === 'usd' && price.unit_amount === unitAmount && price.custom_unit_amount == null &&
    price.billing_scheme === 'per_unit' && price.transform_quantity == null && price.tiers_mode == null &&
    price.type === (recurring ? 'recurring' : 'one_time') &&
    product?.id === productId && product.active === true && product.livemode === liveExpected &&
    (recurring
      ? price.recurring?.interval === interval && price.recurring?.interval_count === 1 &&
        price.recurring?.usage_type === 'licensed' && price.recurring?.aggregate_usage == null && price.recurring?.meter == null
      : price.recurring == null));
}

function specificationForPrice(priceId, env = process.env) {
  const matchesId = CATALOG.filter(([priceKey]) => String(env[priceKey] || '').trim() === String(priceId || '').trim());
  return matchesId.length === 1 ? matchesId[0] : null;
}

module.exports = { CATALOG, PRICE_KEYS, PRODUCT_KEYS, matches, specificationForPrice };
