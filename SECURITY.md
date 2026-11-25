# Security

modelshift runs on your machine with your API keys and reads your code and logs, so security problems matter.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/angledsapiens/modelshift/security/advisories/new)).

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get an acknowledgement within a few days. Once a fix is released, you'll be credited in the advisory, unless you'd rather not be.

## What counts

Examples of what we want to hear about:

- API keys or other secrets ending up in a report, results file, cache, log, PR comment or error message.
- A crafted repo, log file, samples file, Promptfoo config or provider response that makes modelshift run code, write outside its output paths, or send data anywhere other than the providers you chose.
- The GitHub Action exposing secrets, or running untrusted pull request code with write permissions.
- Script injection in the HTML report.

## Supported versions

Fixes go into the latest release on npm. Use `npx modelshift@latest`, or `angledsapiens/modelshift@v0` for the GitHub Action, to get them.
