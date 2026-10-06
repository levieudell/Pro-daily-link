# Direct daily navigation from project details

The project-details report link selected a report with `renderReports(id)`, but `showPage('reports')` reset the viewport to the top. On phones the report list is above the selected detail, so the user saw the list. The existing list-item handler scrolls down to the detail; the project link did not. Separately, a previously selected status filter could exclude the target report and cause the renderer to substitute the first visible report.

The link now uses one synchronous helper. It validates the still-open originating project dialog and finds the exact report in the signed-in workspace's already-loaded reports, with a matching project. It clears only a conflicting status filter, renders the requested ID, focuses the detail without moving the viewport, then scrolls directly to it. There is no queued scroll or asynchronous fetch that can override subsequent navigation. A missing or other-project report stays in the project with an unavailable message; it never substitutes another report. No API or access-control policy changed.

The actual link-wiring regression fails on main because the selected detail is never scrolled into view. After the fix, synthetic tests pass for multiple projects and reports, exact selection, conflicting filters, missing/deleted/inaccessible reports, stale project controls, closed dialogs, subsequent navigation, Back to project, and ordinary list selection/filtering. Existing project-notes fixtures separately cover stale async project opens and queued close events.

This is a separate draft from the home-screen pull-refresh fix in PR56. Neither is merged or deployed. Browser/device QA is pending the coordinated browser slot; synthetic tests do not claim real iPhone layout verification.
