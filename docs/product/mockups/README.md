# Mockups: team operations

Static, high-fidelity mockups for [PRD](../prd.md) sections 6.6 to 6.9 and [architecture](../architecture.md) section 12. They are design artefacts, not product code: plain HTML with the Studio's own tokens (from `apps/studio/public/app.css`) in `mock.css`, so they match the shipped editor. Data in them is invented for a sample app.

| Screen | What it shows | PRD |
| --- | --- | --- |
| [01 New agent: start](01-new-agent-start.png) ([html](01-new-agent-start.html)) | Blank, copy a kit role, or import; name, slug, group, manager; "Your agents" in the library | A1, A5, A6 |
| [02 Custom agent editor](02-custom-agent-editor.png) ([html](02-custom-agent-editor.html)) | Guided sections, live brief preview, checks, a path conflict with a working role resolved in place, sign-off evidence | A2 to A4, A8 |
| [03 Meetings](03-meetings.png) ([html](03-meetings.html)) | Recurring, today's and past meetings; attendees, format, agenda, what happens to busy attendees, the owner's part, cost estimate | M1, M3 to M5, M7, M8 |
| [04 Chat: minutes and an ad hoc meeting](04-chat-minutes-adhoc.png) ([html](04-chat-minutes-adhoc.html)) | Standup minutes with action items; an ad hoc meeting started from the chat, with a role joining after its current step; the owner speaking in the meeting | M2, M5, M6 |
| [05 Notifications](05-notifications.png) ([html](05-notifications.html)) | Channels with health, rules (when, about, to, how), quiet hours, an email preview, the delivery log | O1 to O7 |
| [06 Editing a live team](06-canvas-live-edit.png) ([html](06-canvas-live-edit.html)) | Live status on cards; switching off a working role marks it and explains what is in flight | X1 |
| [07 Your change touches work in progress](07-ongoing-work-dialog.png) ([html](07-ongoing-work-dialog.html)) | The impact step in Publish: per-item choices with a recommendation, linked items, safe changes, where the change lands on each role's timeline | X2 to X6, X8 |
| [08 Rolling out a version](08-applying-change.png) ([html](08-applying-change.html)) | After merge: each role moving to the new version, what each still waits on, and the event log | X7 |


## Phone apps

[PRD](../prd.md) section 6.10, [ADR 0006](../../adr/0006-mobile-apps-native-per-platform.md) and [architecture](../architecture.md) section 14. Same tokens, in native-looking frames (`phone.css`).

| Screen | What it shows | PRD |
| --- | --- | --- |
| [09 Phone: inbox and approvals](09-mobile-inbox-approvals.png) ([html](09-mobile-inbox-approvals.html)) | iPhone: a push with no team content, the inbox across teams and Studios, approving with Face ID | MB1 to MB3, MB8 |
| [10 Phone: board, role and chat](10-mobile-board-chat.png) ([html](10-mobile-board-chat.html)) | Android: the board as a list with run controls, a role's page with sign-off evidence, the chat offline | MB4, MB5, MB7, MB10 |

To re-render the screenshots: open each HTML file in a browser at 1440 × 900, or use Playwright (`page.screenshot`, full page for 07; 1280 wide, full page, for 09 and 10).
