# Pay-period mobile focus zoom follow-up

Local branch codex/pay-period-mobile-zoom based on live f7b62def6908601a14b0e5c77ab5032e41b50340. No publication of this follow-up yet.

User reports iPhone zoom when choosing Add/New pay period. Source finding: generic labels set font-size:11px, form controls inherit font, and openPayForm immediately focuses the label input after showModal. The new form lacks a mobile font override. This is a probable focus-zoom trigger; actual iOS computed styling/viewport zoom was not observed locally.

Scoped remedy: mobile pay-period input/select/textarea and related new Time date/search/filter/period controls use font-size:max(16px,1rem), preserving larger root text settings. Last-in-file ID selectors outrank inherited labels. Date fields use minmax(0,1fr), stacking at widths <=400px; min-width:0/max-width:100% constrain native input width. Initial label focus uses preventScroll:true while preserving keyboard focus. Desktop typography remains unchanged. Styles and changed UI module cache tags are advanced. No backend, period policy, provider, financial, or permission change.

Viewport remains width=device-width, initial-scale=1.0. No user-scalable=no, maximum-scale=1 or transform/zoom hack is used. MDN viewport guidance warns against disabling user zoom: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/name/viewport .

Verification: targeted real-controls/original-row-renderer VM tests include focus options, mobile selectors/font floor/narrow-grid/cache wiring and unrestricted viewport; all existing assertions remain. Final aggregate npm test passed all35 commands after updating the existing stylesheet-cache assertion; npm run check and git diff --check passed. Independent review found no blocker in selector specificity/order, narrow layout, focus, cache tags, accessibility or change scope. Security scan0critical9unchanged reviewflags.

Limit: these are synthetic HTTP, VM and static checks, not actual Safari layout or iPhone focus-zoom acceptance. On the user phone, reload the updated app, open New custom period, focus Label/Start/End and correction Reason, check that no automatic zoom jump occurs, close/reopen, confirm narrow layout and pinch zoom remains available. Prior live f7b62def is rollback base; no rollback or customer/provider operation performed. Parent to assess exact tested scope before release.
