import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

// Discovery roots under ~/.agents and the ownership class each one grants.
const ROOTS = [
  { name: "skills", source: "public" },
  { name: "local-skills", source: "private" },
  { name: "team-skills", source: "team" },
];

// Variables that make git ignore the directory it is asked about.
const GIT_REDIRECTS = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
]);

function within(parent, child) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function canonical(path, what) {
  try {
    return realpathSync(path);
  } catch (error) {
    throw new Error(`${what} is not readable: ${path} (${error.code ?? error.message})`);
  }
}

function discoveryRoots(home) {
  const roots = [];
  for (const { name, source } of ROOTS) {
    let root;
    try {
      root = realpathSync(join(home, ".agents", name));
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
      throw error;
    }
    if (statSync(root).isDirectory()) roots.push({ source, root });
  }
  return roots;
}

function owningRoot(skill, roots) {
  const matches = roots.filter(({ root }) => within(root, skill));
  if (matches.length === 0) {
    throw new Error(`skill has unknown provenance, it is outside every skill root: ${skill}`);
  }
  const longest = Math.max(...matches.map(({ root }) => root.length));
  const best = matches.filter(({ root }) => root.length === longest);
  if (best.length > 1) {
    throw new Error(`skill provenance is ambiguous, ${best.map(({ source }) => source).join(" and ")} roots are the same directory: ${best[0].root}`);
  }
  return best[0];
}

// Repository and index membership, without trusting Git directory overrides.
function gitOwnership(directory) {
  const env = { ...process.env, LC_ALL: "C" };
  for (const key of GIT_REDIRECTS) delete env[key];
  const options = { cwd: directory, encoding: "utf8", env, timeout: 15_000 };
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], options);
  if (result.error) throw new Error(`git is required to find the owning checkout: ${result.error.message}`);
  if (result.status !== 0) {
    if (/not a git repository|must be run in a work tree/i.test(result.stderr)) return { repository: null, gitTracked: false };
    throw new Error(`git rev-parse failed in ${directory}: ${result.stderr.trim()}`);
  }
  const repository = canonical(result.stdout.replace(/\r?\n$/, ""), "git root");
  const indexed = spawnSync("git", ["ls-files", "--error-unmatch", "--", `:(top,literal)${relative(repository, join(directory, "SKILL.md"))}`], options);
  if (indexed.error) throw new Error(`git could not check whether the skill is tracked: ${indexed.error.message}`);
  if (indexed.status !== 0 && indexed.status !== 1) throw new Error(`git ls-files failed in ${directory}: ${indexed.stderr.trim()}`);
  return { repository, gitTracked: indexed.status === 0 };
}

export function resolveSkill(input, { home = homedir() } = {}) {
  if (typeof input !== "string" || !isAbsolute(input)) throw new Error("skill path must be an absolute path");
  const realHome = canonical(home, "home");
  const target = canonical(input, "skill path");

  let skill;
  if (statSync(target).isDirectory()) {
    skill = canonical(join(target, "SKILL.md"), "SKILL.md");
  } else {
    skill = target;
  }
  if (basename(skill) !== "SKILL.md" || !statSync(skill).isFile()) throw new Error(`not a skill file: ${input}`);

  const { source, root } = owningRoot(skill, discoveryRoots(realHome));
  const directory = dirname(skill);
  if (directory === root) throw new Error(`SKILL.md directly in a skill root is not a skill: ${skill}`);

  // A repository that contains the home directory is an accident (dotfiles, a stray `git init`),
  // never the checkout that owns a skill.
  let { repository, gitTracked } = gitOwnership(directory);
  if (repository !== null && within(repository, realHome)) {
    repository = null;
    gitTracked = false;
  }
  if (repository !== null && !within(repository, directory)) {
    throw new Error(`git root ${repository} does not contain the skill directory ${directory}`);
  }
  if (repository === null && source !== "private") {
    throw new Error(`${source} skill has no owning git checkout: ${directory}`);
  }

  return {
    skill,
    directory,
    source,
    root,
    cwd: repository ?? directory,
    repository,
    gitTracked,
    revision: createHash("sha256").update(readFileSync(skill)).digest("hex"),
  };
}
