---
name: sonar-issues
description: Look up and fix SonarQube Cloud findings for this repo with the `sonar` CLI. Covers quality gate status, issues on the current pull request or main, rule explanations, and fixing and checking them. Use when the user mentions Sonar, SonarQube, SonarCloud, the quality gate, code smells, or Sonar bugs, vulnerabilities or hotspots, or when the CI "SonarQube Scan" step fails.
---

# SonarQube issues: find, understand, fix

This repo is scanned by SonarQube Cloud. The organization is `lanceheld`, and the project key is `lanceheld_plex-visibility`, from `sonar-project.properties`. The scan runs in `.github/workflows/test.yml` on every pull request and on pushes to `main`. That step fails when the quality gate fails. Results only change after a push and a new CI scan. Nothing you run locally updates them.

The `sonar` CLI is installed in the dev container. Pass `-p lanceheld_plex-visibility` on every call, even though the CLI can detect the key itself. A wrong key silently returns another project's results. On a branch with an open pull request, the CLI uses that pull request's analysis automatically and prints `Using pull request N`. To query `main` instead, pass `--branch main`. Never combine `--branch` and `--pull-request`.

Set `DO_NOT_TRACK=1` on each call, so the CLI doesn't send usage data. The CLI prints its progress notes on stderr, so pipe stdout alone into `jq`. `jq` is installed.

## 0. Check the login

```sh
DO_NOT_TRACK=1 sonar auth status
```

The output must say `Connected`. If it doesn't, stop and ask the user to run `sonar auth login --org lanceheld` in a terminal. It opens a browser, so don't run it yourself. The login is kept on the dev container's `~/.sonar` volume.

## 1. Start with what blocks the merge: the quality gate

```sh
DO_NOT_TRACK=1 sonar qg status -p lanceheld_plex-visibility
```

This lists only the failing conditions, each with the issues behind it: file, line, issue key and rule. Fix these first. Add `--all` to see the passing conditions too. Add `--format json` to get a machine-readable version.

## 2. Check which commit the results describe

Line numbers in the results refer to the commit that was scanned, which may not be your working tree.

```sh
DO_NOT_TRACK=1 sonar api get "/api/project_pull_requests/list?project=lanceheld_plex-visibility" \
  | jq -r '.pullRequests[] | "\(.key) \(.branch) \(.commit.sha[0:7]) \(.analysisDate) gate=\(.status.qualityGateStatus)"'
git rev-parse --short HEAD; git status --short
```

If the scanned commit isn't `HEAD`, or the tree has changes, find each issue by its message and code in the current file, not by its line number alone. Also tell the user that the results are from an older commit.

## 3. List issues

```sh
P=lanceheld_plex-visibility
DO_NOT_TRACK=1 sonar list issues -p $P --format table            # quick look
DO_NOT_TRACK=1 sonar list issues -p $P --new-code --format csv   # only issues in new code (what the gate counts)
DO_NOT_TRACK=1 sonar list issues -p $P --file server/src/app.ts  # one file (not its subdirectories)
DO_NOT_TRACK=1 sonar list issues -p $P --severities BLOCKER,CRITICAL,MAJOR
```

The JSON output, the default, has `issues[]` with these fields: `key`, `rule`, `severity`, `type` (`BUG`, `VULNERABILITY` or `CODE_SMELL`), `component` (`<project>:<path>`), `line`, `textRange`, `message`, `effort`, `tags` and `impacts`. Results come 500 to a page. If `.total` is more than 500, use `--page 2` and so on. Useful summaries:

```sh
# Count by rule, to find bulk fixes
DO_NOT_TRACK=1 sonar list issues -p $P | jq -r '.issues[].rule' | sort | uniq -c | sort -rn
# Bugs and vulnerabilities first
DO_NOT_TRACK=1 sonar list issues -p $P \
  | jq -r '.issues[] | select(.type != "CODE_SMELL") | "\(.type) \(.severity) \(.rule) \(.component | sub("^[^:]*:"; "")):\(.line) \(.message)"'
```

Security hotspots are listed separately from issues:

```sh
DO_NOT_TRACK=1 sonar api get "/api/hotspots/search?projectKey=$P&pullRequest=<N>" \
  | jq -r '.hotspots[] | "\(.vulnerabilityProbability) \(.ruleKey) \(.component | sub("^[^:]*:"; "")):\(.line) \(.message)"'
```

Use `&branch=main` in place of `pullRequest` to get hotspots for `main`.

## 4. Understand the rule before changing code

Don't fix a rule you only know by its message. Read why the rule exists and how SonarQube recommends fixing it:

```sh
DO_NOT_TRACK=1 sonar api get "/api/rules/show?key=typescript:S3358&organization=lanceheld" \
  | jq -r '.rule | "# \(.name)\n", (.descriptionSections[] | select(.key == "root_cause" or .key == "how_to_fix") | .content)' \
  | sed -e 's/<[^>]*>//g' | grep -v '^\s*$'
```

## 5. Fix

- Work one rule at a time, in this order: issues behind the quality gate first, then bugs and vulnerabilities, then code smells by severity. If a rule has many hits, fix all of them in one pass.
- Read the surrounding code and follow its conventions. Make the change the rule actually asks for, not one that only hides the warning. Don't add `// NOSONAR` or other suppressions unless the user agrees.
- Some findings flag a deliberate choice. Look for a comment explaining the code, such as a base image pinned by both tag and digest in a Dockerfile, or a deliberate exception noted in a workflow. If you find one, don't change the code. Report the finding with its reason, and suggest marking it Accepted or False positive (see step 7).
- Some fixes change behaviour, CI or the supply chain, for example pinning GitHub Actions to commit SHAs, changing a Dockerfile user, or rewriting a regex used on input. Describe the change and its effect before making it.

## 6. Check the fix locally

The CLI can't re-run Sonar's code analysis here. `sonar analyze --file <path>` only scans for secrets on this plan, because Vortex returns 403. Check fixes these ways instead:

1. Run the repo's own checks: `npm run lint`, `npm run typecheck`, `npm test` and `npm run format:check`. Run `npm run format` to fix formatting.
2. If the `sonarqube` MCP server is connected, call `mcp__sonarqube__analyze_code_snippet` on the changed file. Pass the whole file as `fileContent`, `language` (`ts`, `tsx`, `docker` and so on), `projectKey: "lanceheld_plex-visibility"`, and `scope` (`MAIN`, or `TEST` for `server/test`). It runs Sonar's analyzers locally, and the fixed issue should no longer appear. It checks one file at a time and can miss issues that span files. If the tool isn't available, skip this step.
3. The final answer comes from CI. After the user pushes, wait for the "Lint and test" workflow, then run step 1 again. Commit or push only when the user asks.

## 7. Changing an issue's status in SonarQube (ask first)

Marking an issue Accepted or False positive changes the project for everyone. Don't do it until the user has agreed for that issue. Once they have:

```sh
DO_NOT_TRACK=1 sonar api post "/api/issues/do_transition" \
  --data '{"issue":"<issue key>","transition":"accept","comment":"<why>"}'
# transition: "accept" or "falsepositive"; "reopen" undoes either.
```

Use `/api/hotspots/change_status` for hotspots. Don't run `sonar remediate`, which starts Sonar's own AI agent, unless the user asks for it.

## Report back

When you're done, report:

- The quality gate result before and after, or what still needs a CI scan to confirm.
- What you fixed, by rule and file.
- What you left alone, and why.
- Anything that needs the user's decision.
