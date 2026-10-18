# Skill evals

Checks that keep this skill loadable and triggering correctly. They are for
people who maintain the skill, not part of the factory a user builds.

## Validator (offline, run it on every change)

```
node evals/validate-skill.mjs          # exit 1 on any error
node evals/validate-skill.mjs --strict # warnings fail too
node --test evals/tests/
```

`validate-skill.mjs` checks:

- **Frontmatter.** `name` is lowercase kebab-case and at most 64 characters;
  `description` exists, is at most 1024 characters, has no `<` or `>`, and
  says when to use the skill. Unknown keys and a SKILL.md body over 500 lines
  are warnings.
- **Referenced paths.** Every `references/*.md`, `scripts/*.mjs`,
  `src/*.mjs`, `worker/*`, `templates/*` and `.github/workflows/*` path in
  backticks in SKILL.md and README.md exists (template paths resolve under
  `assets/template/`). A config the user copies, like
  `scripts/demo-issues.json`, passes when its `.example.json` exists.
- **Template wiring.** Every `npm run` script in `assets/template/package.json`
  and every `node scripts/…` / `node src/…` step in the template workflows
  points at a real file, and the template's JSON files parse.
- **Trigger cases.** `evals/trigger-cases.json` has unique ids and prompts, a
  reason for each case, enough positive and negative cases, and distractor
  skills. A positive case's `anchors` must still appear in the description,
  so an edit that drops a phrase people use to ask for this skill fails here
  before it fails in an agent.

## Trigger evals (model-graded, optional)

```
ANTHROPIC_API_KEY=... node evals/trigger-evals.mjs [--json] [--model <id>] [--only <case id>]
```

Each case is sent to a model as a routing question: this skill plus the
distractors in `trigger-cases.json`, and the request. A case passes when the
model picks this skill exactly when `shouldTrigger` is true. The run prints
recall and precision and exits 1 below `passThreshold` (0.85). The model
defaults to `claude-haiku-4-5`; override with `--model` or `SKILL_EVAL_MODEL`.
Without a key it does a dry run, prints the first request and sends nothing.

To add a case, append to `cases` with a kebab-case `id`, the `prompt` as a
user would write it, `shouldTrigger`, a one-line `why`, and for positive
cases the description phrase it relies on as `anchors`.

## CI

`skill-ci.example.yml` runs the validator, these tests, the template's tests,
and the trigger evals when an `ANTHROPIC_API_KEY` secret exists. Copy it to
`.github/workflows/skill-ci.yml`; pushing workflow files needs a token with
the `workflow` scope.
