# Hosted Studio sign-in screenshots

Taken by `tests/e2e/studio-sign-in.e2e.mjs` (`SCREENSHOTS=docs/product/screenshots/studio-sign-in node --test tests/e2e/studio-sign-in.e2e.mjs`). They show the real pages against the stub issuer in `tests/fixtures/stub-issuer.mjs`, with Chromium's virtual passkey. The names and accounts are the test's own.

| Page | Desktop, 1280px | Phone, 360px |
| --- | --- | --- |
| Sign in | [sign-in-desktop-light.png](sign-in-desktop-light.png) | [sign-in-phone-light.png](sign-in-phone-light.png) |
| Ask an owner to invite you | | [light](not-invited-phone-light.png), [dark](not-invited-phone-dark.png) |
| Add a first passkey | [passkey-add-desktop-light.png](passkey-add-desktop-light.png) | |
| Your account | | [account-phone-dark.png](account-phone-dark.png) |
| Confirm it is you (passkey step-up) | [step-up-desktop-light.png](step-up-desktop-light.png) | [refused, dark](step-up-refused-phone-dark.png) |
