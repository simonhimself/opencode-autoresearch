// Real-git tests for the helpers behind keep/discard and the benchmark runner.
// Each case reproduces a bug found in QA or in the adversarial review.

import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  bash,
  commitKeep,
  currentBranch,
  fileHash,
  git,
  GIT_COMMIT,
  headSha,
  headTree,
  isTrunk,
  MAX_OUTPUT_BYTES,
  revertToHead,
  scopeHasTrackedFiles,
  scopeStatus,
  scopeTreeHash,
  tailLines,
} from "./shell.ts"

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
    expect(res).toEqual({ ok: true, commit: null, sha: null })
    expect(g(dir, "status", "--porcelain")).toContain(".auto/")
  })

  test("a failed commit is reported and leaves nothing staged", async () => {
    const dir = repo()
    // An empty message makes git refuse the commit (hooks can't be the cause any more: they're skipped).
    writeFileSync(join(dir, "code.txt"), "v2\n")
    writeFileSync(join(dir, "new.txt"), "n\n")
    const res = await commitKeep(dir, "")
    expect(res.ok).toBe(false)
    expect(g(dir, "diff", "--cached", "--name-only").trim()).toBe("")
  })

  test("hooks and signing are skipped: a failing pre-commit hook and commit.gpgsign=true don't block a keep", async () => {
    const dir = repo()
    for (const name of ["pre-commit", "commit-msg", "prepare-commit-msg", "post-commit"]) {
      const hook = join(dir, ".git", "hooks", name)
      writeFileSync(hook, "#!/bin/sh\ntouch \"$(git rev-parse --show-toplevel)/HOOK_RAN\"\nexit 1\n")
      chmodSync(hook, 0o755)
    }
    g(dir, "config", "commit.gpgsign", "true")
    g(dir, "config", "gpg.program", "/nonexistent/gpg")
    writeFileSync(join(dir, "code.txt"), "v2\n")
    const res = await commitKeep(dir, "m")
    expect(res.ok).toBe(true)
    expect(existsSync(join(dir, "HOOK_RAN"))).toBe(false)
    expect(g(dir, "log", "-1", "--format=%s").trim()).toBe("m")
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
    writeFileSync(join(dir, "untracked.txt"), "u\n")
    writeFileSync(join(dir, ".git", "index.lock"), "")
    const res = await revertToHead(dir)
    expect(res.ok).toBe(false)
    // nothing half-done: the untracked file isn't deleted when the restore step failed
    expect(existsSync(join(dir, "untracked.txt"))).toBe(true)
    rmSync(join(dir, ".git", "index.lock"))
  })

  test("works in a folder whose path contains spaces", async () => {
    const dir = repo("ar shell ")
    writeFileSync(join(dir, "code.txt"), "v2\n")
    expect((await revertToHead(dir)).ok).toBe(true)
    expect(readFileSync(join(dir, "code.txt"), "utf8")).toBe("v1\n")
  })
})

describe("QA round 3: scope edge cases", () => {
  test("keep works when .auto is gitignored", async () => {
    const dir = repo()
    writeFileSync(join(dir, ".gitignore"), "ignored.txt\n.auto/\n")
    g(dir, "commit", "-qam", "ignore .auto")
    writeFileSync(join(dir, "code.txt"), "v2\n")
    const res = await commitKeep(dir, "m")
    expect(res.ok).toBe(true)
    expect(revertToHead(dir)).resolves.toMatchObject({ ok: true })
  })

  test("a discard at the repo root leaves other packages' .auto folders alone", async () => {
    const dir = repo()
    mkdirSync(join(dir, "packages", "app", ".auto"), { recursive: true })
    writeFileSync(join(dir, "packages", "app", ".auto", "prompt.md"), "app rules\n")
    g(dir, "add", "-A")
    g(dir, "commit", "-qm", "app session")
    writeFileSync(join(dir, "packages", "app", ".auto", "prompt.md"), "app rules, edited\n")
    writeFileSync(join(dir, "packages", "app", ".auto", "log.jsonl"), "{}\n")
    writeFileSync(join(dir, "code.txt"), "v2\n")
    expect((await revertToHead(dir)).ok).toBe(true)
    expect(readFileSync(join(dir, "code.txt"), "utf8")).toBe("v1\n")
    expect(readFileSync(join(dir, "packages", "app", ".auto", "prompt.md"), "utf8")).toBe("app rules, edited\n")
    expect(existsSync(join(dir, "packages", "app", ".auto", "log.jsonl"))).toBe(true)
  })

  test("keep in a subfolder doesn't commit files staged elsewhere", async () => {
    const dir = repo()
    mkdirSync(join(dir, "pkg"))
    writeFileSync(join(dir, "pkg", "p.js"), "1\n")
    g(dir, "add", "-A")
    g(dir, "commit", "-qm", "pkg")
    writeFileSync(join(dir, "code.txt"), "staged at root\n")
    g(dir, "add", "code.txt")
    writeFileSync(join(dir, "pkg", "p.js"), "2\n")
    const res = await commitKeep(join(dir, "pkg"), "m")
    expect(res.ok).toBe(true)
    expect(g(dir, "show", "--name-only", "--format=", "HEAD").trim()).toBe("pkg/p.js")
    expect(g(dir, "diff", "--cached", "--name-only").trim()).toBe("code.txt")
  })

  test("a folder git tracks nothing in is never cleaned (it's an untracked project inside a bigger repo)", async () => {
    const dir = repo()
    mkdirSync(join(dir, "fresh"))
    writeFileSync(join(dir, "fresh", "new.txt"), "n\n")
    const res = await revertToHead(join(dir, "fresh"))
    expect(res.ok).toBe(false)
    expect(res.output).toContain("tracks no files")
    expect(existsSync(join(dir, "fresh", "new.txt"))).toBe(true)
  })

  test("discard in a repo with no commits gives a clear error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-empty-"))
    g(dir, "init", "-q", "-b", "main")
    writeFileSync(join(dir, "a.txt"), "a\n")
    const res = await revertToHead(dir)
    expect(res.ok).toBe(false)
    expect(res.output).toContain("no commits yet")
    expect(existsSync(join(dir, "a.txt"))).toBe(true)
  })
})

describe("bash runner", () => {
  test("a huge or invalid timeout doesn't kill the run at once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-run-"))
    for (const t of [3_000_000_000_000, -5, Number.NaN]) {
      const res = await bash("echo METRIC x=1", dir, t)
      expect(res.timedOut).toBe(false)
      expect(res.output).toContain("METRIC x=1")
    }
  })

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

describe("git timeout", () => {
  test("a git command that hangs is stopped with SIGTERM: the error says so and no index.lock is left", async () => {
    const dir = repo()
    const hook = join(dir, ".git", "hooks", "pre-commit")
    writeFileSync(hook, "#!/bin/sh\nsleep 30\n")
    chmodSync(hook, 0o755)
    writeFileSync(join(dir, "code.txt"), "v2\n")
    g(dir, "add", "code.txt")
    // Without --no-verify, so the sleeping hook holds git while it has the index locked.
    const res = await git(["commit", "-q", "-m", "slow"], dir, { timeoutMs: 1_000 })
    expect(res.timedOut).toBe(true)
    expect(res.output).toContain("git commit timed out after 1 s")
    expect(res.durationMs).toBeLessThan(5_000)
    expect(existsSync(join(dir, ".git", "index.lock"))).toBe(false)
    // The repo is usable right away.
    expect((await revertToHead(dir)).ok).toBe(true)
    expect(readFileSync(join(dir, "code.txt"), "utf8")).toBe("v1\n")
  })
})

describe("scope tree hash (the fingerprint)", () => {
  const hash = async (dir: string) => {
    const res = await scopeTreeHash(dir)
    if (!res.ok) throw new Error(res.error)
    return res.tree
  }

  test("equals HEAD's tree on a clean tree, whatever happens in .auto/ or the index", async () => {
    const dir = repo()
    expect(await hash(dir)).toBe((await headTree(dir))!)
    writeFileSync(join(dir, ".auto", "prompt.md"), "edited\n")
    writeFileSync(join(dir, ".auto", "log.jsonl"), "{}\n")
    g(dir, "add", ".auto/prompt.md")
    writeFileSync(join(dir, "ignored.txt"), "x\n")
    expect(await hash(dir)).toBe((await headTree(dir))!)
  })

  test("changes with any edit, new file or deletion, and never touches the real index", async () => {
    const dir = repo()
    const clean = await hash(dir)
    writeFileSync(join(dir, "code.txt"), "v2\n")
    const edited = await hash(dir)
    expect(edited).not.toBe(clean)
    writeFileSync(join(dir, "new.txt"), "n\n")
    const added = await hash(dir)
    expect(added).not.toBe(edited)
    rmSync(join(dir, "gone.txt"))
    expect(await hash(dir)).not.toBe(added)
    expect(g(dir, "diff", "--cached", "--name-only").trim()).toBe("")
    expect(existsSync(join(dir, ".git", "index.lock"))).toBe(false)
  })

  test("is exactly the tree commitKeep commits (also from a subfolder, with changes staged elsewhere)", async () => {
    const dir = repo()
    mkdirSync(join(dir, "pkg"))
    writeFileSync(join(dir, "pkg", "p.js"), "1\n")
    g(dir, "add", "-A")
    g(dir, "commit", "-qm", "pkg")
    writeFileSync(join(dir, "code.txt"), "outside the scope\n")
    g(dir, "add", "code.txt")
    writeFileSync(join(dir, "pkg", "p.js"), "2\n")
    writeFileSync(join(dir, "pkg", "new.js"), "n\n")
    const measured = await hash(join(dir, "pkg"))
    const res = await commitKeep(join(dir, "pkg"), "m")
    expect(res.ok).toBe(true)
    expect(await headTree(dir)).toBe(measured)
  })

  test("sees a same-size edit made right after a commit (no stale stat cache)", async () => {
    const dir = repo()
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(dir, "code.txt"), `a${i}\n`)
      const a = await hash(dir)
      expect((await commitKeep(dir, `m${i}`)).ok).toBe(true)
      expect(await headTree(dir)).toBe(a)
      writeFileSync(join(dir, "code.txt"), `b${i}\n`)
      expect(await hash(dir)).not.toBe(a)
    }
  })
})

describe("repo questions", () => {
  test("branch, trunk, head, tracked files, status", async () => {
    const dir = repo()
    expect(await currentBranch(dir)).toBe("main")
    expect(await isTrunk(dir, "main")).toBe(true)
    expect(await isTrunk(dir, "master")).toBe(true)
    expect(await isTrunk(dir, "autoresearch/x")).toBe(false)
    expect(await headSha(dir)).toMatch(/^[0-9a-f]{40}$/)
    expect(await scopeHasTrackedFiles(dir)).toBe(true)
    expect(await scopeStatus(dir)).toEqual({ ok: true, status: "" })

    // origin/HEAD decides what else counts as trunk
    g(dir, "update-ref", "refs/remotes/origin/develop", "HEAD")
    g(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop")
    expect(await isTrunk(dir, "develop")).toBe(true)

    g(dir, "checkout", "-q", "--detach")
    expect(await currentBranch(dir)).toBeNull()
  })

  test("status lists changes in the scope but nothing under any .auto/", async () => {
    const dir = repo()
    writeFileSync(join(dir, "code.txt"), "v2\n")
    mkdirSync(join(dir, "sub", ".auto"), { recursive: true })
    writeFileSync(join(dir, "sub", ".auto", "log.jsonl"), "{}\n")
    writeFileSync(join(dir, "sub", "new.txt"), "n\n")
    writeFileSync(join(dir, ".auto", "log.jsonl"), "{}\n")
    const res = await scopeStatus(dir)
    expect(res.ok && res.status.split("\n").sort()).toEqual([" M code.txt", "?? sub/new.txt"])
  })

  test("an untracked folder inside a repo has no tracked files; outside a repo there's no HEAD", async () => {
    const dir = repo()
    mkdirSync(join(dir, "fresh"))
    writeFileSync(join(dir, "fresh", "f.txt"), "f\n")
    expect(await scopeHasTrackedFiles(join(dir, "fresh"))).toBe(false)
    const plain = mkdtempSync(join(tmpdir(), "ar-plain-"))
    expect(await headSha(plain)).toBeNull()
    expect((await scopeStatus(plain)).ok).toBe(false)
  })

  test("fileHash: content hash, null for a missing file", async () => {
    const dir = repo()
    const a = await fileHash(join(dir, "code.txt"))
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    writeFileSync(join(dir, "code.txt"), "v2\n")
    expect(await fileHash(join(dir, "code.txt"))).not.toBe(a)
    expect(await fileHash(join(dir, "nope"))).toBeNull()
  })

  test("the commit command skips hooks and signing", () => {
    expect(GIT_COMMIT).toContain("--no-verify")
    expect(GIT_COMMIT.slice(0, 4)).toEqual(["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"])
  })
})

describe("output cap", () => {
  test("a 3 MB line is cut to the last 1 MB while captured, and to 2000 characters when shown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ar-run-"))
    const res = await bash("head -c 3000000 /dev/zero | tr '\\0' x; echo; echo METRIC x=1", dir, 20_000)
    expect(res.code).toBe(0)
    expect(res.output.length).toBeLessThan(MAX_OUTPUT_BYTES + 200)
    expect(res.output).toContain("bytes of earlier output dropped")
    expect(res.output).toContain("METRIC x=1") // the tail is what's kept
    const shown = tailLines(res.output, 80)
    expect(shown.length).toBeLessThan(3_000)
    expect(shown).toContain("line cut")
    expect(shown).toContain("METRIC x=1")
  })

  test("tailLines keeps the last lines", () => {
    expect(tailLines("a\nb\nc\n", 2)).toBe("b\nc")
  })
})
