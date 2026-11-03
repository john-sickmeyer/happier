# Android profile keyboard regression — issue 89

Evidence for the one-line `ProfileEditForm` keyboard-aware scrolling correction. All screenshots, Android interactions, builds and tests were performed by OpenAI Codex on November 2, 2026, using a disposable account and local relay. No human-run QA is claimed.

Source basis: `04376668a63ff2c1070a4401ec5dcea2ee16922d` (dev). The final source commit is `14fd8f454042d58692661550f7e580dccd904dc3` and contains only the existing ItemList's `keyboardAware` opt-in.

Runtime: Android debug development client 0.2.20 build 1, package `dev.happier.app.internaldev.devclient`, Expo 54. Baseline and corrected JavaScript used the same binary/device with Fast Refresh disabled and distinct temporary loaded-module probes. Probes were removed from the final source patch.

Device: Android 15/API 35 Google Play ARM64 emulator, 1080x2400, gesture navigation, Gboard 14.2.09.629370537-preload-arm64-v8a, animations 1x.

## Reproduction

1. Open Add Profile at `/new/pick/profile-edit`.
2. Scroll so Environment Variables → Add Variable is low in the visible viewport.
3. Tap Add Variable. Before the fix, its auto-focused Name field is entirely behind the keyboard.

`01-before-focused-field-covered.png` shows the baseline failure: field y=1611–1737, IME top y=1517. `02-after-focused-field-visible.png` and `03-after-typing.png` show the corrected empty/typed field. The native caret bottom is y=1492, clearing the IME by 25px. Three Back-dismiss/reopen cycles passed with the same clearance and identical closed geometry, and Settings → AI Profiles → Add Profile also passed. `profile-after.mp4` records the keyboard cycles.

The first GREEN assertion required the entire EditText rectangle above the IME and failed by 8px. The shared keyboard controller uses selection/caret height intentionally. The refined collector asserts actual native caret visibility and that the caret belongs to the focused field; it also rejects a fully covered field. Some bottom background padding remains covered. Full-field clearance is not claimed.

## Regression collector

With an authenticated disposable profile form already open and Add Variable low in the viewport:

```sh
python3 profile-keyboard-regression.py --adb adb --serial emulator-5556 --output ./result --tap-add
```

Requires Gboard to publish the active native CursorAnchorInfo. The script records a screenshot, UI hierarchy and measured geometry, then asserts the Name caret is above the real IME. The preserved baseline geometry fails the refined visibility contract because the entire field lies below the IME top. This is native outcome evidence; host rendering mocks cannot observe this scrolling behavior.

## Recorded validation

Android debug compilation, full UI typecheck and the relevant host lane (46 tests / 11 files) passed. Selected terminal output is retained in `validation-output.txt`. Those successful checks were audited and reused for publication, not rerun on the latest upstream full tree. Relevant form, route, list and keyboard-owner source remains identical at upstream dev `282a8fc3f999df1d104b78daa489317e65d395a6`.

The original composer problem was not reproduced in published preview 0.2.19 build 79: 12 empty open/close cycles and three multiline-draft cycles passed. Those are separate preview results, not verification of this development-source patch. Earlier PR #164 already corrected Android height subtraction; that change predates this source basis.

## Limits

This is a focused profile-form correction, not proof that every screen in #89 is fixed. No iOS, web, physical device, BrowserStack, OEM keyboard, active-agent Send, or release/OTA certification is claimed. The v0.3 slim/legacy companion is only proposed: destination preparation failed on Protocol imports before a meaningful native RED could be established. It was not applied or submitted.

These files contain no account credentials, private conversations, APKs, or development bundles. They are hosted separately from the source-change branch so evidence files do not enter the production PR diff.
