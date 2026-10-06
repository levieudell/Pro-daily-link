# Mobile project dialog refresh regression

## Reproduced path

On main `976af1a5b68e447b8eda05ef23b6d0007789baa9`, the home-screen pull-refresh handler starts whenever the underlying page is at scrollY=0. A dialog scroll does not change the page's scrollY. A downward touch movement of at least 90px inside project details therefore calls location.reload(), discarding the open window and any in-memory work.

The public live `https://app.prodailylink.com/app.js` returned HTTP 200 on October 6 and its pull-refresh function matched main exactly. This was a public asset read only, without authentication or production records.

This establishes a closure path for the installed home-screen app. It does not establish the user's exact cause until their app mode and gesture are confirmed. Ordinary Safari mode does not install this handler. No speculative backdrop or async-navigation change is included.

## Fix and regression evidence

The production handler now blocks page refresh while any native dialog is open, when the touch is inside a dialog, or when editing an input, select, textarea or contenteditable element. It rechecks eligibility during movement and at completion, and cancels tracking after touchcancel, multi-touch or leaving the page top.

`node mobile-pull-refresh.test.js` runs actual extracted production handlers against synthetic touch events. Before the fix its first assertion fails: a downward dialog swipe calls reload once instead of zero times. After the fix all flows pass: modal/backdrop swipes, interrupted and repeated gestures, multi-touch, a modal opening during a gesture, editable targets, short gestures, normal page refresh and ordinary browser mode. These are behavioral VM fixtures, not an iPhone layout engine.

No dialog close, native cancel, back/navigation, polling, project renderer, note persistence or storage-clearing code was changed. The existing project-notes fixtures separately cover 228 cases, including close/navigation, queued close events, stale async completions and active draft retention.

## Conditional workaround and limits

If this is the installed home-screen app, opening PDL in ordinary Safari avoids this custom refresh handler. Avoiding a downward pull inside project details also avoids this specific path. Do not clear storage: it can contain drafts.

The fix is proposed source only until released. Real iPhone/home-screen and coordinated mobile browser QA remain pending. Release remains subject to the separate backup gate.
