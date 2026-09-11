# License scope

Copyright 2026 mintonnee

## Project code: Apache-2.0

The original software code of Karaoke Player is licensed under the Apache
License, Version 2.0. See [LICENSE](LICENSE) for the complete terms.

This grant covers original application code (including TypeScript, JavaScript,
Python, HTML and CSS), tests, build and development scripts, and software
configuration in `src/`, `sidecar/`, `scripts/` and the repository root, together
with compiled forms of that code. The exclusions below take precedence.
Package license metadata describes this original code, not every bundled item.

## SoundTouch exception: LGPL-2.1-or-later

`src/renderer/public/worklets/soundtouch-worklet.js` is derived from
[SoundTouchJS v0.3.0](https://github.com/cutterbl/SoundTouchJS/tree/v0.3.0).
The entire file, including the project's AudioWorklet adapter and modifications,
remains under the GNU Lesser General Public License, version 2.1 or (at your
option) any later version. It is **not** relicensed under Apache-2.0.

The upstream copyright notices are retained in the file. The license text is in
`scripts/licenses/LGPL-2.1.txt` in this repository and `licenses/LGPL-2.1.txt` in
the application distribution. The distribution also includes the exact editable
worklet source at `third-party-source/soundtouch-worklet.js`; its runtime copy is
at `out/renderer/worklets/soundtouch-worklet.js` inside `resources/app.asar`.
To use a modified version, replace the source file in a checkout and rebuild
with the instructions in README.md. Keep the worklet interface compatible with
the player when modifying it.

## Other third-party material

Vendored code, dependencies, downloaded runtimes and models, third-party assets,
and their license and attribution notices retain their respective licenses.
In particular, `scripts/licenses/` and the generated third-party notices are
not covered by the project's Apache-2.0 grant. SoundTouch is the explicitly
identified source-file exception; it is not a claim that all other dependencies
are Apache-2.0. See the app's third-party notices for component information.

## Non-code material

This Apache-2.0 grant does not cover README or other prose documentation
(including `docs/`), logos, icons, images, fonts, screenshots, audio, lyrics,
videos, model weights, or other non-code assets, wherever located. No license
for project-owned non-code material is granted by this notice; separately
stated licenses and third-party rights continue to apply. This notice does not
change the terms of any included license text.

The project name and branding are not licensed for use as trademarks by this
code license.
