import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ProjectCreationError,
  createMavibaseApp,
  validateProjectName,
} from "../dist/create-app.js";

const runner = {
  calls: [],
  async run(command, args, cwd) {
    this.calls.push({ command, args, cwd });
  },
};

test("validates project names", () => {
  assert.deepEqual(validateProjectName("my-app"), []);
  assert.notDeepEqual(validateProjectName("My App"), []);
});

test("creates a single-package project using the selected stack", async () => {
  const parent = await mkdtemp(join(tmpdir(), "mavibase-cli-"));
  const calls = [];
  try {
    const result = await createMavibaseApp({
      projectName: "single-app",
      targetDirectory: join(parent, "single-app"),
      stackId: "react-node-postgresql-pnpm",
      skipInstall: false,
      runner: {
        async run(command, args, cwd) {
          calls.push({ command, args, cwd });
        },
      },
    });
    assert.equal(result.installed, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].args, ["install"]);
    assert.equal(
      JSON.parse(
        await readFile(join(result.projectDirectory, "package.json"), "utf8"),
      ).dependencies.react,
      "^19.0.0",
    );
    assert.match(
      await readFile(
        join(result.projectDirectory, "mavibase.config.ts"),
        "utf8",
      ),
      /react-node-postgresql-pnpm/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("creates a monorepo with workspace metadata and a backend application", async () => {
  const parent = await mkdtemp(join(tmpdir(), "mavibase-cli-"));
  try {
    const result = await createMavibaseApp({
      projectName: "workspace-app",
      targetDirectory: join(parent, "workspace-app"),
      stackId: "react-node-postgresql-pnpm",
      backend: "express",
      monorepo: true,
      skipInstall: true,
    });
    assert.equal(result.installed, false);
    assert.deepEqual(
      (await readdir(join(result.projectDirectory, "apps"))).sort(),
      ["api", "web"],
    );
    assert.equal(
      await readFile(
        join(result.projectDirectory, "pnpm-workspace.yaml"),
        "utf8",
      ),
      'packages:\n  - "apps/*"\n  - "packages/*"\n',
    );
    assert.match(
      await readFile(
        join(result.projectDirectory, "apps", "api", "package.json"),
        "utf8",
      ),
      /express/,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("rejects non-empty destinations and incompatible backends before writing", async () => {
  const parent = await mkdtemp(join(tmpdir(), "mavibase-cli-"));
  try {
    const existing = join(parent, "existing");
    await createMavibaseApp({
      projectName: "existing",
      targetDirectory: existing,
      stackId: "react-node-postgresql-pnpm",
      skipInstall: true,
    });
    await assert.rejects(
      createMavibaseApp({
        projectName: "existing",
        targetDirectory: existing,
        stackId: "react-node-postgresql-pnpm",
        skipInstall: true,
      }),
      ProjectCreationError,
    );
    await assert.rejects(
      createMavibaseApp({
        projectName: "bad-stack",
        targetDirectory: join(parent, "bad-stack"),
        framework: "express",
        runtime: "bun",
        database: "postgresql",
        packageManager: "pnpm",
        skipInstall: true,
      }),
      ProjectCreationError,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
