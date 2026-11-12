# Changelog

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
