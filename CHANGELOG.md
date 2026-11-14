# Changelog

## 3.9.2

- The Release Assistant page uses the full width: VS Code gives every webview's body side padding, which left a strip on each side of the page; it is taken off, as the merge editor already did.

## 3.9.1

- Fixed: in a FlexiPage, an action or a field in a list (`valueListItems`) is matched by its value. A shortened visibility rule showed as the action *moved* and *changed* into another one, with the original *removed*; now it is that rule's edit - the criterion taken out. A field replaced by another is one out and one in, not a move and an edit. Merging matches them the same way.
- The page's bar starts with its tabs: the tab's own title names it.

## 3.9.0

- **One Promotions tab** for what Home and Promotions were: one box opens a promotion or a story, your recent promotions, the tools. The page's tabs are **Promotions**, **Stories** and **Manual**.
- **Manual is always there**, with or without Copado access - the Manual Tools setting is gone. Manual merge in the tools opens it (it could open Promotions instead).
- **Components**, redesigned: filters with counts and a name filter; one line per component in columns - its action as a tag, its story, where it stands with an icon; type groups that fold, each with what needs doing in it; a conflict opens its file.
- **The merge editor**: hidden lines show as *61 hidden lines*, with expand arrows in the line-number column - no button; a click anywhere on the row shows them. Row buttons are an icon and a word in the row's colour (*Restore*, *Undo*, *Remove copy*, *Use feature*). A duplicate of lines you added shares their row - *Added by you · Duplicate of line 269* - with both actions side by side. The toolbar: ↑ *2 of 7* ↓, **View**, **Save & Close**, and **⋯** at the far right.

## 3.8.3

- **Unsaved changes are never lost.** A merge whose tab is closed, or that another merge replaces, keeps your unsaved changes as a draft and says so; opening that file's merge again offers them back. Discarding or saving clears it.
- **The merge editor**: the hidden-lines bar is a quiet band - an unfold icon, *61 unchanged lines*, **Show** - opened with a click anywhere on it. Every button is a drawn icon of one size and weight, on the rows and in the toolbar. One **Save and close** button: Ctrl+S saves and keeps the editor open. A manual merge has **Copy result**, and *Save as file…* in the **⋯** menu.
- Fixed: a comment just before an element now belongs to it - **Restore** puts both back - and a comment added or taken out between elements shows as a change instead of putting the panes out of line. An emptied file says it is empty. A button whose lines you have just changed does nothing, and says so.

## 3.8.2

- **The release pipeline is gone from Home**, and with it what read it from Copado: Home is one box to open a promotion or a story, your recent work and the tools. Nothing is read from Copado until you open something. The README opens with the merge editor.

## 3.8.1

- **A new README**: what the extension does, feature by feature, each with a real picture of its screen - all the same size, theme and frame - then getting started, safety, the settings teams change most, development and the licence. The old diagrams, screenshots and the list of VS Code's own keys are gone. No change to what the extension does.

## 3.8.0

- **Home** on the Release Assistant page: the release pipeline - the stages in order, the stories in each environment, what is moving between them and where it is stuck - read from Copado, nothing changed; a pipeline to choose; one box to open a promotion or a story; what needs you; recent work; tools. Opening a promotion from anywhere shows it.
- **The merge editor**: each change's row is one word in its colour, with icon buttons whose names are their tooltips. **Duplicates are marked in the editor** - the row says which line a copy repeats, ⚠ in the margin, an underline, no pop-up - and removed with one click; identical duplicates are removed once when the merge is prepared, also when it starts from a branch's file (duplicates that differ are a choice, and are marked). **While the XML is not valid**, the place it breaks is underlined and what you type keeps a dotted margin. Hidden lines are one bar, as in VS Code, opened with a click. The toolbar is ↑ ↓ **View** (Start from, Hide identical lines, Target in literal order) **⋯** (keyboard shortcuts, merge report, swap, Discard - which asks first) and the save buttons; messages are in a status bar; **F8** goes to the next problem.
- **Manual** on the page - for work without Copado access: two versions pasted, dropped or chosen, each with what it is, merged in the merge editor with **Copy result** and **Save as file…**; a package from a Copado commit file. Shown while no Copado org is set (`cmr.page.manualTools`); right-click an XML file → **Merge in Release Assistant…** opens it with that file.
- **A story's page** has **Validate from the branch**, **package.xml** and **Story report**.
- **Removed**, as redundant now: VS Code's diff view for merging and the side bar's Merge section (the merge editor does all of it), quick merge (the Manual tab), *Use as Target* / *Merge This File Into Target* / *Resolve Metadata Conflict (two files)* / *Compare Two Files*, and Prepare, Inspect and Validate from the feature branch as separate commands - 55 commands down to 26.
- The README shows the release, CI, licence, VS Code and Salesforce CLI badges; the repository has a security policy and issue and pull-request templates. **Needs VS Code 1.85 or later.**

## 3.7.0

- **Components** on a promotion's page: what its stories committed - from Copado's promotion change list, else each story's commit - grouped by type, with the action, the stories, and where each stands: a conflict (to resolve, resolved, in Copado - a click opens its file), from the branch or not on the branch after a pre-check, or in the commit. Filter by conflicts or by not on the branch; read once, read-only.
- Fixed: a component whose name has special characters could be reported missing in a pre-check though it was on the branch - a profile such as "[A] R&D System Administrator", whose file is "%5BA%5D R%26D System Administrator.profile-meta.xml": `&`, `'` and `+` were not encoded when its file name was worked out. Now they are, and a component not found under the names worked out is found by its decoded name in its folder, whatever Salesforce encoded.
- Fixed: such a component's resolution did not match the commit's component, so one not resolved yet could be taken from the branch in a pre-check instead of being left out, and a Copado deployment error on it was not linked to the resolution. Names from file paths are decoded now, as Copado names them.

## 3.6.0

- **Hide identical** in the merge editor: runs of lines that are the same on both sides fold away, keeping three lines around every change, move and conflict. A row "⋯ 223 identical lines" with **Show** stands in for each run, in both panes alike, so they stay level; going to a line inside one - Ctrl+G, a find match, a click - opens it. The choice is kept for the next merge (`cmr.merge.hideIdentical`).
- The merge editor's toolbar stays on one line at any width: the title and the summary give way, the buttons do not; previous and next change are ↑ and ↓ (Shift+F7, F7).

## 3.5.5

- **Releases from CI.** Bump the version, add its changelog section, push to main: the whole test workflow runs, and if it passes the `.vsix` is built, the tag is made and the GitHub release is published with the notes and the `.vsix` (`.github/workflows/release.yml`). A tag pushed by hand releases the same way, if it matches the version. No change to what the extension does.

## 3.5.4

- Fixed: the unit test for the VS Code tests' short user-data folder tried to make macOS's `/tmp` folder on Windows, where it does not exist. It now checks the choice of folder for every system without making anything, and makes one only for the system it runs on. No change to what the extension does.

## 3.5.3

- **The VS Code tests run on macOS.** VS Code gets a short user-data folder of its own: it opens a socket there, and macOS allows a socket path of at most 103 characters - the test runner's default folder, inside the checkout, made it longer on CI. A failed run now tidies up its temporary folders before it exits. No change to what the extension does.

## 3.5.2

- **CI on every system.** The VS Code tests find VS Code's program on macOS whatever a VS Code build names it - VS Code 1.146 no longer has the `Contents/MacOS/Electron` that the test runner looks for, so the macOS job could not start it. The tests' temporary folders are removed patiently on Windows, where Windows Defender or the search indexer can hold a file just written - a test whose checks passed no longer fails on its clean-up. No change to what the extension does.

## 3.5.1

- **The README describes the extension as it is now**: the Release Assistant page, the merge editor and its marks, Start from, its keys; validation from the project as it is or from a story's feature branch. Its pictures are redrawn with what they show today, and the merge editor's are real renders of its page.
- **For GitHub**: the tests and checks run on Linux, Windows and macOS (line endings fixed by `.gitattributes`); `npm run package` builds the `.vsix` in plain Node and `npm run package:check` checks it, including activating from it; `npm run check` finds unused code; the merge editor's browser tests install Playwright from npm and wait for what they check rather than a fixed time; the VS Code tests cover the merge editor and VS Code's diff view. No change to what the extension does.

## 3.5.0

- **Nothing is merged behind your back.** Your resolution starts where **cmr.merge.startFrom** says: by default the merged result only for permission sets, profiles, labels, translations and objects - files often retrieved in part, where an entry the feature branch lacks is not a removal - and the feature branch's file for everything else (pages, layouts, flows...), so its removals count. **Start from** in the merge editor switches between the feature branch, the target and the merged result in one step that Ctrl+Z undoes.
- **What the feature branch does not have is shown**, whatever the start: still in your resolution - "Not in the feature branch · still here", in orange, with **Remove**; not in it - "Not in the feature branch", struck through, with **Restore**. And a value the feature branch changed where you have the target's: "the feature branch has another value", with **Use feature**. Where order matters only; not in permission sets, profiles, labels or object fields.
- **The promotion page no longer offers to accept in one click a merge that would keep what the feature branch removed** - nor resolves it automatically: "N blocks the feature branch does not have - review in merge".
- **A FlexiPage component the feature branch changed is merged inside it**, matched by its identifier - before, it could be added a second time, next to the target's.
- **The merge editor's keys are VS Code's**: cut, copy and paste through VS Code's clipboard (never pasting twice), in the right-click menu too; select all, undo and redo, find and replace, go to line, move, copy and delete lines, comment out, indent, multiple cursors - Cmd for Ctrl on a Mac; the ⌨ button lists them.
- **Horizontal scrolling stays in step** in both panes, as vertical scrolling does.
- A click on a row between lines - a change's header, struck-through lines - puts you in the editor on the line after it.

## 3.4.0

- **The merge editor: Review in merge opens in the extension's own panel** in place of VS Code's diff view. The target on the left, read-only; your resolution on the right, in a real editor (Monaco, the editor VS Code is built on, shipped inside the extension); the two lined up element by element, so the red and green mark only real changes.
- **Moves.** The left side is the target in your order, so a block you moved sits level with itself: one purple row says what moved and where to ("1st → 3rd", and whether anything inside changed), with **Move back**. Found only where order matters - a page's items, a flow's elements - not in a permission set or profile, which Salesforce sorts itself. **Literal order** shows the target as it is.
- **What you removed is shown where it was, struck through**, with **Restore**; what the feature added and you left out, with **Add it back**. Every change has its row and its button - Restore, Undo, Use target, Move back, Use target / Use feature where both branches changed a value - and each is one edit that Ctrl+Z undoes.
- As you type, the marks follow; while the XML is not valid they pause and say so. F7 / Shift+F7 go to the next and previous change.
- Save (Ctrl+S) saves as your resolution and stays open; Save and close applies, with the same checks as before. A plain merge (Merge two files) has Apply and close, as before.
- The setting **cmr.merge.editor** ("vscode") brings back VS Code's diff view.

## 3.3.0

- **XML compared element by element in Review in merge.** Metadata XML repeats the same lines everywhere, so the line comparison could pair a deleted block's lines with the next block's and show one change in two wrong places. Elements are now matched by what they are - the metadata type's key (fieldPermissions by field, ...), an identity like <identifier>, <fullName> or <name>, a single value, or the element a wrapper holds - and lists whose order is their meaning (layout columns, flow conditions, visibility criteria) in order, identical ones first. A deleted block is one change, where it was; a changed value is one change, named by what it is: "uiBehavior: none → required", "Account.X__c editable: true → false", "fieldInstance RecordRegion_cField (10 lines)". Works for every XML type, including ones the extension has no rules for.
- Long text inside one element - a formula, a JSON schema - is compared line by line within it, like code; spaces alone are not a change.
- Restore, Undo, Use target and Add it back work on whole elements and put things back where they were.
- While your resolution is not valid XML, the marks hold their last good state ("marks paused").
- One place per change: the rows above lines when VS Code shows them in diff views, otherwise the notes at the line ends - not both.

## 3.2.1

- **Fixed: Review in merge showed little of what 3.2.0 promised.** Two reasons, both fixed:
  - your resolution was compared only with the target, so a line you took back out of the suggestion - the usual case - left no mark. It is now compared with the feature branch too: "left out from the feature: ..." where it would go, with Add it back.
  - VS Code hides CodeLens rows in comparison views unless "Diff Editor: Code Lens" is on, and the merge view is one - so the rows with Restore and Undo did not show. What was removed, left out or changed is now written at the end of its line by VS Code itself (in red, or blue for your own edits), which shows in any view; the hover explains it with its action as a link; and each item in the Merge panel has the action as a button. The first time a merge view opens, it offers to turn the setting on for the rows as well.
- The Merge panel lists what was left out from the feature branch.

## 3.2.0

- **Review in merge shows everything.** Your resolution is marked against both branches as you type: green for what came from the feature branch, blue for your own edits, and a red mark where you removed something the target has - with the removed text right there ("Removed here: ...") and in the hover. Each change has its one action - Restore, Undo or Use target - which only acts if the lines are still where they were. The Merge panel lists them by kind (Removed by you, From the feature branch, Your own edits); the scrollbar marks them across the file.
- **Saving keeps the merge view open.** Ctrl+S saves your resolution and you go on working; Save and close (the ✓) closes it.
- **Fixed:** Review in merge reopened on a resolution you had saved lost its highlights and conflicts. It now marks it against both branches and finds the conflicts again in what you saved.
- **Simpler words.** "Validated successfully" or "Validation failed" with the errors, instead of "it would deploy"; shorter texts on the Pre-check tab (Collect, Prepare files, Validate), the banner, the cards, notifications and the log.

## 3.1.0

- **A quieter sidebar.** The Promotion view is gone - the Release Assistant page does all of it - with its commands (15, including three old names from 2.4 and 2.5). What stays shows only when it has something: Merge while a merge view is open, Deploy Check when there is a package or a validation, Branch Conflicts when there is a branch check. Otherwise the sidebar is one button to the page, with links to validate a deployment, build a package.xml from a commit, and check branch conflicts. Open Promotion from Copado now opens the page.
- **Steadier:**
  - one Copado action at a time on the page - a second Upload (or Refresh, Undo, Edit again...) while one runs is told so instead of running twice;
  - an expired Salesforce login while following a deployment is shown on the Deployment tab instead of stopping it silently;
  - a resolution saved in the merge view that cannot be applied says why;
  - a sidebar section is focused only once VS Code shows it;
  - the page can run only the commands its buttons use;
  - the busy cursor stays on until every running action is done;
  - the deployment watch stops with the extension.
- Fixed: opening a promotion still tried to focus the removed Promotion view.

## 3.0.10

- **Review in merge, then save: that is your resolution.** Saving your resolution in the merge view applies it - through the same checks as Apply - and the file moves on to Ready to upload; no separate step, and no extra editor opens. Take back any suggested lines with the arrows between the sides, keep the target exactly, or change anything else: what you save is what goes up. Opened again, Review in merge starts from what you saved, not from the suggestion worked out anew. Merge two files is unchanged.
- **Removed** the Choose what to keep options (keep the target, take the feature, change by change) - Review in merge does all of it.

## 3.0.9

- **Your call on every file.** Whatever the extension suggests, Choose what to keep offers: keep the target as it is (no change - the target's file exactly, its formatting too), take the feature branch's version, or go through the suggestion change by change and keep only what you want. Each added or removed element is its own choice - two fields added side by side are two choices - shown with what it adds or removes and where. Any choice is checked before it is written: never conflict markers, never XML that is not well-formed.
- **Sides named for what they are.** In the merge view: "Target branch (HEAD) ↔ Your resolution (editable)" and "Feature branch (feature/...) ↔ Your resolution (editable)"; Compare sides: "Target branch (HEAD) ↔ Feature branch (...)"; the same names in the page's clash choices and Details. Merge two files keeps its own wording.

## 3.0.8

- **Nothing is resolved without you.** A new setting, Copado › Promotion: Auto Resolve, is off by default. Off: a clean merge is offered as a suggestion that you review and accept ("Accept the suggestion"), and code keeps every conflict block for you to decide - even blocks both sides agree on. Files an earlier version resolved automatically, and not yet uploaded, come back to you to review. Turn the setting on for the earlier behaviour.
- **The pre-check on the page.** A Pre-check tab follows the run step by step - find what to check, prepare the files, check with Salesforce, result - with its progress in plain words, what was checked, what was left out, and every problem with a link to your resolution. The Output panel no longer opens for it.
- **The pre-check checks your resolutions.** Every conflict file is checked as resolved: your resolved file, what you uploaded, or the resolution made in Copado's editor (fetched first). A file not resolved yet is left out of the check - before, it was quietly taken from the feature branch instead.

## 3.0.7

- **Loading and progress messages in plain words.** The notifications say what is happening for you - "Opening P12345", "Saving your resolutions to Copado", "Checking how P12345 is going in Copado" - without org aliases in brackets or internal steps. A validation's notification says where it checks and how far it is ("Checking components (12 of 40)", "Running tests (3 of 10)", "Waiting for Salesforce"); the Salesforce CLI's own lines stay in the Output panel. On the page: "Promotion branch of P12345 would deploy to uat" instead of "validated against ... as ...", "Updating live" on the Deployment tab, and plainer cards.

## 3.0.6

- Fixed: choosing a side for a real conflict wrote only the first line of the value. A value that spans lines - a permission set's description, often - kept the rest of the old one and its end tag, so the file was not valid XML ("Unexpected closing tag </description>"). Now the whole element is replaced, and a choice never writes a file that is not well-formed. Resolutions broken this way are rebuilt from your recorded choices when the promotion opens or refreshes - only when the file is exactly what the earlier version produced, so nothing you edited is touched.
- Fixed: a successful run on the Deployment tab could show a "component error" that was really Copado's list of what it deployed. Only a run that failed has component errors, and a list of components is never read as one.

## 3.0.5

- **Back to all promotions from an open one**, to open another: the back arrow beside the promotion's name in the top bar, or Promotions clicked again. The start screen has the field to open one and the recent promotions.
- Fixed: the stage track's circles showed through dialogs, such as the upload dialog.

## 3.0.4

- Fixed: the description of Repository › Promotion branch used a real promotion number as its example; it uses `P12345` now, like the rest of the extension. A test keeps real-looking promotion and story numbers out of what ships.

## 3.0.3

- **Edit again after a failed validation.** A resolution already in Copado - uploaded from here or made in Copado's editor - can be changed: Edit again fetches it as Copado holds it now; uploading replaces its content in Copado (its name stays), only if Copado still holds the version you started from, read back, and undoable. Files that Copado's latest run failed on, or that are not well-formed XML, are listed first under "Needs another look". When every conflict is in Copado, an Overview shows what comes next.
- **Re-create promotion branch.** A switch for Copado's checkbox on the promotion, found by its name or label (or Copado › Re-create branch field). Replacing a resolution offers to tick it. It is unticked by itself once Copado's next validation or deployment after the tick succeeds - a merge job succeeding does not count. A box ticked in Copado directly is unticked the same way, counting from when the extension sees it.
- **The right error on the Deployment tab.** The validation's job is found where Copado keeps it - under the deployment, not only the promotion - and each record is shown once. Only the newest run's errors count; earlier runs are folded away as history. Copado's own error form ("Type:Name:problem", lines joined by \n) and its Error Details file are read, and each error links to the resolution it is about.
- Fixed: the upload check let XML through that was not well-formed - a root element never closed, a mismatched end tag, text or a second element after the root - and skipped XML checks entirely for an XML file that had been merged as text. Now every XML resolution is checked the way Salesforce reads it, with the line.
- Fixed: the same error kept twice by Copado (cut short in a field, whole in a file) is shown once, with its full text.

## 3.0.2

- **A fresh look for the page**, still in your VS Code theme's colours and font: the stages are one track - passed ones filled, the current one ringed, the next one dashed - for a promotion and for a story's journey alike; soft status pills; Files, Deployment and Activity as a segmented control; the selected file marked on its edge; aligned recent promotions; Activity as a timeline. The masthead is shorter, so the file you are resolving gets more of the screen.
- **No more loading line at the top of the page.** Progress shows in VS Code's notification at the bottom right - now also for Check now on the Deployment tab, Refresh, Undo upload, the pre-check's reading of components and branches, and a story's journey. Following a running deployment in the background shows none.
- Fixed: on first open, the file shown on the right was not highlighted in the list.

## 3.0.1

- **Removed**: the Pipeline and Releases views, and what only they offered - the pipeline map with open promotions per step, the release view and release readiness report, the conflict forecast across a release or into an environment, and org vs branch drift. The page has two views now: Promotions and Stories.
- The readiness report stays, for a promotion: its stories, components, validations per stage, coverage, open conflicts, and components changed by more than one of its stories.

## 3.0.0

- **Validate the promotion branch** - a promotion without open conflicts is validated from `promotion/{promotion}` (Repository › Promotion branch): its components from Copado's change list, check-only against its destination. Any promotion opens now, not only ones in conflict.
- **Stage rules** - `copado-policy.json` (or Guardrails › Environments) gains `environments`: per Copado environment a minimum test level, the login it must be validated as, and a coverage minimum checked per class. Validations say who they run as, in the output and on the page.
- **Repository from Copado** - with no address set, it is read from the pipeline's Git Repository record (SSH forms included) and only a token is asked for. A story's branch is taken from Copado's records when they name it; a missing branch is said plainly.
- **Pipeline, Stories and Releases** on the page - the pipeline's stages with each environment's branch, login and open promotions; a story's journey and its next stage; a release's stories with what holds them up.
- **Conflict forecast** - components changed by more than one story heading to the same environment or in the same release.
- **Back-promotions** are recognised (Copado's flag, else the pipeline's direction), their sides named accordingly, pre-checked from the source environment's branch. **Hotfixes** - stories based on the production branch - are shown with their own route.
- **Copado's deployment, followed** read-only on the Deployment tab, job records found by describe; component errors go to Deploy Check with the usual fix advice.
- **Release readiness report** and **org vs branch drift** (read-only retrieve into its own workspace), both written under `.copado/reports/`.
- **Corporate proxies** - `cmr.http.proxy`, VS Code's Http: Proxy or `HTTPS_PROXY` (CONNECT tunnel, proxy login, `NO_PROXY`), and an extra CA file. Copado access no longer falls back to the CLI behind a proxy.
- **Removed**: downloading and importing selective-commit files, and their three settings - validations read the committed versions from the branch.
- Fixed: the team policy was not applied to validations from a branch or the pre-check; Re-validate after a branch check used the wrong package; Apply Fix could write a branch check's package into the project; a redirect to another host carried the Salesforce token; a refused target was reported only after the test questions.

## 2.9.1

- **Branch checks get their own `.forceignore`** (the branch's, or an empty one), so the Salesforce CLI no longer uses the project's - which skipped every file under the `.copado` folder and reported "No source-backed components present in the package".
- An empty package is reported before the CLI runs, and the output lists the package's components by type.

## 2.9.0

- **Validation always uses the branch.** Preparing a story validates from its feature branch, and the promotion pre-check builds its workspace from the stories' feature branches with the resolved files on top - nothing is retrieved from the source org, and the project is never touched.
- Removed with it: the "retrieve, then validate" choice, the source-org picker, the drift warning and the pre-check's project overlay and its undo.
- **A short Command Palette**: 12 starting points; everything else is on the Release Assistant page, the panels and the context menus.

## 2.8.0

- **Validate a user story from its feature branch** - the components come from the story's commit file, their files from the branch exactly as Copado committed them (permission sets and profiles included, without other people's dev changes), in a separate check workspace; the project is never touched.
- **Repository connectors** for Azure DevOps (including *.visualstudio.com and Server), GitHub (including Enterprise), GitLab (including self-managed) and Bitbucket Cloud - read-only, with the token in VS Code's encrypted secret storage. **Connect Repository** runs the same checks as by hand.
- **Drift warning** - after a retrieve, components someone else changed in the source org are flagged; when the story was prepared from Copado, only changes after your last commit.

## 2.7.1

- **Selective commits are applied after the retrieve** during a validation, over whatever it brought back - so a retrieved parent, such as a CustomObject with its fields, can never overwrite a committed child.

## 2.6.0

- **Promotion panel** - open a promotion by number, story or Copado link; every conflict file fetched at once in parallel into `.copado/promotions/<promotion>/`, kept across sessions, refreshed without overwriting work done in Copado.
- **Automatic pass** - metadata where both branches only added entries is merged with no decision; agreed code blocks are settled. Only real clashes are left to review.
- **Upload all** - one confirmation, per-file checks (no markers, valid XML of the right type, no duplicates or deploy-breaking errors), parallel uploads each read back, the status after the last file, and batch undo.
- **Pre-check** - the promotion's components retrieved from its source org with the resolved files on top, validated check-only against its destination org before anything is uploaded.
- **Faster Copado access** - one login per session, queries, describes and downloads sent directly to the REST API in parallel, describes cached for a day; the CLI is used behind a proxy or when direct requests fail.
- The one-file-at-a-time commands of 2.4 and 2.5 now open the Promotion panel.

## 2.5.0

- **Upload promotion resolutions to Copado** - the conflict attachment renamed `RESOLVED ...` with the resolved content, as Copado's editor does; refused if resolved or changed in Copado meanwhile; read back byte for byte; after the last file, the promotion's status set to the org's "Conflicts Resolved" value when it still says merge conflict. Logged, with **Undo Last Copado Upload**.

## 2.4.0

- **Resolve Promotion Conflicts from Copado** - conflicted files fetched from the promotion, split into their sides (and common ancestor), merged in VS Code, and copied for pasting into Copado. Read-only.
- **Inspection** opens the resolution manifest and promotion change list first, names the record each file belongs to, and shows the branch labels on conflict markers.

## 2.3.0

- **Prepare User Story from Copado** - one story number brings its commit file (as the package), its selective-commit files and the orgs for its environment and the next one in the pipeline, then validates.
- **Inspection** never opens attachments named like keys or credentials, describes other JSON files by their key names only, and recognises selective-commit files stored on a story as `<hash>_commit`.
- **Downloads** work with Salesforce CLIs that lack `sf api request rest` however they word it, asking only once per session and reusing one login.

## 2.2.0

- **Inspect User Story in Copado** - a read-only report of what the Copado org holds for a story: commits and their files, metadata records, promotions and their attachments, pipeline branches, environments and local logins. Works across Copado versions by querying only the fields the org has.

## 2.1.0

- **Guardrails** - a committed `copado-policy.json` (or the Guardrails settings) allows or blocks target orgs, can rule out production, and sets a minimum test level per org; a broken policy blocks instead of allowing everything.
- **Workspace Trust** - in an untrusted folder the Salesforce CLI and git are never run, and a folder's own values for the CLI path, Copado org and project path are ignored until it is trusted.
- **Safe logs** - session tokens are always masked; optionally usernames, emails, org and user ids and My Domain addresses too, in the output and in copied reports.
- **Download selective-commit files straight from Copado** through the Salesforce CLI, by file id - from a command or from the validation prompt.
- **Integration tests inside a real VS Code** on Windows, macOS and Linux in CI, alongside the unit suite.

## 2.0.0

- **package.xml from Copado commit JSON** - Add, RetrieveOnly, Delete and SelectiveCommit actions; several user stories combine into one package; pre-flight warnings for standard fields, partial profiles, Apex tests and selective commits.
- **Retrieve and check-only validation** in source format, with org pickers, test class selection, suggested fixes in a Deploy Check panel, and Re-validate that never retrieves over your fixes.
- **Selective commits imported from Copado's downloads** - files named after their `selectiveCommitHash` are recognised in `conflict/selective`, checked, and copied into the project before a validation, with a backup and an undo.
- **Live CLI progress** in the output panel, shown as snapshots only when the CLI's words change, with one elapsed timer in the notification.
- **Branch conflicts** found with `git merge-tree` and merged using the git merge-base - read-only.
- **Two-file merge** for Copado's manual conflicts, running in a background thread, plus **quick merge** for a pasted `conflict/metadata` pair with optional auto-merge.
- **Checks as you type** - duplicates by Salesforce identity and twelve deploy-breaking rules.
- **Salesforce's own order** when formatting, so retrieved files come out unchanged.
- Everything stays inside the project: `manifest/`, `force-app/`, and a self-ignoring `.copado/` working folder.
