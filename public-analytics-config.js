/* Activation requires owner review; measurement IDs are public, never API secrets. */
window.PDL_PUBLIC_ANALYTICS = Object.freeze({
  enabled: false,
  measurementId: '',
  hosts: ['prodailylink.com', 'www.prodailylink.com', 'app.prodailylink.com'],
  // Only owner-reviewed campaign labels may reach Google. Never add customer names.
  campaignValues: { utm_source: [], utm_medium: [], utm_campaign: [] },
  // Published public article slugs require review too; unknown slugs are excluded.
  blogSlugs: []
});
