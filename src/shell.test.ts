// Real-git tests for the helpers behind keep/discard and the benchmark runner.
// Each case reproduces a bug found in QA round 1.

import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bash, commitKeep, revertToHead } from "./shell.ts"

const g = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" })

/** A repo with one commit containing code.txt, gone.txt, .gitignore and .auto/prompt.md. */
function repo(name = "ar-shell-") {
  const dir = mkdtempSync(join(tmpdir(), name))
  g(dir, "init", "-q", "-b", "main")
  g(dir, "config", "user.email", "t@t")
  g(dir, "config", "user.name", "t")
  writeFileSync(join(dir, "code.txt"), "v1\n")
  writeFileSync(join(dir, "gone.txt"), "x\n")
  writeFileSync(join(dir, ".gitignore"), "ignored.txt\n")
  mkdirSync(join(dir, ".auto"))
  writeFileSync(join(dir, ".auto", "prompt.md"), "rules\n")
  g(dir, "add", "-A")
  g(dir, "commit", "-qm", "init")
  return dir
}

describe("commitKeep", () => {
  test("description with backticks, $(...) and $VARS is committed literally, never executed", async () => {
    const dir = repo()
    writeFileSync(join(dir, "code.txt"), "v2\n")
    const msg = "autoresearch: `touch INJ1` $(touch INJ2) $HOME \"dq\" 'sq'\nsecond line"
    const res = await commitKeep(dir, msg)
    expect(res.ok).toBe(true)
    expect(existsSync(join(dir, "INJ1"))).toBe(false)
    expect(existsSync(join(dir, "INJ2"))).toBe(false)
    expect(g(dir, "log", "-1", "--format=%B").trim()).toBe(msg)
  })

  test("doesn't commit .auto/ changes; a keep with only .auto changes is 'nothing to commit'", async () => {
    const dir = repo()
    writeFileSync(join(dir, ".auto", "log.jsonl"), "{}\n")
    const res = await commitKeep(dir, "m")
    expect(res).toEqual({ ok: true, commit: null })
    expect(g(dir, "status", "--porcelain")).toContain(".auto/")
  })

  test("a failed commit is reported and leaves nothing staged", async () => {
    const dir = repo()
    const hook = join(dir, ".git", "hooks", "pre-commit")
    writeFileSync(hook, "#!/bin/sh\nexit 1\n")
    chmodSync(hook, 0o755)
    writeFileSync(join(dir, "code.txt"), "v2\n")
    writeFileSync(join(dir, "new.txt"), "n\n")
    const res = await commitKeep(dir, "m")
    expect(res.ok).toBe(false)
    expect(g(dir, "diff", "--cached", "--name-only").trim()).toBe("")
  })
})

describe("revertToHead", () => {
  test("reverts staged, unstaged, new, deleted and untracked changes; keeps .auto and ignored files", async () => {
    const dir = repo()
    writeFileSync(join(dir, "code.txt"), "staged change\n")
    writeFileSync(join(dir, "staged-new.txt"), "n\n")
    g(dir, "add", "code.txt", "staged-new.txt")
    g(dir, "rm", "-q", "gone.txt")
    mkdirSync(join(dir, "newdir"))
    writeFileSync(join(dir, "newdir", "f.txt"), "u\n")
    writeFileSync(join(dir, "ignored.txt"), "keep me\n")
    writeFileSync(join(dir, ".auto", "ideas.md"), "- idea\n")
    writeFileSync(join(dir, ".auto", "prompt.md"), "rules, edited\n")

    const res = await revertToHead(dir)
    expect(res.ok).toBe(true)
    expect(readFileSync(join(dir, "code.txt"), "utf8")).toBe("v1\n")
    expect(existsSync(join(dir, "staged-new.txt"))).toBe(false)
    expect(existsSync(join(dir, "gone.txt"))).toBe(true)
    expect(existsSync(join(dir, "newdir"))).toBe(false)
    expect(existsSync(join(dir, "ignored.txt"))).toBe(true)
    expect(existsSync(join(dir, ".auto", "ideas.md"))).toBe(true)
    expect(readFileSync(join(dir, ".auto", "prompt.md"), "utf8")).toBe("rules, edited\n")
    expect(g(dir, "diff", "--cached", "--name-only").trim()).toBe("")
  })

  test("reports failure when git can't run (index.lock)", async () => {
    const dir = repo()
    writeFileSync(join(dir, "code.txt"), "v2\n")
    writeFileSync(join(dir, ".git", "index.lock"), "")
    const res = await revertToHead(dir)
    expect(res.ok).toBe(false)
    rmSync(join(dir, ".git", "index.lock"))
  })

  test("works in a folder whose path contains spaces", async () => {
    const dir = repo("ar shell ")
    writeFileSync(join(dir, "code.txt"), "v2\n")
    expect((await revertToHead(dir)).ok).toBe(true)
    expect(readFileSync(join(dir, "code.txt"), "utf8")).toBe("v1\n")
  })
})

describe("bash runner", () => {
  test("returns as soon as the command exits, even if a background child holds the output open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-run-"))
    const res = await bash("sleep 30 & echo METRIC x=1", dir, 10_000)
    expect(res.timedOut).toBe(false)
    expect(res.code).toBe(0)
    expect(res.output).toContain("METRIC x=1")
    expect(res.durationMs).toBeLessThan(2_000)
  })

  test("a child that escaped the process group (setsid) can't hang the run past its timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-run-"))
    const res = await bash(`perl -MPOSIX -e 'setsid(); sleep 20' & sleep 20`, dir, 1_000)
    expect(res.timedOut).toBe(true)
    expect(res.durationMs).toBeLessThan(3_000)
  })

  test("timeout kills a plain long command", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-run-"))
    const res = await bash("sleep 20", dir, 500)
    expect(res.timedOut).toBe(true)
    expect(res.durationMs).toBeLessThan(2_000)
  })
})
