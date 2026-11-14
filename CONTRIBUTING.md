# Contributing

Thanks for helping. A few things keep this project easy to work on.

## Run it

```bash
git clone <this repository>
cd copado-release-assistant
npm test                  # the unit tests - no dependencies to install
npm run check             # no unused code; the extension activates with every command

# the merge editor in a real browser, with the real Monaco
npm install --no-save playwright && npx playwright install chromium
npm run test:browser      # without Playwright it says "skipped"; CI_REQUIRE_BROWSER=1 makes that a failure

# the extension inside a real VS Code (downloads VS Code once)
npm install --no-save @vscode/test-electron
npm run test:vscode       # on Linux without a display: xvfb-run -a npm run test:vscode
```

Open the folder in VS Code and press **F5** to start an Extension Development Host with the extension loaded. `samples/` has two permission sets to try a merge on.

GitHub Actions runs every one of these on each push and pull request (`.github/workflows/test.yml`): the unit tests on Linux, Windows and macOS with Node 18, 20 and 22; the checks and the package; the browser tests; the VS Code tests on all three systems.

## Package it

```bash
npm run package           # dist/copado-release-assistant-<version>.vsix - plain Node, nothing to download
npm run package:check     # what it must hold and must not, and that it activates from itself
```

The package is the files git tracks, less what `.vscodeignore` leaves out - commit a new file before packaging it. Install it with `code --install-extension <file> --force`. Bump `version` in `package.json` for each release, with an entry in `CHANGELOG.md` - VS Code caches an installed extension by version. To publish to the Marketplace with `vsce` (`npm run package:vsce`), add a `repository` field to `package.json` first.

## Ground rules

- **No runtime dependencies.** Everything is plain Node.js and the VS Code API. The one thing shipped from outside is Monaco Editor in `media/monaco/` (MIT, Microsoft) - only the files the merge editor loads; `scripts/check-package.js` checks they are all there.
- **Nothing ever deploys.** Validation is check-only; a test enforces that every `deploy start` carries `--dry-run`. Git is read-only. Copado is written only when the user confirms an upload, a status or the re-create checkbox.
- **Nothing is resolved without the user.** A merge is a suggestion until it is reviewed; the merge editor marks everything either branch has.
- **A test with every change.** Unit checks go in `test/smoke.js` / `test/smoke3.js` (the engine, and the VS Code-facing modules against a stand-in VS Code); the merge editor's page in `test/browser.js`; behaviour that needs VS Code itself in `test/integration/suite/`. Add a check that fails without your change. Tests must pass on Windows and macOS too: build paths with `path.join`, never assume `/` or `\n` line endings from the file system.
- **No real org data, anywhere.** Fixtures, tests, examples and pictures use generic names - `ACME_`, `example.com`, `P12345`, `US-0012345`; never metadata, ids, usernames, promotion or story numbers from a real org. A test keeps real-looking numbers out of what ships.
- **Pictures for the README** are drawn by `node scripts/readme-images.js` (the diagrams) and `node test/browser.js media/readme/shots` (the merge editor) - redraw them when what they show changes.

## Layout

```
extension.js     entry point: diagnostics, formatting, merge sessions (the merge editor or VS Code's diff view)
release.js       package.xml, branch conflicts, validation, user stories
promotionUi.js   promotions on the Release Assistant page
releasePage.js   the Release Assistant page        media/page.js   its script
quickMerge.js    one-click merge of the conflict/metadata pair
treeView.js      the side bar's Merge section
media/merge.*    the merge editor's page            media/monaco/   Monaco Editor (MIT)
src/             the engine - no VS Code dependency, fully unit-tested: merge, mergeAlign (the merge
                 editor's pieces and moves), xmlCompare, mergeStart, mergePanel (the panel), registry and
                 keys (what identifies each metadata element), the Copado side (copadoClient, promotion,
                 promotionWork), guard (the team policy), ...
scripts/         packaging and checks - plain Node
test/            smoke.js and smoke3.js, browser.js, integration/, fixtures/
```
