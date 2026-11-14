# Security

## Reporting a vulnerability

Please report it privately: **Security → Report a vulnerability** on this repository (GitHub's private vulnerability reporting), not a public issue. Include what you found, how to reproduce it, and which version (`Copado: Open Settings` shows it in the extension's details). You will get an answer within a week.

## What the extension does and does not do

- **Nothing deploys.** Validation is check-only (`deploy validate`, or `deploy start --dry-run` without tests); a test enforces it.
- **Git is read-only.** No checkout, merge, commit, reset or push.
- **Copado is written only when you confirm**: uploading resolutions, a promotion's status, the *Re-create promotion branch* checkbox.
- **No passwords.** Orgs come from the Salesforce CLI's own logins; repository tokens are kept in VS Code's encrypted secret storage.
- **Pages run under a strict content security policy**: scripts only from the extension itself, no `eval`, nothing from the network.
- **Session tokens are always masked** in the output; *Mask identities* also masks usernames, email addresses and org ids.
