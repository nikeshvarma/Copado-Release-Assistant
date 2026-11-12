# Contributing

Thanks for helping. A few things keep this project easy to work on.

## Run it

```bash
git clone <this repository>
cd copado-release-assistant
npm test            # node test/smoke.js - no dependencies to install

# the extension inside a real VS Code (downloads VS Code once)
npm install --no-save @vscode/test-electron
npm run test:vscode # on Linux without a display: xvfb-run -a npm run test:vscode
```

Open the folder in VS Code and press **F5** to start an Extension Development Host with the extension loaded. `samples/` has two permission sets to try a merge on.

## Package it

```bash
npx @vscode/vsce package
```

This writes `copado-release-assistant-<version>.vsix`, which installs with `code --install-extension <file> --force`. Bump `version` in `package.json` for each release - VS Code caches an installed extension by version.

## Ground rules

- **No runtime dependencies.** Everything is plain Node.js and the VS Code API.
- **Nothing ever deploys.** Org operations are retrieve and check-only validation; a test enforces that every `deploy start` carries `--dry-run`. Git is read-only.
- **A test with every fix.** Unit checks go in `test/smoke.js`; behaviour that needs VS Code itself goes in `test/integration/suite/`.
- **Tests for the engine** `test/smoke.js` covers the merge engine, formatting, the CLI wrapper (against a stand-in CLI in `test/fixtures/fake-sf.js`), and the VS Code-facing modules (against a stand-in VS Code). Add a check that fails without your change.
- **No real org data in fixtures.** Use generic names such as `ACME_` and `example.com`; never commit metadata, IDs or usernames from a real org.

## Layout

```
extension.js     entry point: diagnostics, formatting, two-file merge session
release.js       package.xml, branch conflicts, retrieve and validation
quickMerge.js    one-click merge of the conflict/metadata pair
promotionUi.js   the Promotion panel and its commands
treeView.js      the Merge panel
src/             the engine - no VS Code dependency, fully unit-tested
                 including the Copado side: copadoClient (one session, parallel REST), copadoInspect,
                 promotion (conflict files, upload, status), promotionWork (the local workspace,
                 automatic pass, checks, batches, pre-check)
test/            smoke.js and fixtures
```
