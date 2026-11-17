# Android implementation and build record

## R3 implementation

- `MainActivity` enables edge-to-edge. The activity uses `adjustResize`; the chat root consumes system-bar and IME insets once with `systemBarsPadding().imePadding()`. The header stays at the top of the resized column and the composer follows the IME. Composer and TextField heights remain content-driven.
- Queued-message actions require the exact `queued` state, a nonblank `requestId`, and membership in the authoritative queued set. Long-pressing the message bubble opens the action menu, with an accessible long-click action. Only a real action failure adds feedback below the stable, single-line status row. Unknown status values read `已发送`.
- Result rows render only when `OutputsCache.line()` returns visible text. Empty successful output creates no row; the last successful nonempty output remains visible during refresh.
- Subagent reads start when the component appears. A card appears only for nonempty descendants; unknown and successful empty trees draw no card. Read failures show an explicit error and retry action. Refreshes retain the last successful tree without a loading row.
- Timeline follow detection now accepts the final item only when its end is within 48 px of the viewport end in either direction. This keeps a tall final row extending beyond the viewport from being treated as bottom, while accepting the measured 38 px bottom-padding gap.

## Validation

- JDK 21: `:app:testDebugUnitTest` and `:app:assembleRelease -PcrewBuildId=redmi-motion-20261116-r3` passed.
- Geometry regressions cover a final item ending 600 px beyond the viewport and a 38 px bottom-padding gap.
- The release APK contains build ID `redmi-motion-20261116-r3`; the packaged manifest reports `windowSoftInputMode=adjustResize`.
- `apksigner verify` passed for APK Signature Scheme v2 and v3; signer certificate SHA-256: `ad0e44804142148625ce90427ce3832747c29b795640cfb451745b44540af7eb`.
- SHA-256 for r3: `06f7e91c91612a9fd2cb0d5a95dfdd90959a6fabbe95409fcb315f23a3eda46d`.
- The r2 device recording confirmed the header remained visible, the status row stayed stable, empty subagent data created no card, and a real reply inserted without disrupting the view. R3's timeline geometry change is ready for lead's device check.

## Release artifacts

- R3 candidate: `deliver/dsh-bot-crew-redmi-motion-20261116-r3.apk` — SHA-256 `06f7e91c91612a9fd2cb0d5a95dfdd90959a6fabbe95409fcb315f23a3eda46d`.
- R2 retained: `deliver/dsh-bot-crew-redmi-motion-20261116-r2.apk` — SHA-256 `3fab08f41059720c92e02244aec147f3750e0fc29ca3a508249bb6a34b853bbb`.
- R1 retained: `deliver/dsh-bot-crew-redmi-motion-20261116-r1.apk` — SHA-256 `382481f1e99e41d3a2e171e010fccc446f23ae2ad019482a7c03f70375ebd6b6`.
- R1 capture evidence remains under `capture-r1/`.
