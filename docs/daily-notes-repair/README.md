# Daily notes repair

Reproduction: reopen a saved daily containing the user's wall notes, no production entries, and the summary “No production or labor recorded.” Then tap Done.

Before: the summary alone marked the notes as reviewed; extraction never ran and no work line appeared. The browser regression failed waiting for a production quantity.

After: an empty saved daily is extracted again. The supplied wall estimate produces 300 LF. The fallback parser recognizes “linear feet” as well. Existing work lines and manual quantity edits remain intact on reopen.

Equipment statements are retained in Equipment used and excluded from labor evidence. The reported 30 hours over multiple days stay visible for date-by-date review; they are never silently clamped into a 24-hour shift or used to create punches. Office submission asks for this report date's hours when missing. Field unknown-hours review stays available. This does not automatically split or backdate work.

Office daily review now uses brand surfaces and controls, non-sticky totals, reachable hours actions, and the same focus visibility correction as field daily. Project form selection fits phone width. Safety checks and signature requirements are unchanged.

Tests cover real extraction with a synthetic wall estimate, saved-empty recovery, 300 LF, separate equipment, multi-day labor, actual draft save/reopen, preserved manual quantity, unchanged punches, field behavior, project width, and reachable controls at 390x500, 390x844 and 1280x800 in both themes.
