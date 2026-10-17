import { test } from "node:test"
import assert from "node:assert/strict"
import { mergeBoxSetting } from "../src/box.mjs"

const codex = { path: "/workspace/home/.codex/config.toml", format: "toml", values: { model: "MODEL-NAME", model_reasoning_effort: "high" } }

test("toml: a missing file gets just our keys", () => {
  assert.equal(mergeBoxSetting("", codex), 'model = "MODEL-NAME"\nmodel_reasoning_effort = "high"\n')
})

test("toml: our keys go above the first table and Codex's own tables are kept", () => {
  const existing = ['approval_policy = "never"', "", '[projects."/workspace/home/work"]', 'trust_level = "trusted"', ""].join("\n")
  assert.equal(
    mergeBoxSetting(existing, codex),
    ['model = "MODEL-NAME"', 'model_reasoning_effort = "high"', 'approval_policy = "never"', "", '[projects."/workspace/home/work"]', 'trust_level = "trusted"', ""].join("\n"),
  )
})

test("toml: an old value of one of our keys is replaced, not duplicated", () => {
  const out = mergeBoxSetting('model = "old"\nmodel_reasoning_effort="low"\n', codex)
  assert.equal(out, 'model = "MODEL-NAME"\nmodel_reasoning_effort = "high"\n')
})

test("toml: a key that only starts with ours, a comment, and a key inside a table are left alone", () => {
  const setting = { ...codex, values: { model: "MODEL-NAME" } }
  const existing = ['model_reasoning_effort = "high"', '# model = "commented"', "[profiles.fast]", 'model = "other"', ""].join("\n")
  assert.equal(
    mergeBoxSetting(existing, setting),
    ['model = "MODEL-NAME"', 'model_reasoning_effort = "high"', '# model = "commented"', "", "[profiles.fast]", 'model = "other"', ""].join("\n"),
  )
})

test("toml: merging twice gives the same file as merging once", () => {
  const existing = 'approval_policy = "never"\n\n[projects."/x"]\ntrust_level = "trusted"\n'
  const once = mergeBoxSetting(existing, codex)
  assert.equal(mergeBoxSetting(once, codex), once)
})

test("toml: numbers and booleans are written as TOML values", () => {
  const out = mergeBoxSetting("", { path: "/x.toml", format: "toml", values: { retries: 3, hide_agent_reasoning: true } })
  assert.equal(out, "retries = 3\nhide_agent_reasoning = true\n")
})

test("json: our values are merged over the existing settings, keeping the rest", () => {
  const setting = { path: "/workspace/home/.claude/settings.json", format: "json", values: { model: "MODEL-NAME" } }
  const out = mergeBoxSetting('{"model":"old","permissions":{"allow":["Bash"]}}', setting)
  assert.deepEqual(JSON.parse(out), { model: "MODEL-NAME", permissions: { allow: ["Bash"] } })
  assert.ok(out.endsWith("}\n"))
})

test("json: a missing or broken file is replaced by our values", () => {
  const setting = { path: "/s.json", format: "json", values: { model: "MODEL-NAME" } }
  assert.deepEqual(JSON.parse(mergeBoxSetting("", setting)), { model: "MODEL-NAME" })
  assert.deepEqual(JSON.parse(mergeBoxSetting("{not json", setting)), { model: "MODEL-NAME" })
})

test("text: the file is replaced by content, or emptied when there is none", () => {
  assert.equal(mergeBoxSetting("old stuff", { path: "/a.txt", format: "text", content: "new\n" }), "new\n")
  assert.equal(mergeBoxSetting("old stuff", { path: "/a.txt", format: "text" }), "")
})
