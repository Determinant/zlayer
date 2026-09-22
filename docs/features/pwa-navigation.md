# Installed-app Back navigation

[Documentation](../README.md) / Features

In the installed PWA, Back dismisses one active surface and leaves the map in
place. A menu inside a dialog closes first, then the dialog or full-screen view,
then the last opened or interacted-with edge panel. Stowing uses the same action
as the panel handle: drafts and plate selection remain available, focus returns
to the handle, and AHRS still requires its Stop/Background/Cancel confirmation.
Back cancels confirmations; it never accepts them or acknowledges the welcome
notice. With nothing open, Back leaves the workspace unchanged.

`core/ui/pwa-back.ts` installs this behavior only when `display-mode: standalone`
or iOS `navigator.standalone` identifies an installed app. Ordinary browser tabs
retain their normal history. Explicit links, reload, app reset, and operating-system
Home/app-switching actions are unaffected.

The first real tap or key press creates one same-URL history entry. Back returns
to that entry after requesting dismissal. The entry is reused across further
interactions and reloads, so closing a panel does not replay previously opened
panels or grow the history. The observer lives outside React's effect lifecycle;
visible components register their current dismissal callbacks with
`useBackDismiss`. Native modal dialogs use their existing cancel handlers, with
a cancel-event fallback for browsers without `requestClose()`.
Native dialog cancellation also dismisses an inner menu first when Android sends
its close signal directly to the dialog without traversing history.

Creating entries from user interaction matters: [WebKit documents that browser
Back can skip script-created history entries without user activation](https://bugs.webkit.org/show_bug.cgi?id=248303#c6).
Before the first interaction on a fresh launch, or when the browser/OS takes over
navigation without delivering it to the page, the platform controls Back.

`test/e2e/pwa-back.spec.ts` covers both installed-app detection paths, last-used
panel selection, retained drafts, delayed and removed panels, guarded stowing,
nested dialogs and menus, search, AHRS/plate full screen, repeated idle Back,
reloads, welcome cancellation, and ordinary browser navigation. It exercises
real same-document history traversal, rather than dispatching fake `popstate`
events. Physical Android system Back/predictive Back and iOS edge-swipe checks
remain necessary; browser automation does not reproduce the operating-system
gesture or soft-keyboard dismissal.
