import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { resolveSkill } from "./ownership.mjs";

const hasGit = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const needsGit = { skip: hasGit ? false : "git is not available" };

const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
gitEnv.GIT_CONFIG_GLOBAL = "/dev/null";
gitEnv.GIT_CONFIG_NOSYSTEM = "1";

function init(directory) {
  mkdirSync(directory, { recursive: true });
  const result = spawnSync("git", ["init", "-q"], { cwd: directory, env: gitEnv, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function skillAt(directory, body = "---\nname: fixture\ndescription: fixture\n---\n") {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), body);
  return join(directory, "SKILL.md");
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

// Every fixture is an isolated HOME below the OS temp directory; nothing reads installed skills.
// `base` is deliberately not canonical (macOS temp is a symlink) so aliases get exercised.
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "skill-ownership-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, "home");
  const agents = join(home, ".agents");
  mkdirSync(agents, { recursive: true });
  return { base, real: realpathSync(base), home, agents, resolve: input => resolveSkill(input, { home }) };
}

test("public skill routes to its owning checkout through a symlinked discovery root", needsGit, t => {
  const f = fixture(t);
  init(join(f.base, "source"));
  const file = skillAt(join(f.base, "source", "skills", "alpha"));
  symlinkSync(join(f.base, "source", "skills"), join(f.agents, "skills"));

  const expected = {
    skill: join(f.real, "source", "skills", "alpha", "SKILL.md"),
    directory: join(f.real, "source", "skills", "alpha"),
    source: "public",
    root: join(f.real, "source", "skills"),
    cwd: join(f.real, "source"),
    repository: join(f.real, "source"),
    gitTracked: false,
    revision: sha256("---\nname: fixture\ndescription: fixture\n---\n"),
  };
  assert.deepEqual(f.resolve(join(f.agents, "skills", "alpha", "SKILL.md")), expected);
  assert.deepEqual(f.resolve(join(f.agents, "skills", "alpha")), expected);
  assert.deepEqual(f.resolve(file), expected);
});

test("a skill in a Git checkout is not reported as tracked until it is indexed", needsGit, t => {
  const f = fixture(t);
  const repository = join(f.base, "source");
  init(repository);
  const file = skillAt(join(repository, "skills", "alpha"));
  symlinkSync(join(repository, "skills"), join(f.agents, "skills"));
  skillAt(join(repository, "skills", "alpha", "examples", "nested"));
  const nested = spawnSync("git", ["add", "--", "skills/alpha/examples/nested/SKILL.md"], { cwd: repository, env: gitEnv, encoding: "utf8" });
  assert.equal(nested.status, 0, nested.stderr);
  assert.equal(f.resolve(file).gitTracked, false);

  const added = spawnSync("git", ["add", "--", "skills/alpha/SKILL.md"], { cwd: repository, env: gitEnv, encoding: "utf8" });
  assert.equal(added.status, 0, added.stderr);
  assert.equal(f.resolve(file).gitTracked, true);
});

test("team skill routes to the team checkout, not a public one", needsGit, t => {
  const f = fixture(t);
  init(join(f.base, "public"));
  skillAt(join(f.base, "public", "skills", "alpha"));
  symlinkSync(join(f.base, "public", "skills"), join(f.agents, "skills"));
  init(join(f.base, "team"));
  skillAt(join(f.base, "team", "skills", "beta"));
  symlinkSync(join(f.base, "team", "skills"), join(f.agents, "team-skills"));

  const result = f.resolve(join(f.agents, "team-skills", "beta"));
  assert.equal(result.source, "team");
  assert.equal(result.root, join(f.real, "team", "skills"));
  assert.equal(result.repository, join(f.real, "team"));
  assert.equal(result.cwd, join(f.real, "team"));
  assert.equal(f.resolve(join(f.agents, "skills", "alpha")).source, "public");
});

test("private skill without a repository uses its own directory", needsGit, t => {
  const f = fixture(t);
  skillAt(join(f.agents, "local-skills", "gamma"), "private body\n");

  const result = f.resolve(join(f.agents, "local-skills", "gamma"));
  assert.equal(result.source, "private");
  assert.equal(result.repository, null);
  assert.equal(result.gitTracked, false);
  assert.equal(result.directory, join(f.real, "home", ".agents", "local-skills", "gamma"));
  assert.equal(result.cwd, result.directory);
  assert.equal(result.root, join(f.real, "home", ".agents", "local-skills"));
  assert.equal(result.revision, sha256("private body\n"));
});

test("private skill inside its own repository reports that checkout", needsGit, t => {
  const f = fixture(t);
  init(join(f.agents, "local-skills", "delta"));
  skillAt(join(f.agents, "local-skills", "delta"));
  skillAt(join(f.agents, "local-skills", "plain"));

  const owned = f.resolve(join(f.agents, "local-skills", "delta"));
  assert.equal(owned.repository, join(f.real, "home", ".agents", "local-skills", "delta"));
  assert.equal(owned.cwd, owned.repository);
  assert.equal(f.resolve(join(f.agents, "local-skills", "plain")).repository, null);
});

test("a symlinked private root that is itself a repository owns its skills", needsGit, t => {
  const f = fixture(t);
  init(join(f.base, "private"));
  skillAt(join(f.base, "private", "epsilon"));
  symlinkSync(join(f.base, "private"), join(f.agents, "local-skills"));

  const result = f.resolve(join(f.agents, "local-skills", "epsilon"));
  assert.equal(result.repository, join(f.real, "private"));
  assert.equal(result.root, join(f.real, "private"));
});

test("aliases of one skill resolve identically", needsGit, t => {
  const f = fixture(t);
  init(join(f.base, "source"));
  skillAt(join(f.base, "source", "skills", "alpha"));
  symlinkSync(join(f.base, "source", "skills"), join(f.agents, "skills"));
  // A second name for the same skill, inside the root, plus a direct link to the file.
  symlinkSync(join(f.base, "source", "skills", "alpha"), join(f.base, "source", "skills", "alias"));
  symlinkSync(join(f.base, "source", "skills", "alpha", "SKILL.md"), join(f.base, "source", "skills", "file-alias"));

  const direct = f.resolve(join(f.base, "source", "skills", "alpha", "SKILL.md"));
  assert.deepEqual(f.resolve(join(f.agents, "skills", "alias")), direct);
  assert.deepEqual(f.resolve(join(f.agents, "skills", "alias", "SKILL.md")), direct);
  assert.deepEqual(f.resolve(join(f.real, "source", "skills", "alpha")), direct);
  // A link straight to SKILL.md is another name for the same skill.
  assert.deepEqual(f.resolve(join(f.agents, "skills", "file-alias")), direct);
});

test("a sibling directory sharing a root's name prefix is not part of that root", needsGit, t => {
  const f = fixture(t);
  init(join(f.base, "source"));
  skillAt(join(f.base, "source", "skills", "alpha"));
  symlinkSync(join(f.base, "source", "skills"), join(f.agents, "skills"));
  // Same string prefix as the public root, different directory.
  const sibling = skillAt(join(f.base, "source", "skills-extra", "intruder"));

  assert.throws(() => f.resolve(sibling), /unknown provenance/);
  // The same through the discovery tree: ~/.agents/skills-extra is not a discovery root.
  skillAt(join(f.agents, "skills-extra", "intruder"));
  assert.throws(() => f.resolve(join(f.agents, "skills-extra", "intruder")), /unknown provenance/);
});

test("symlinks may not escape the discovery root", needsGit, t => {
  const f = fixture(t);
  init(join(f.base, "source"));
  skillAt(join(f.base, "source", "skills", "alpha"));
  symlinkSync(join(f.base, "source", "skills"), join(f.agents, "skills"));
  skillAt(join(f.base, "elsewhere", "outside"));
  skillAt(join(f.base, "source", "not-skills", "sibling"));
  symlinkSync(join(f.base, "elsewhere", "outside"), join(f.base, "source", "skills", "dir-escape"));
  mkdirSync(join(f.base, "source", "skills", "file-escape"));
  symlinkSync(join(f.base, "elsewhere", "outside", "SKILL.md"), join(f.base, "source", "skills", "file-escape", "SKILL.md"));
  // Inside the same repository, but outside the discovery root.
  symlinkSync(join(f.base, "source", "not-skills", "sibling"), join(f.base, "source", "skills", "repo-escape"));

  for (const name of ["dir-escape", "file-escape", "repo-escape"]) {
    assert.throws(() => f.resolve(join(f.agents, "skills", name)), /unknown provenance/, name);
    assert.throws(() => f.resolve(join(f.agents, "skills", name, "SKILL.md")), /unknown provenance/, name);
  }
  assert.equal(f.resolve(join(f.agents, "skills", "alpha")).source, "public");
});

test("public and team skills without an owning checkout are rejected", needsGit, t => {
  const f = fixture(t);
  skillAt(join(f.base, "gitless-public", "alpha"));
  skillAt(join(f.base, "gitless-team", "beta"));
  symlinkSync(join(f.base, "gitless-public"), join(f.agents, "skills"));
  symlinkSync(join(f.base, "gitless-team"), join(f.agents, "team-skills"));

  assert.throws(() => f.resolve(join(f.agents, "skills", "alpha")), /public skill has no owning git checkout/);
  assert.throws(() => f.resolve(join(f.agents, "team-skills", "beta")), /team skill has no owning git checkout/);
});

test("a repository above the home directory does not own skills", needsGit, t => {
  const f = fixture(t);
  init(f.home);
  skillAt(join(f.agents, "skills", "alpha"));
  skillAt(join(f.agents, "team-skills", "beta"));
  skillAt(join(f.agents, "local-skills", "gamma"));

  assert.throws(() => f.resolve(join(f.agents, "skills", "alpha")), /no owning git checkout/);
  assert.throws(() => f.resolve(join(f.agents, "team-skills", "beta")), /no owning git checkout/);
  const privateSkill = f.resolve(join(f.agents, "local-skills", "gamma"));
  assert.equal(privateSkill.repository, null);
  assert.equal(privateSkill.cwd, privateSkill.directory);
});

test("a nested repository inside the root owns its skill", needsGit, t => {
  const f = fixture(t);
  init(join(f.base, "source"));
  skillAt(join(f.base, "source", "skills", "outer"));
  init(join(f.base, "source", "skills", "inner"));
  skillAt(join(f.base, "source", "skills", "inner"));
  symlinkSync(join(f.base, "source", "skills"), join(f.agents, "skills"));

  assert.equal(f.resolve(join(f.agents, "skills", "inner")).repository, join(f.real, "source", "skills", "inner"));
  assert.equal(f.resolve(join(f.agents, "skills", "outer")).repository, join(f.real, "source"));
});

test("the deepest matching root wins when roots nest", needsGit, t => {
  const f = fixture(t);
  init(join(f.base, "source"));
  skillAt(join(f.base, "source", "skills", "alpha"));
  skillAt(join(f.base, "source", "skills", "team", "beta"));
  symlinkSync(join(f.base, "source", "skills"), join(f.agents, "skills"));
  symlinkSync(join(f.base, "source", "skills", "team"), join(f.agents, "team-skills"));

  assert.equal(f.resolve(join(f.agents, "skills", "alpha")).source, "public");
  const nested = f.resolve(join(f.agents, "skills", "team", "beta"));
  assert.equal(nested.source, "team");
  assert.equal(nested.root, join(f.real, "source", "skills", "team"));
});

test("roots that are the same directory are ambiguous", needsGit, t => {
  const f = fixture(t);
  init(join(f.base, "source"));
  skillAt(join(f.base, "source", "skills", "alpha"));
  symlinkSync(join(f.base, "source", "skills"), join(f.agents, "skills"));
  symlinkSync(join(f.base, "source", "skills"), join(f.agents, "local-skills"));

  assert.throws(() => f.resolve(join(f.agents, "skills", "alpha")), /ambiguous/);
});

test("only skill files directly inside a skill directory qualify", needsGit, t => {
  const f = fixture(t);
  init(join(f.base, "source"));
  skillAt(join(f.base, "source", "skills", "alpha"));
  symlinkSync(join(f.base, "source", "skills"), join(f.agents, "skills"));
  writeFileSync(join(f.base, "source", "skills", "SKILL.md"), "loose\n");
  writeFileSync(join(f.base, "source", "skills", "alpha", "notes.md"), "notes\n");
  mkdirSync(join(f.base, "source", "skills", "empty"));

  assert.throws(() => f.resolve(join(f.agents, "skills", "SKILL.md")), /directly in a skill root/);
  assert.throws(() => f.resolve(join(f.agents, "skills")), /directly in a skill root/);
  assert.throws(() => f.resolve(join(f.agents, "skills", "alpha", "notes.md")), /not a skill file/);
  assert.throws(() => f.resolve(join(f.agents, "skills", "empty")), /not readable/);
  assert.throws(() => f.resolve(join(f.agents, "skills", "missing")), /not readable/);
  assert.throws(() => f.resolve("skills/alpha"), /absolute/);
});

test("revision follows the current SKILL.md contents", needsGit, t => {
  const f = fixture(t);
  const file = skillAt(join(f.agents, "local-skills", "zeta"), "first\n");
  const before = f.resolve(file).revision;
  writeFileSync(file, "second\n");
  const after = f.resolve(file).revision;

  assert.equal(before, sha256("first\n"));
  assert.equal(after, sha256("second\n"));
});
