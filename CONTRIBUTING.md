# Contributing to modelshift

Thanks for helping. modelshift is MIT-licensed and the CLI, checks, retirement calendar, report, GitHub Action and MCP server will stay free and open source.

## The quickest ways to help

- **Report a retirement we're missing or got wrong.** Use the [retirement report](https://github.com/angledsapiens/modelshift/issues/new?template=retirement.yml) form, or open a pull request that edits [`data/retirements.json`](data/retirements.json) (see below). Calendar fixes are the most valuable contribution: people make decisions on these dates.
- **Report a bug.** Use the [bug report](https://github.com/angledsapiens/modelshift/issues/new?template=bug.yml) form. Include the command, the modelshift version (`npx modelshift --version`) and the output. Remove API keys and private prompts first.
- **Share a migration result.** If you ran `modelshift run` on a real migration and are happy to share what it found (even just the verdict and which checks moved), open an issue. It helps us tune the defaults.

## Changing the retirement calendar

Every entry in `data/retirements.json` must cite an **official source**: the provider's own deprecations page, changelog, model card or announcement. Blog posts, social media and third-party trackers aren't enough on their own.

1. Find the provider's page and the exact model ids it names (dated snapshots and aliases).
2. Add or edit the entry. Keep the existing shape: `provider`, `ids` (every id the provider lists for that retirement), `shutdown` and `announced` dates (`YYYY-MM-DD`), a `replacement` if the provider names one, and an optional `note`.
3. If the provider isn't in the top-level `sources` map yet, add its official deprecations page there. Put the exact page you used in your pull request description.
4. Update the top-level `updated` date.
5. Run `npm test`. One test checks that every entry's provider has a source and that the dates are valid.

If a provider moves a date, edit the existing entry rather than adding a second one, and mention the change in your pull request description.

## Working on the code

You need Node.js 22 or later.

```bash
git clone https://github.com/angledsapiens/modelshift.git
cd modelshift
npm ci
npm test                          # builds with tsc, then runs the full suite with node:test
node dist/src/bin.js scan test/fixtures/sample-repo
```

Ground rules:

- **No runtime dependencies.** modelshift runs from `npx` and handles API keys, so the installed package has zero dependencies. Development dependencies (TypeScript, type definitions) are fine. If you think a runtime dependency is unavoidable, open an issue first.
- **Add a test** for every bug fix and feature. Tests live in `test/` and must not call real APIs; use the fake providers and fixtures the existing tests use.
- **Keep the statistics honest.** Changes to `src/run/stats.ts`, the verdict or the confidence rules need a short explanation in the pull request of why the change is sound, and a test on synthetic data that shows it.
- **Never hide a failure.** If something can go wrong during testing (a failed call, a missing answer, a check that couldn't run), it must appear under "Problems during testing" in every report format.
- **Plain language** in user-facing messages: say what happened, why, and what to do next.
- **New provider adapters** go in `src/providers/`, return the normalised response the others return, and come with request-shape and error-handling tests.

## Sign your commits (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/) (DCO) instead of a contributor licence agreement. By signing off a commit you confirm that you wrote the change, or otherwise have the right to submit it under the project's MIT licence. The full text is below.

Sign off by adding `-s` when you commit:

```bash
git commit -s -m "Fix the Gemini error message for quota errors"
```

That adds a line like this to the commit message, using your git name and email:

```
Signed-off-by: Your Name <you@example.com>
```

Any name you're publicly known by is fine, including a GitHub username or handle, and so is GitHub's no-reply email address. A check on every pull request makes sure each commit has a sign-off. If you forgot, fix the last commit with `git commit --amend -s --no-edit`, or every commit on your branch with `git rebase --signoff master`, then force-push the branch.

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

## Pull requests

- Keep each pull request to one change, and describe what it changes and why.
- `npm test` must pass. The CI workflow runs it on Linux, Windows and macOS.
- Changes to the GitHub Action (`action.yml`, `scripts/action.sh`) also run the action's own test workflow.

## Security

Please don't open a public issue for a security problem. See [SECURITY.md](SECURITY.md).

## Code of conduct

Be kind and assume good faith. Harassment or personal attacks aren't welcome, and the maintainer may remove comments or block accounts that cross that line.
