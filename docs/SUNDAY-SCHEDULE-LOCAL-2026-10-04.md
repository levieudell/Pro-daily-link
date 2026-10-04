# Sunday-start schedule follow-up

Local branch `codex/sunday-schedule`, based on live `ec922bdd53b0018eb3ed0a83aa3cb4325e674f9f`. User explicitly approved publishing this separate Sunday-start fix after local tests and review. Pay-period changes are excluded.

Actual pre-fix VM reproduction: selected `2026-10-04` parsed to local day 4, while schedulePeriodDays returned September28 through October2. The native date selection was retained; the schedule hard-coded Monday start and five visible weekdays. No existing configurable five/seven-day display preference exists in this implementation.

Use Sunday start and all seven Sunday-Saturday days. October4 now displays October4-10; October3 belongs to September27-October3; October5 belongs to October4-10. Desktop headers/grid, phone agenda, range label, month leading cells and weekday headings all use the same Sunday alignment. Month and Day still retain their selected date. Range labels show explicit month names to avoid the prior day/year-only formatter's awkward output. Arrows/Today and existing assignment weekend-entry controls remain unchanged. This scheduling preference does not set any payroll or pay-period dates.

Automated fixtures run Los Angeles, Kiritimati and UTC, including spring/fall DST, selected Sunday/Saturday/Monday, seven visible days, range label, actual rendered markup for grid/agenda and Sunday-first month leading cells, Day selection and Today/arrows. Full 33-command aggregate, syntax and diff checks passed. Tests are VM/API/static, not actual phone execution; iPhone native picker/rendering acceptance remains open.

Custom pay-period work remains isolated on `codex/custom-pay-periods`; no code from that branch is included here.
