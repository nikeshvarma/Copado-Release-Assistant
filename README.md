<p align="center">
  <img src="media/logo.png" width="76" alt="">
</p>

<h1 align="center">Copado Release Assistant</h1>

<p align="center">
  Resolve Copado promotion conflicts and validate user stories — without leaving VS Code.
</p>

<p align="center">
  <a href="https://github.com/nikeshvarma/Copado-Release-Assistant/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/nikeshvarma/Copado-Release-Assistant?label=release"></a>
  <a href="https://github.com/nikeshvarma/Copado-Release-Assistant/actions/workflows/test.yml"><img alt="CI" src="https://github.com/nikeshvarma/Copado-Release-Assistant/actions/workflows/test.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="MIT licence" src="https://img.shields.io/badge/licence-MIT-blue"></a>
  <a href="https://code.visualstudio.com/"><img alt="VS Code 1.90 or later" src="https://img.shields.io/badge/VS%20Code-1.90%20or%20later-007ACC?logo=visualstudiocode"></a>
  <a href="https://developer.salesforce.com/tools/salesforcecli"><img alt="Salesforce CLI v2" src="https://img.shields.io/badge/Salesforce%20CLI-v2-00A1E0?logo=salesforce"></a>
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#getting-started">Getting started</a> ·
  <a href="#safety">Safety</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#development">Development</a>
</p>

![The merge editor: an edited value, a block moved - removed from its place, added at the new one - and a removed block struck through](media/readme/merge-editor.png)

## Features

### Promotion conflicts, resolved without losing anything

Open a promotion that stopped on a merge conflict — by its number, a user story or its Copado link, in the **Promotions** tab's one box — and every conflicted file is fetched at once. Metadata is merged for you to review — never resolved on its own — and code opens in the same merge editor, merged by its members - only what both branches changed is a choice for you. Upload all resolutions in one step, read back from Copado, with undo.

![A promotion's conflict files, each with what happened and what to do](media/readme/promotion.png)

### See what the stories committed

The **Components** tab lists every component the promotion's stories committed, grouped by type: its action, its story and where it stands — a conflict to resolve or resolved, on the branch, or not on the branch after a pre-check. Filter by what needs doing or by name; a conflict opens its file.

![The Components tab: filters with counts, one line per component, type groups](media/readme/components.png)

### A merge editor built for Salesforce metadata and code

Metadata XML repeats the same lines everywhere, so line-by-line diffs pair the wrong blocks. The merge editor lines up **element by element**, against the target exactly as it is: what the feature branch added, what you changed, and what was removed — struck through, where it was. A block moved within an ordered list is what it is to the file: removed from its place and added at the new one, each row saying where the other is, and one click puts it back. Every action is undone with `Ctrl+Z`, and nothing is merged behind your back: what the feature branch removed or changed is always marked.

Entries are matched by what identifies them — a field permission by its field, a page action by its value, a flow element by its name — including lists from the newest releases, such as Agentforce agents and topics. What Salesforce reads the same is not shown as a change: an entry's fields in another order, `<x/>` for `<x></x>`, `&#38;` for `&amp;`, other line endings, a flow's elements in another order. A flow element only dragged in Flow Builder is one quiet *Moved on the canvas* row. Unchanged runs fold away, and unsaved work is kept as a draft if the editor closes.

With the **common ancestor** — Copado's own, or the merge-base of the feature branch and the destination branch, fetched from the connected repository — the editor knows what each branch did since: the target's own later additions and changes need no mark, and what the feature removed or changed says so. An entry renamed but otherwise unchanged is one change: *Renamed labels: Greeting → Welcome*.

Duplicates and broken XML are caught as you type. A duplicate entry is marked on its own lines with the line it repeats, and removed with one click; identical duplicates are taken out when the merge is prepared. Invalid XML is underlined exactly where it breaks.

![A duplicate marked in the merge editor](media/readme/duplicates.png)

It is an editor you can work in all day: the parent elements stay pinned as you scroll, elements fold (the target with them), matching tags light up and an opening tag closes itself, **⋯ › Format XML** puts the file in Salesforce's order, and **View** has zoom, word wrap that keeps both panes level, and a divider to drag.

### Code, too

A promotion's **Apex**, **Lightning web component** JavaScript, HTML and CSS, **Visualforce** and **Aura** conflicts open in the same editor, from **Copado's conflict file** as git merged it. Git had the common ancestor, so everything only one story changed is already merged — the feature's deletions applied, other stories' work kept — and shown as plain text. Only the **conflicts** are marked: both versions shown — the target's greyed out, the feature's in its colour — neither in your resolution until you choose **Accept target**, **Accept feature** or **Accept both**. Once you choose, its row says *Resolved*, in green, the version you chose marked — still a click from changing. A version with nothing in it is a choice too: the other's lines struck through, in green. **⋯ › Accept all target** or **Accept all feature** resolves every conflict at once — one step, Ctrl+Z undoes it. The conflict markers are never shown. Saving with one not resolved warns first. **View › One panel / Two panel** shows it alone or beside the target (`cmr.merge.codeView`). Brackets that do not balance and a member defined twice are underlined as you type. VS Code's own conflict view is a setting away.

![Apex in the merge editor: Copado's conflict file, two conflicts with both versions shown and Accept target, Accept feature, Accept both](media/readme/code.png)

### Validate before Copado does

Check a promotion's resolutions, or a user story straight from its feature branch, against the target org — check-only, nothing deploys. Errors point to the right line, with suggested fixes.

![A pre-check: the steps, the errors with their files, the log](media/readme/precheck.png)

### Compare two versions, with or without Copado

The **Manual** tab — always there — compares two versions pasted from Copado's conflict screen, or any two files, side by side: nothing merged, **both sides editable**. For permission sets, profiles, labels and translations — whose entries add up — **Format and Order Metadata** and **Remove Duplicate Entries** in the right-click menu work on either side, so order and formatting drop away and only real differences are left. What only the other side has is shown struck through, in red. Each comparison starts from exactly the two versions shown — **Clear both** empties them at once. It also builds a `package.xml` from a Copado commit file. Right-click an XML file → **Merge in Release Assistant…** to start from it.

![The Manual tab: two versions to compare, a package from a commit file](media/readme/manual.png)

### Compare two branches

The **Compare** tab lists every file one branch changed since it split from another — what merging it would bring — what was removed or changed first, then what is new, grouped by metadata type, each with what differs in a few words: *4 elements differ · 1 duplicate*, *3 members differ* — a file that differs only in spacing is the same, and left out. Each branch is picked by searching for it, however many there are; **All types** narrows the list to the types you choose, **Search** to a name, **Reset** starts again; the files are shown 50 at a time. **Compare** opens a file in the same side-by-side comparison, both branches' versions editable — **F7** goes through the differences. The branches are read from the connected repository; nothing in git is changed.

![The Compare tab: two branches, the files that differ grouped by type](media/readme/compare.png)

For permission sets, profiles, labels and translations, the extension's own **Format and Order Metadata** and **Remove Duplicate Entries** are in the merge editor's right-click menu, as in VS Code's editor. Never for a layout, a page or a flow, whose order is what users see.

### And more

- **Branch conflicts** between two git branches, with the merge-base — nothing checked out or changed.
- **Checks as you type** for duplicates and deploy-breaking metadata rules - and in code, brackets that do not balance and members defined twice.
- **Formatting** in the order Salesforce writes metadata, so diffs show only real changes.
- **Team guardrails** in `copado-policy.json`: which orgs, which test levels, per environment.
- **Clean Working Files** empties `.copado/` — after listing what is there and naming any resolution not uploaded yet. Old working files are removed by themselves after `cmr.storage.keepDays`, never a resolution not uploaded.

## Getting started

**Requirements:** VS Code 1.90 or later, the [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) v2 with your orgs logged in, and git 2.38 or later for branch conflicts.

1. Download the `.vsix` from the [latest release](https://github.com/nikeshvarma/Copado-Release-Assistant/releases/latest) and install it:
   ```bash
   code --install-extension copado-release-assistant-3.16.4.vsix
   ```
2. Open your Salesforce project folder.
3. Run **Copado: Open Settings** and set **Copado org** — the Salesforce CLI alias of the org where Copado runs.
4. Run **Copado: Open Release Assistant**.

Without a Copado org, the **Manual** tab works on its own.

## Safety

- **Nothing deploys.** Every validation is check-only.
- **Git is read-only.** No checkout, merge, commit or push.
- **Copado is written only when you confirm** — uploading resolutions and setting a promotion's status.
- **No passwords.** Orgs come from the Salesforce CLI; repository tokens stay in VS Code's encrypted storage.
- **Working files stay in `.copado/`** in your project, never committed.

## Configuration

Every behaviour has a setting — **Copado: Open Settings** lists them all. The ones most teams change:

| Setting | What it does |
| --- | --- |
| `cmr.copado.org` | The org where Copado runs |
| `cmr.merge.startFrom` | Where a merge starts — `auto` uses the merged result for permission sets and profiles, the feature branch's file for everything else |
| `cmr.merge.removeDuplicates` | Remove identical duplicates when a merge is prepared |
| `cmr.merge.useAncestor` | For metadata: use the common ancestor — Copado's, or the repository's merge-base — to show what each branch did since |
| `cmr.merge.codeIn` | Open code conflicts in the merge editor, or VS Code's own conflict view |
| `cmr.merge.codeView` | Code in one panel, or two (beside the target) |
| `cmr.storage.keepDays` | Working files older than this many days are removed by themselves (14; 0 never) |
| `cmr.promotion.autoResolve` | Resolve files that need no decision automatically (off by default) |

**Write Recommended Settings to Workspace** shares a team's settings through `.vscode/settings.json`.

## Development

```bash
npm test               # unit tests - no dependencies to install
npm run check          # unused code, activation
npm run package        # builds dist/copado-release-assistant-<version>.vsix
```

Browser tests of the merge editor and tests inside VS Code are described in [CONTRIBUTING.md](CONTRIBUTING.md). CI runs everything on Linux, Windows and macOS; pushing a new version to `main` publishes the release. Report security issues privately — see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © Nikesh Varma. The merge editor includes [Monaco Editor](https://github.com/microsoft/monaco-editor) (MIT, © Microsoft).

Copado and Salesforce are trademarks of their respective owners. This project is independent and not affiliated with or endorsed by Copado or Salesforce.
