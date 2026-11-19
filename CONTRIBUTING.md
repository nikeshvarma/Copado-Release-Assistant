# Contributing

Thanks for helping. A few things keep this project easy to work on.

## Run it

```bash
git clone <this repository>
cd copado-release-assistant
npm test                  # the unit tests - no dependencies to install
npm run check             # no unused code - an export is not a use, a module nothing requires is found; the extension activates with every command

# the merge editor in a real browser, with the real Monaco
npm install --no-save playwright && npx playwright install chromium
npm run test:browser      # without Playwright it says "skipped"; CI_REQUIRE_BROWSER=1 makes that a failure

# the extension inside a real VS Code (downloads VS Code once)
npm install --no-save @vscode/test-electron
npm run test:vscode       # on Linux without a display: xvfb-run -a npm run test:vscode
```

Open the folder in VS Code and press **F5** to start an Extension Development Host with the extension loaded. `samples/` has two permission sets to try a comparison on.

GitHub Actions runs every one of these on each push and pull request (`.github/workflows/test.yml`): the unit tests on Linux, Windows and macOS with Node 20 and 22; the checks and the package; the browser tests; the VS Code tests on all three systems.

## Package it

```bash
npm run package           # dist/copado-release-assistant-<version>.vsix - plain Node, nothing to download
npm run package:check     # what it must hold and must not, and that it activates from itself
```

The package is the files git tracks, less what `.vscodeignore` leaves out - commit a new file before packaging it. Install it with `code --install-extension <file> --force`. Bump `version` in `package.json` for each release, with an entry in `CHANGELOG.md` - VS Code caches an installed extension by version. To publish to the Marketplace with `vsce` (`npm run package:vsce`), add a `repository` field to `package.json` first.

## Release it

1. Bump `version` in `package.json` (`3.5.5` → `3.5.6`; a pre-release such as `3.6.0-beta.1` is marked so on GitHub).
2. Add its section to `CHANGELOG.md`, headed exactly `## 3.5.6` - it becomes the release notes.
3. Commit and push to `main`.

`.github/workflows/release.yml` sees a version with no tag yet, runs the whole test workflow - every system, the browser, VS Code - and only if it passes builds the `.vsix`, makes the tag `v3.5.6` and publishes the GitHub release with the notes and the `.vsix` attached. It stops, with the reason, for a version with no changelog section, or a tag pushed by hand that is not the version. A push that does not change the version releases nothing. Running it again for a published version replaces its `.vsix` and notes. `node scripts/release.js plan` and `notes` show what it would do.

## Ground rules

- **No runtime dependencies.** Everything is plain Node.js and the VS Code API. The one thing shipped from outside is Monaco Editor in `media/monaco/` (MIT, Microsoft) - only the files the merge editor loads: the editor, and the colours of XML, Apex, JavaScript, HTML and CSS (their language services are not shipped - they need a worker, and the merge editor runs none); `scripts/check-package.js` checks they are all there.
- **Nothing ever deploys.** Validation is check-only; a test enforces that every `deploy start` carries `--dry-run`. Git is read-only. Copado is written only when the user confirms an upload, a status or the re-create checkbox.
- **Nothing is resolved without the user.** A merge is a suggestion until it is reviewed; the merge editor marks everything either branch has.
- **A test with every change.** Unit checks go in `test/smoke.js` / `test/smoke3.js` (the engine, and the VS Code-facing modules against a stand-in VS Code); the merge editor's page in `test/browser.js`; behaviour that needs VS Code itself in `test/integration/suite/`. Add a check that fails without your change. Tests must pass on Windows and macOS too: build paths with `path.join`, never assume `/` or `\n` line endings from the file system.
- **No real org data, anywhere.** Fixtures, tests, examples and pictures use generic names - `ACME_`, `example.com`, `P12345`, `US-0012345`; never metadata, ids, usernames, promotion or story numbers from a real org. A test keeps real-looking numbers out of what ships.
- **Pictures for the README** are real renders of the extension's screens with generic sample data, all 1280×760, dark theme, in the same frame. The merge editor's come from `SHOT_SIZE=1280x760 node test/browser.js <folder>`. Redraw a picture when what it shows changes, and keep the set consistent. Report security issues privately - see [SECURITY.md](SECURITY.md).

## Layout

```
extension.js     entry point: diagnostics, formatting, merge sessions in the merge editor
release.js       package.xml, branch conflicts, validation, user stories
promotionUi.js   promotions on the Release Assistant page
releasePage.js   the Release Assistant page - Promotions, Stories, Manual, Compare      media/page.js   its script
manualUi.js      the page's Manual tab: two versions compared side by side, a package from a commit file
lifecycleUi.js   the page's Stories: a story's journey, validate, package
compareUi.js     the page's Compare: two branches of the connected repository (src/compareBranches: by type, in a few words)
media/merge.*    the merge editor's page            media/monaco/   Monaco Editor (MIT)
src/             the engine - no VS Code dependency, fully unit-tested: codeMerge (Copado's conflict file - its
                 conflicts, found again as you edit), unionMerge (permission sets and profiles: the target, the feature
                 added), mergePanel (the panel - one, two or three panes), merge and mergeAlign (metadata by element -
                 Branch conflicts, the union types' marks), codeChecks, mergeDuplicates, xmlCompare, mergeStart,
                 registry and keys (what identifies each metadata element), repoHost (the repository: branches, files,
                 changed files), borrow (what a pre-check lacks, from the source org), retention (old working files),
                 the Copado side (copadoClient, promotion, promotionWork), guard (the team policy), ...
scripts/         packaging and checks - plain Node
test/            smoke.js and smoke3.js, browser.js, integration/, fixtures/
```
