# Rule book

Every rule the extension follows, by file type, numbered. This book is the specification: the behaviour changes only when this book changes first, and every new or changed rule has a test named after it (the tests' names start with the rule's number). [How resolution works](RESOLUTION.md) explains the same rules with diagrams.

Status: ✅ as built (3.22.0) · 🆕 new in 4.0 · ✏️ changed in 4.0 · **5.1** new or changed in 5.1

---

## Part A — Principles (every file)

| # | Rule | |
|---|---|---|
| A1 | A promotion's conflicts come **only** from Copado's conflict file. No branch is read, nothing merged again by the extension. | ✅ |
| A2 | Outside conflict blocks, git's merge is kept exactly as Copado made it. | ✅ |
| A3 | **Nothing is chosen for you** in a conflict: neither version is in the file until you accept one. | ✅ |
| A4 | Copado is written only when you confirm (uploading resolutions, setting a status). Repository and source org are read-only. | ✅ |
| A5 | Every choice can be undone. | ✅ |
| A6 | **A save never leaves a gap**: saving with conflicts unresolved offers *Keep the target's for N, and save* or *Go back* — nothing else. | ✏️ |
| A7 | **A file with a conflict unresolved is never uploaded** — a second guard behind A6. | 🆕 |
| A8 | Nothing from a client file enters the code, tests, pictures or package. | ✅ |

---

## Part B — How each file type is resolved

### B1. Code — Apex, LWC, Aura, Visualforce

`.cls` `.trigger` · `.js` `.css` `.html` · `.page` `.component` · `.cmp` `.app` `.evt` `.intf` `.design` `.auradoc` `.tokens`

| # | Rule | |
|---|---|---|
| B1.1 | Each git block is a conflict: **Accept target**, **Accept feature**, **Accept both** (the target's lines, then the feature's). | ✅ |
| B1.2 | An empty version is a choice: the feature's accepted → **Removed** (red, struck through); the target's accepted where only the feature added → **Left out** (grey). | ✅ |
| B1.3 | Checks once resolved: Apex, JavaScript, CSS — brackets balance; Apex, JavaScript — a member defined twice (warning). | ✅ |
| B1.4 | `cmr.promotion.autoResolve` on: blocks whose two sides are identical are settled; every other block stays yours. | ✅ |
| B1.5 | A code file's `-meta.xml` is metadata (B3). | ✅ |

### B2. Union types — permission sets, profiles, muting permission sets, labels, translations

`PermissionSet` `Profile` `MutingPermissionSet` `CustomLabels` `Translations` `CustomObjectTranslation` **`GlobalValueSetTranslation` `StandardValueSetTranslation`** 🆕

| # | Rule | |
|---|---|---|
| B2.1 | The two sides are rebuilt from Copado's file and **joined entry by entry, whatever git's blocks**. | ✅ |
| B2.2 | Entries are matched by identity: a field permission by its field, a class access by its class, a user permission by its name, a label by its full name. | ✅ |
| B2.3 | Only the target has it → **kept as it is**. | ✅ |
| B2.4 | Only the feature has it → **added** after the target's last entry of the same kind. **Never sorted automatically**: *Format and Order Metadata* sorts on request. | ✅ |
| B2.5 | Both have it, the same → **once**. | ✅ |
| B2.6 | Both have it, the feature grants **more or the same** → the feature's. | ✅ |
| B2.7 | Both have it, the feature grants **less** → a **conflict**, target or feature (never both). Less: `editable` `readable` `enabled` `visible` `allowCreate` `allowRead` `allowEdit` `allowDelete` `viewAllRecords` `modifyAllRecords` `viewAllFields` true → false; a tab's visibility lowered (DefaultOn/Visible > DefaultOff/Available > Hidden/None). In a **muting** permission set: turned on. | ✅ |
| B2.8 | A profile's security settings — `loginIpRanges`, `loginHours`, `passwordPolicies`, `sessionSettings` — **any change** → a conflict, target or feature. | 🆕 |
| B2.9 | `layoutAssignments`, `recordTypeVisibilities` default: a change → the feature's (B2.6). A record type's `visible` true → false is less access (B2.7). | ✅ |
| B2.10 | Single values — label, description, license → the feature's. **A label's or translation's value the target and the feature hold differently → a conflict, target or feature**; when Copado's file has the common ancestor (diff3), a value only one story changed is joined. | ✏️ 5.1 |
| B2.11 | **Duplicates in the target, identical** → the second removed: shown **greyed, struck through, "Duplicate"**, with **Keep** to undo. | 🆕 |
| B2.12 | **Duplicates in the target, differing** → the copy granting more kept (each access setting granted counts; a tie keeps the first), shown **"Duplicate · the copy granting more kept"**, with **Keep … instead** to use the other. Nothing to choose. | ✏️ 4.0.2 |
| B2.13 | Nothing of the target is ever removed (B2.11 removes a copy only, and says so). | ✅ |
| B2.14 | A side that cannot be rebuilt (not valid XML): its blocks are conflicts, without *Accept feature* or *Accept all feature*. | ✅ |
| B2.15 | `autoResolve` on: a joined file with nothing to choose is resolved automatically; one with anything to choose (B2.7, B2.8) never is. | ✏️ 4.0.2 |
| B2.16 | *Format and Order Metadata* and *Remove Duplicate Entries*: offered only for these types, in the right-click menu. | ✅ |

### B3. Every other metadata — flows, Lightning pages, layouts, objects, fields, record types, validation rules, list views, custom metadata, reports, …

| # | Rule | |
|---|---|---|
| B3.1 | Git's blocks as Copado made them. Each is a conflict: **Accept target** or **Accept feature** — **no Accept both** (both versions of an element are rarely valid) — B3.6 excepted. | ✏️ |
| B3.6 | **Two stories each add their own entry at one place** (picklist values, flow elements, value set values — different identities, neither on the other side): said so, and **Accept both** offered for that conflict only — the two entries whole, the wrapper git lined up closed and opened again between them. | 5.1 |
| B3.2 | **Flows:** a block whose two versions differ **only** in `locationX`/`locationY` → the feature's, shown **"Positions · the feature's"**, with **Use target** to undo. | 🆕 |
| B3.3 | Never resolved automatically, never suggested — B3.2 excepted. | ✏️ |
| B3.4 | Upload blocked unless: valid XML, the same root type as the target, no deploy-breaking rule errors. **Duplicate entries do not block**: the file is uploaded as it is, with a warning before uploading (Copado's deployment may reject some). Applies to every metadata type, the union types too. | ✏️ 4.0.1 |
| B3.5 | Format/Order and Remove Duplicates not offered — order is what users see. | ✅ |

### B4. Everything else — files that are neither code nor `.xml`

`.json` `.txt` `.md` `.svg` `.csv`, static resources (`.resource`), images, zips — text or binary.

| # | Rule | |
|---|---|---|
| B4.1 | Listed under **Resolve in Copado** ("Copado only"), with *Open in Copado*. **Never opened in the editor, never uploaded from here.** | 🆕 |

---

## Part C — The merge editor

| # | Rule | |
|---|---|---|
| C1 | Layouts: **Three panel** (default) — *Conflicts in Promotion branch* · *Resolution* · *Conflicts in Feature branch*, named from Copado's markers; **Two panel** — the target's lines on the left with *Accept target*, the feature's version under the conflict; **One panel** — both versions under each conflict. Each version shown once. | ✅ |
| C2 | Rows: **Conflict** (yellow) · **Resolved** (green) · **Removed** (red) · **Left out** (grey) · **Duplicate** (grey) 🆕 · **Positions · the feature's** (purple) 🆕. | ✏️ |
| C3 | Buttons take their action by name; a button is shown only where its action is offered (B2.7, B2.14, B3.1). | ✅ |
| C4 | `⋯ › Accept all target / Accept all feature` — one step, one undo; never *Accept all feature* where B2.14. | ✅ |
| C5 | **Each conflict's lines are tracked by the editor itself** as you type — exact, never guessed from neighbouring lines. | 🆕 |
| C6 | F7 / Shift+F7: next / previous conflict. Words that differ within a line lit. Panes level in every layout. | ✅ |
| C7 | Large files: each large text sent once, every update a few kilobytes; a version over 300 lines shows its first 300 in one panel; comparisons in little memory. | ✅ |
| C8 | `⋯ › Save diagnostics…`: anonymised, saved for you to review. | ✅ |
| C9 | **A row shows its label only** — *Conflict*, *Resolved*, *Removed*, *Left out* — never past its buttons, in every layout. Each branch's row (three panels) is only its arrow button; each version's heading (one and two panels) is only *Target* or *Feature*, except that an empty version says *removes these lines*. What a metadata conflict is about, in Setup's words, is listed on the Release Assistant page. | ✏️ 5.1.2 |
| C10 | ~~A code conflict row names what it is about.~~ Removed in 5.1.2 — a row shows its label only (C9). | ✏️ 5.1.2 |
| C11 | **A block git started inside an element is shown whole.** Git lines up text, so a field added before another often comes out as a block opening inside the existing one — the new field's lines, its close, the next one's open. A block that only adds or only removes lines is slid over the lines repeated around it to the nearest place where it holds whole elements (or balanced code). Each side of the file stays exactly as it was; a block both sides changed, or whose common ancestor had lines, stays where git put it. | 🆕 5.1.1 |

---

## Part D — The Release Assistant page

| # | Rule | |
|---|---|---|
| D1 | Tabs: **Promotions · Manual · Compare**. The **Stories** tab is removed, with *Inspect User Story*, *Prepare User Story* and *Validate User Story from Its Feature Branch*. | ✏️ |
| D2 | The Promotions box accepts **promotion numbers and Copado links only**; a story number is answered *"Enter the promotion's number or its Copado link"*. | ✏️ |
| D3 | A promotion's page: a breadcrumb **Promotions › P0042** under the tabs (no arrow); its status, route and steps; the page's **⋯**: Settings, Save diagnostics, **Clean working files…**. | ✏️ |
| D4 | Files grouped **To resolve · Ready to upload · Uploaded · Resolve in Copado**, each with a status pill (*N conflicts*, *N access changes*, *Joined*, *Resolved*, *Copado only*). | ✏️ |
| D5 | A file's panel: **one primary action — Resolve in editor**, with what it will do written beside it; *Compare sides*, *Copy*, *Reset to Copado's file* under its ⋯. | ✏️ |
| D6 | **Reset** recomputes from Copado's file with the current rules. | ✏️ |
| D7 | **Refresh** recomputes files you haven't touched when the rules have changed; files you resolved, uploaded or are revising are never recomputed. | 🆕 |
| D8 | *Code to resolve* holds code only. | ✏️ |
| D9 | Upload all, with the status; undoable. Pre-check check-only; missing components borrowed from the source org (`cmr.borrow.sourceOrg`), for the pre-check only, up to 5 rounds. | ✅ |
| D10 | **Clean working files** (also in the Command Palette): lists `.copado`, names promotions with resolutions not uploaded, empties after you confirm; keeps `.gitignore`. | ✅ |
| D11 | **Before you upload**: the upload dialog's checklist (files to resolve, pre-check stale, failed or not run, access taken away, duplicates, borrowed components not committed), each with what to do; *What goes up* lists every file. | 🆕 |
| D12 | **To commit to a story**: what the pre-check borrowed or found missing, as `recommit/package.xml` or a list to copy. Errors grouped by cause; *older in …* for outdated components. | 🆕 |
| D13 | `⋯ › Save review to share…`: a Markdown report in `.copado/reports`. | 🆕 |
| D14 | A path in conflict for more than one story: the newest conflict file is resolved, and the panel shows *Also in conflict for …*. Every story in the promotion is read, without a 500-file cap. | 🆕 |
| D15 | Upload saves each file as uploaded as it goes, and a status error is a warning. Undo tries every file and names those left to undo. | 🆕 |

## Part E — Compare and Manual

| # | Rule | |
|---|---|---|
| E1 | Comparisons only: nothing merged, both sides editable, rows *Differs / Only here / Not here*, no Save. | ✅ |
| E2 | Compare lists what one branch changed since it split from another; provider limits said. | ✅ |
| E3 | Manual keeps *package from a Copado commit file*. | ✅ |

---
