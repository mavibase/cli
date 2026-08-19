import { execFile } from "node:child_process";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";

import {
  createDefaultStackRegistries,
  builtInStackDefinitions,
  defineStackDefinition,
  StackRegistry,
  validateStackCompatibility,
  type StackDefinition,
  type StackRegistries,
} from "../../core/packages/config/dist/index.js";
import {
  createFilesystem,
  type GeneratedFile,
} from "../../core/packages/generator/dist/index.js";

const execFileAsync = promisify(execFile);

export interface ProcessRunner {
  run(command: string, args: readonly string[], cwd: string): Promise<void>;
}

export const defaultProcessRunner: ProcessRunner = {
  async run(command, args, cwd) {
    const executable =
      process.platform === "win32" && !/[.]cmd$|[.]exe$/i.test(command)
        ? `${command}.cmd`
        : command;
    await execFileAsync(executable, [...args], {
      cwd,
      windowsHide: true,
      shell: process.platform === "win32" && /[.]cmd$/i.test(executable),
    });
  },
};

export interface CreateAppOptions {
  projectName?: string;
  targetDirectory?: string;
  stackId?: string;
  framework?: string;
  backend?: string;
  runtime?: string;
  database?: string;
  packageManager?: string;
  language?: "typescript" | "javascript";
  monorepo?: boolean;
  webName?: string;
  apiName?: string;
  skipInstall?: boolean;
  registries?: StackRegistries;
  runner?: ProcessRunner;
}

export interface CreateAppResult {
  projectName: string;
  projectDirectory: string;
  stack: StackDefinition;
  backend?: string;
  language: "typescript" | "javascript";
  monorepo: boolean;
  installed: boolean;
  files: readonly string[];
}

export class ProjectCreationError extends Error {
  readonly code = "MAVIBASE_PROJECT_CREATION_ERROR";

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "ProjectCreationError";
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateProjectName(value: string): string[] {
  const issues: string[] = [];
  if (!isNonEmptyString(value)) {
    issues.push("Project name must not be empty.");
  } else if (!/^[a-z0-9][a-z0-9_-]*$/.test(value)) {
    issues.push(
      "Project name must use lowercase letters, numbers, hyphens, or underscores.",
    );
  }
  if (value.length > 214) {
    issues.push("Project name must not exceed 214 characters.");
  }
  return issues;
}

function validateApplicationName(value: string, label: string): void {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(value)) {
    throw new ProjectCreationError(
      `${label} must use lowercase letters, numbers, hyphens, or underscores.`,
    );
  }
}

function packageManagerCommand(
  definition: StackDefinition,
  registries: StackRegistries,
): string {
  const packageManager = registries.packageManagers.require(
    definition.packageManager,
  );
  return (
    packageManager.commands.install.split(/\s+/)[0] ?? definition.packageManager
  );
}

function packageManagerInstallArgs(
  definition: StackDefinition,
  monorepo: boolean,
): readonly string[] {
  if (definition.packageManager === "npm" && !monorepo) {
    return ["install", "--workspaces=false"];
  }
  return ["install"];
}

function resolveStack(
  options: CreateAppOptions,
  registries: StackRegistries,
): StackDefinition {
  let stack: StackDefinition;
  if (options.stackId) {
    try {
      stack = createDefaultStackRegistryWithRegistries(registries).require(
        options.stackId,
      );
    } catch (error) {
      throw new ProjectCreationError(
        error instanceof Error ? error.message : String(error),
        error,
      );
    }
  } else {
    const frameworkId = options.framework;
    const runtimeId = options.runtime;
    const databaseId = options.database;
    const packageManagerId = options.packageManager;
    if (!frameworkId || !runtimeId || !databaseId || !packageManagerId) {
      throw new ProjectCreationError(
        "Framework, runtime, database, and package manager must all be selected.",
      );
    }

    let framework;
    let runtime;
    let database;
    let packageManager;
    try {
      framework = registries.frameworks.require(frameworkId);
      runtime = registries.runtimes.require(runtimeId);
      database = registries.databases.require(databaseId);
      packageManager = registries.packageManagers.require(packageManagerId);
    } catch (error) {
      throw new ProjectCreationError(
        error instanceof Error ? error.message : String(error),
        error,
      );
    }

    const compatibilityIssues = validateStackCompatibility(
      {
        framework: framework.id,
        runtime: runtime.id,
        database: database.id,
        packageManager: packageManager.id,
      },
      registries,
    );
    if (compatibilityIssues.length > 0) {
      throw new ProjectCreationError(
        `The selected stack is incompatible: ${compatibilityIssues.map((issue) => issue.message).join(" ")}`,
      );
    }

    stack = defineStackDefinition(
      {
        id: `${framework.id}-${runtime.id}-${database.id}-${packageManager.id}`,
        name: `${framework.name}, ${runtime.name}, ${database.name}, and ${packageManager.name}`,
        framework: framework.id,
        runtime: runtime.id,
        database: database.id,
        packageManager: packageManager.id,
      },
      registries,
    );
  }

  if (options.backend && options.backend !== stack.framework) {
    const issues = validateStackCompatibility(
      {
        framework: options.backend,
        runtime: stack.runtime,
        database: stack.database,
        packageManager: stack.packageManager,
      },
      registries,
    );
    if (issues.length > 0) {
      throw new ProjectCreationError(
        `The selected backend is incompatible: ${issues.map((issue) => issue.message).join(" ")}`,
      );
    }
    const backendDefinition = registries.frameworks.require(options.backend);
    if (backendDefinition.category !== "backend") {
      throw new ProjectCreationError(
        `Framework is not a backend framework: "${options.backend}".`,
      );
    }
  }

  return stack;
}

async function ensureDestination(directory: string): Promise<boolean> {
  try {
    const details = await stat(directory);
    if (!details.isDirectory()) {
      throw new ProjectCreationError(
        `Target path is not a directory: "${directory}".`,
      );
    }
    const entries = await readdir(directory);
    if (entries.length > 0) {
      throw new ProjectCreationError(
        `Target directory is not empty: "${directory}".`,
      );
    }
    return false;
  } catch (error) {
    if (error instanceof ProjectCreationError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ProjectCreationError(
        `Could not inspect target directory: "${directory}".`,
        error,
      );
    }
    await mkdir(directory, { recursive: true });
    return true;
  }
}

function addDependency(
  target: Record<string, string>,
  name: string,
  versions: Readonly<Record<string, string>> | undefined,
): void {
  target[name] = versions?.[name] ?? "*";
}

function packageJson(
  projectName: string,
  dependencies: Record<string, string>,
  devDependencies: Record<string, string>,
  monorepo: boolean,
  workspacePatterns: readonly string[],
): Record<string, unknown> {
  return {
    name: projectName,
    version: "0.1.0",
    private: monorepo,
    type: "module",
    ...(monorepo ? { workspaces: workspacePatterns } : {}),
    scripts: { typecheck: "tsc --noEmit" },
    ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}),
    ...(Object.keys(devDependencies).length > 0 ? { devDependencies } : {}),
  };
}

function file(path: string, content: string): GeneratedFile {
  return { path, content };
}

function sourceExtension(language: "typescript" | "javascript"): string {
  return language === "typescript" ? "ts" : "js";
}

function createArtifacts(
  projectName: string,
  stack: StackDefinition,
  backend: string | undefined,
  language: "typescript" | "javascript",
  monorepo: boolean,
  webName: string,
  apiName: string,
  registries: StackRegistries,
): GeneratedFile[] {
  const framework = registries.frameworks.require(stack.framework);
  const database = registries.databases.require(stack.database);
  const dependencies: Record<string, string> = {};
  const devDependencies: Record<string, string> = {};
  for (const dependency of framework.dependencies ?? []) {
    addDependency(dependencies, dependency, framework.dependencyVersions);
  }
  for (const dependency of database.dependencies ?? []) {
    addDependency(dependencies, dependency, database.dependencyVersions);
  }
  if (backend && backend !== stack.framework) {
    for (const dependency of registries.frameworks.require(backend)
      .dependencies ?? []) {
      addDependency(
        dependencies,
        dependency,
        registries.frameworks.require(backend).dependencyVersions,
      );
    }
  }
  if (language === "typescript")
    addDependency(devDependencies, "typescript", { typescript: "^5.5.0" });

  const workspacePatterns = ["apps/*", "packages/*"];
  const rootManifest = packageJson(
    projectName,
    monorepo ? {} : dependencies,
    monorepo ? {} : devDependencies,
    monorepo,
    workspacePatterns,
  );
  const artifacts: GeneratedFile[] = [
    file("package.json", `${JSON.stringify(rootManifest, null, 2)}\n`),
    file(
      "mavibase.config.ts",
      `${renderConfig(projectName, stack, backend, language, monorepo, webName, apiName)}\n`,
    ),
    file(
      "mavibase.definition.ts",
      `${renderDefinition(projectName, stack, backend, language)}\n`,
    ),
  ];

  if (language === "typescript") {
    artifacts.push(
      file(
        "tsconfig.json",
        `${JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true }, include: ["src", "apps", "packages"] }, null, 2)}\n`,
      ),
    );
  }

  if (monorepo) {
    const packageManager = registries.packageManagers.require(
      stack.packageManager,
    );
    if (packageManager.workspace?.configFile === "pnpm-workspace.yaml") {
      artifacts.push(
        file(
          "pnpm-workspace.yaml",
          'packages:\n  - "apps/*"\n  - "packages/*"\n',
        ),
      );
    }
    const appDependencies = JSON.stringify(
      {
        name: `${projectName}/${framework.category === "frontend" ? webName : apiName}`,
        version: "0.1.0",
        private: true,
        type: "module",
        dependencies,
        ...(Object.keys(devDependencies).length > 0 ? { devDependencies } : {}),
      },
      null,
      2,
    );
    const appDirectory =
      framework.category === "frontend" ? `apps/${webName}` : `apps/${apiName}`;
    artifacts.push(
      file(`${appDirectory}/package.json`, `${appDependencies}\n`),
    );
    artifacts.push(
      file(
        `${appDirectory}/src/index.${framework.category === "frontend" ? `${sourceExtension(language)}x` : sourceExtension(language)}`,
        `export const application = ${JSON.stringify(framework.name)};\n`,
      ),
    );
    if (backend && backend !== stack.framework) {
      const backendDefinition = registries.frameworks.require(backend);
      const backendDependencies: Record<string, string> = {};
      for (const dependency of backendDefinition.dependencies ?? []) {
        addDependency(
          backendDependencies,
          dependency,
          backendDefinition.dependencyVersions,
        );
      }
      artifacts.push(
        file(
          `apps/${apiName}/package.json`,
          `${JSON.stringify({ name: `${projectName}/${apiName}`, version: "0.1.0", private: true, type: "module", dependencies: backendDependencies }, null, 2)}\n`,
        ),
      );
      artifacts.push(
        file(
          `apps/${apiName}/src/index.${sourceExtension(language)}`,
          `export const application = ${JSON.stringify(registries.frameworks.require(backend).name)};\n`,
        ),
      );
    }
  } else {
    artifacts.push(
      file(
        `src/index.${framework.category === "frontend" ? `${sourceExtension(language)}x` : sourceExtension(language)}`,
        `export const application = ${JSON.stringify(framework.name)};\n`,
      ),
    );
  }

  return artifacts;
}

function renderConfig(
  projectName: string,
  stack: StackDefinition,
  backend: string | undefined,
  language: "typescript" | "javascript",
  monorepo: boolean,
  webName: string,
  apiName: string,
): string {
  return `export default ${JSON.stringify(
    {
      projectName,
      stackId: stack.id,
      language,
      monorepo,
      stack: {
        framework: stack.framework,
        runtime: stack.runtime,
        database: stack.database,
        packageManager: stack.packageManager,
      },
      applications: {
        ...(backend && backend !== stack.framework
          ? {
              web: { name: webName, framework: stack.framework },
              api: { name: apiName, framework: backend },
            }
          : {
              [stack.framework === "react" ? "web" : "api"]: {
                name: stack.framework === "react" ? webName : apiName,
                framework: stack.framework,
              },
            }),
      },
    },
    null,
    2,
  )} as const;`;
}

function renderDefinition(
  projectName: string,
  stack: StackDefinition,
  backend: string | undefined,
  language: "typescript" | "javascript",
): string {
  const stackDefinition = {
    language,
    runtime: stack.runtime,
    ...(stack.framework === "react" || stack.framework === "nextjs"
      ? {
          web: {
            framework: stack.framework === "nextjs" ? "next" : stack.framework,
          },
        }
      : { backend: { framework: stack.framework } }),
    ...(backend && backend !== stack.framework
      ? { backend: { framework: backend } }
      : {}),
    database: { provider: stack.database },
  };
  return `export default ${JSON.stringify({ name: projectName, version: "0.1.0", environment: "development", stack: stackDefinition, models: [], definitions: {} }, null, 2)} as const;`;
}

export async function createMavibaseApp(
  options: CreateAppOptions,
): Promise<CreateAppResult> {
  const projectName = options.projectName ?? "";
  const nameIssues = validateProjectName(projectName);
  if (nameIssues.length > 0)
    throw new ProjectCreationError(nameIssues.join(" "));

  const language = options.language ?? "typescript";
  const monorepo = options.monorepo ?? false;
  const webName = options.webName ?? "web";
  const apiName = options.apiName ?? "api";
  if (monorepo) {
    validateApplicationName(webName, "Web application name");
    validateApplicationName(apiName, "API application name");
  }

  const registries = options.registries ?? createDefaultStackRegistries();
  const stack = resolveStack(options, registries);
  const backend =
    options.backend && options.backend !== stack.framework
      ? options.backend
      : undefined;
  const directory = resolve(
    options.targetDirectory ?? join(process.cwd(), projectName),
  );
  const runner = options.runner ?? defaultProcessRunner;
  const command = packageManagerCommand(stack, registries);
  if (!options.skipInstall) {
    try {
      await runner.run(command, ["--version"], dirname(directory));
    } catch (error) {
      throw new ProjectCreationError(
        `Package manager "${stack.packageManager}" is not available.`,
        error,
      );
    }
  }

  const createdDirectory = await ensureDestination(directory);
  try {
    const filesystem = createFilesystem({
      rootDir: directory,
      targetRoot: ".",
    });
    const artifacts = createArtifacts(
      projectName,
      stack,
      backend,
      language,
      monorepo,
      webName,
      apiName,
      registries,
    );
    await filesystem.write(artifacts);
    if (!options.skipInstall) {
      const installArgs = packageManagerInstallArgs(stack, monorepo);
      try {
        await runner.run(command, installArgs, directory);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new ProjectCreationError(
          `Dependency installation failed while running "${command} ${installArgs.join(" ")}": ${reason}`,
          error,
        );
      }
    }
    return {
      projectName,
      projectDirectory: directory,
      stack,
      ...(backend ? { backend } : {}),
      language,
      monorepo,
      installed: !options.skipInstall,
      files: artifacts
        .map((artifact) => artifact.path)
        .sort((left, right) => left.localeCompare(right)),
    };
  } catch (error) {
    if (createdDirectory) await rm(directory, { recursive: true, force: true });
    if (error instanceof ProjectCreationError) throw error;
    throw new ProjectCreationError(
      "Project creation failed. No partially initialized project was kept.",
      error,
    );
  }
}

export async function legacyInteractiveOptions(
  ask: (question: string) => Promise<string>,
  registries: StackRegistries = createDefaultStackRegistries(),
): Promise<CreateAppOptions> {
  const stacks = createDefaultStackRegistryWithRegistries(registries).list();
  const projectName = await ask("Project name: ");
  const stackAnswer = await ask(
    `Stack (${stacks.map((stack, index) => `${index + 1}) ${stack.id}`).join(", ")}): `,
  );
  const stack =
    stacks[Number.parseInt(stackAnswer, 10) - 1] ??
    stacks.find((candidate) => candidate.id === stackAnswer);
  if (!stack)
    throw new ProjectCreationError(
      "Choose a valid stack from the available options.",
    );
  const monorepo = (await ask("Monorepo? (y/N): ")).toLowerCase() === "y";
  const languageAnswer = await ask(
    "Language (typescript/javascript, default typescript): ",
  );
  const language =
    languageAnswer === "javascript" ? "javascript" : "typescript";
  return {
    projectName,
    stackId: stack.id,
    language,
    monorepo,
    ...(monorepo
      ? {
          webName: (await ask("Web application name (web): ")) || "web",
          apiName: (await ask("API application name (api): ")) || "api",
        }
      : {}),
  };
}

export interface InteractivePrompter {
  text(question: string, defaultValue?: string): Promise<string>;
  select(
    question: string,
    options: readonly { label: string; value: string }[],
  ): Promise<string>;
  confirm(question: string, defaultValue?: boolean): Promise<boolean>;
}

function createDefaultStackRegistryWithRegistries(
  registries: StackRegistries,
): StackRegistry {
  return new StackRegistry(builtInStackDefinitions, registries);
}

export async function interactiveOptions(
  prompter: InteractivePrompter,
  registries: StackRegistries = createDefaultStackRegistries(),
  initialOptions: CreateAppOptions = {},
): Promise<CreateAppOptions> {
  const projectName =
    initialOptions.projectName ?? (await prompter.text("Project name"));
  const selectDefinitions = async (
    question: string,
    definitions: readonly { id: string; name: string }[],
  ): Promise<string> =>
    prompter.select(
      question,
      definitions.map((definition) => ({
        label: definition.name + " (" + definition.id + ")",
        value: definition.id,
      })),
    );
  const applicationType = await prompter.select("Application type", [
    { label: "Full-stack", value: "full-stack" },
    { label: "Frontend", value: "frontend" },
    { label: "Backend", value: "backend" },
  ]);
  const frontendDefinitions = registries.frameworks
    .list()
    .filter((definition) => definition.category === "frontend");
  const backendDefinitions = registries.frameworks
    .list()
    .filter((definition) => definition.category === "backend");
  const framework =
    initialOptions.framework ??
    (await selectDefinitions(
      applicationType === "backend"
        ? "Backend framework"
        : "Frontend framework",
      applicationType === "backend" ? backendDefinitions : frontendDefinitions,
    ));
  const runtime =
    initialOptions.runtime ??
    (await selectDefinitions("Runtime", registries.runtimes.list()));
  const database =
    initialOptions.database ??
    (await selectDefinitions("Database", registries.databases.list()));
  const packageManager =
    initialOptions.packageManager ??
    (await selectDefinitions(
      "Package manager",
      registries.packageManagers.list(),
    ));
  const frameworkDefinition = registries.frameworks.require(framework);
  const backend =
    applicationType === "full-stack"
      ? await selectDefinitions("Backend framework", backendDefinitions)
      : undefined;
  const language =
    initialOptions.language ??
    ((await prompter.select("Language", [
      { label: "TypeScript", value: "typescript" },
      { label: "JavaScript", value: "javascript" },
    ])) as "typescript" | "javascript");
  const monorepo =
    initialOptions.monorepo ??
    (await prompter.confirm("Create a monorepo", false));
  const webName =
    monorepo && (frameworkDefinition.category === "frontend" || backend)
      ? await prompter.text("Web application name", "web")
      : undefined;
  const apiName =
    monorepo && (frameworkDefinition.category === "backend" || backend)
      ? await prompter.text("API application name", "api")
      : undefined;
  return {
    projectName,
    framework,
    runtime,
    database,
    packageManager,
    ...(backend ? { backend } : {}),
    language,
    monorepo,
    ...(webName ? { webName } : {}),
    ...(apiName ? { apiName } : {}),
  };
}
