# Mobile customer detail fix

User reproduced the issue in iOS Safari and requested Home Screen coverage. This review change is on codex/mobile-customer-detail, based on main 7e7d978. Draft PR publication is approved; merge/deployment is not. It is separate from reporting draft PR #30.

Confirmed code cause: styles.css hides .customer-detail at widths up to 760px; the customer click handler only rerenders that hidden panel. The hiding rule dates to commit 6ed45bc (Prepare Pro Daily Link cloud demo), rather than the recent sanitization release. The latest renderCustomers wrapper also dropped its search argument.

The patch shows the selected profile and hides the list on mobile, provides a 44px Back to customers control, focuses/scrolls the visible panel, makes the standalone app Back return to the list first, resets detail state on page navigation, and forwards the search filter. Contact values remain escaped and the contract-value visibility wrapper remains active. Desktop keeps its two-column view. Mobile text/actions wrap within the panel. JS/CSS cache version URLs are updated.

Home Screen uses manifest display standalone with start_url /app and the same HTML/JS/CSS as Safari. No service worker registration or worker cache exists in this checkout. Server HTML/JS/CSS responses require revalidation (no-cache, no-store, must-revalidate). These are code observations, not execution on an iPhone.

Final full npm test aggregate, npm run check and git diff --check passed. Security scan returned zero critical findings and seven existing review flags. The UX fixture cache-version assertions were updated with the assets. VM/static regression tests cover tap/open, contacts, escaping, back controls, search forwarding, pricing redaction, desktop focus and cache versions. A full test run initially needed the existing sibling checkout dependencies via NODE_PATH; no software installation was performed. Real iOS Safari and installed Home Screen testing remains unverified because no supported browser runtime is callable here.

Before release: in both Safari and Home Screen at portrait phone width, open Customers, tap a customer, verify contact/name/phone and project links, return with both Back controls, search/select another customer, rotate to landscape and return, then close/reopen the app to confirm fresh assets. Safari browser Back should retain the existing page navigation behavior; profile selection does not create a separate browser history entry. Capture screenshots and actual outcomes without customer secrets.
