#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { emitKeypressEvents } from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import {
  createMavibaseApp,
  interactiveOptions,
  type InteractivePrompter,
  ProjectCreationError,
  type CreateAppOptions,
} from "./create-app.js";

function parseArgs(
  args: readonly string[],
): CreateAppOptions & { help?: boolean; interactive?: boolean } {
  const options: CreateAppOptions & { help?: boolean; interactive?: boolean } =
    {};
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument) continue;
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const [key, inlineValue] = argument.slice(2).split("=", 2);
    const isBooleanOption = [
      "help",
      "non-interactive",
      "monorepo",
      "no-monorepo",
      "skip-install",
    ].includes(key ?? "");
    const value = inlineValue ?? (isBooleanOption ? undefined : args[++index]);
    const requiredValue = (): string => {
      if (!value || value.startsWith("--")) {
        throw new ProjectCreationError(`Option "--${key}" requires a value.`);
      }
      return value;
    };
    switch (key) {
      case "help":
        options.help = true;
        break;
      case "non-interactive":
        options.interactive = false;
        break;
      case "framework":
        options.framework = requiredValue();
        break;
      case "backend":
        options.backend = requiredValue();
        break;
      case "runtime":
        options.runtime = requiredValue();
        break;
      case "database":
        options.database = requiredValue();
        break;
      case "package-manager":
        options.packageManager = requiredValue();
        break;
      case "language":
        options.language = requiredValue() as "typescript" | "javascript";
        break;
      case "monorepo":
        options.monorepo = true;
        break;
      case "no-monorepo":
        options.monorepo = false;
        break;
      case "web-name":
        options.webName = requiredValue();
        break;
      case "api-name":
        options.apiName = requiredValue();
        break;
      case "stack":
        options.stackId = requiredValue();
        break;
      case "skip-install":
        options.skipInstall = true;
        break;
      default:
        throw new ProjectCreationError(`Unknown option: "--${key}".`);
    }
  }
  if (positional[0]) options.projectName = positional[0];
  return options;
}

function usage(): string {
  return `Usage: create-mavibase-app [project-name] [options]\n\nOptions:\n  --stack <id>             Use a registered stack\n  --framework <id>        Select the framework\n  --backend <id>          Add a compatible backend application\n  --runtime <id>          Select the runtime\n  --database <id>         Select the database provider\n  --package-manager <id>  Select the package manager\n  --language <id>         typescript or javascript\n  --monorepo              Create a workspace project\n  --skip-install          Create files without running the package manager\n  --non-interactive       Require configuration from arguments\n  --help                  Show this help`;
}

function createPrompter(): InteractivePrompter {
  return {
    async text(question, defaultValue) {
      const readline = createInterface({ input, output });
      try {
        const answer = await readline.question(
          defaultValue
            ? question + " [" + defaultValue + "]: "
            : question + ": ",
        );
        return answer || defaultValue || "";
      } finally {
        readline.close();
      }
    },
    async confirm(question, defaultValue = false) {
      const answer = await this.text(
        question + (defaultValue ? " (Y/n)" : " (y/N)"),
      );
      if (!answer) return defaultValue;
      return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
    },
    async select(question, options) {
      if (options.length === 0)
        throw new ProjectCreationError("No options are available.");
      if (!input.isTTY || !input.setRawMode) {
        const readline = createInterface({ input, output });
        try {
          const answer = await readline.question(
            question +
              " (" +
              options.map((option) => option.label).join(", ") +
              "): ",
          );
          const selected = options.find((option) => option.value === answer);
          if (!selected)
            throw new ProjectCreationError(
              "Choose one of the displayed options.",
            );
          return selected.value;
        } finally {
          readline.close();
        }
      }

      emitKeypressEvents(input);
      input.setRawMode(true);
      input.resume();
      let selectedIndex = 0;
      let rendered = false;
      const render = () => {
        if (rendered) output.write("\x1b[" + (options.length + 1) + "A");
        output.write("\x1b[2K\r" + question + " (Use arrows and Enter)\n");
        for (const [index, option] of options.entries()) {
          output.write(
            "\x1b[2K\r" +
              (index === selectedIndex ? "> " : "  ") +
              option.label +
              "\n",
          );
        }
        rendered = true;
      };
      render();
      return await new Promise<string>((resolveSelection, rejectSelection) => {
        const onKeypress = (
          character: string,
          key: { name?: string; ctrl?: boolean },
        ) => {
          if (key.ctrl && key.name === "c") {
            cleanup();
            rejectSelection(new ProjectCreationError("Setup cancelled."));
            return;
          }
          if (key.name === "up")
            selectedIndex =
              (selectedIndex + options.length - 1) % options.length;
          if (key.name === "down")
            selectedIndex = (selectedIndex + 1) % options.length;
          if (key.name === "return" || key.name === "enter") {
            const selected = options[selectedIndex];
            cleanup();
            if (selected) resolveSelection(selected.value);
            return;
          }
          const numericIndex = Number.parseInt(character, 10) - 1;
          if (numericIndex >= 0 && numericIndex < options.length)
            selectedIndex = numericIndex;
          render();
        };
        const cleanup = () => {
          input.off("keypress", onKeypress);
          input.setRawMode?.(false);
          output.write("\n");
        };
        input.on("keypress", onKeypress);
      });
    },
  };
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
): Promise<number> {
  try {
    const parsed = parseArgs(args);
    if (parsed.help) {
      console.log(usage());
      return 0;
    }
    let options: CreateAppOptions = parsed;
    if (
      parsed.interactive !== false &&
      (!parsed.projectName ||
        !parsed.framework ||
        !parsed.runtime ||
        !parsed.database ||
        !parsed.packageManager)
    ) {
      options = {
        ...options,
        ...(await interactiveOptions(createPrompter(), undefined, parsed)),
      };
    }
    const result = await createMavibaseApp(options);
    console.log(`Project created successfully: ${result.projectDirectory}`);
    console.log(`Stack: ${result.stack.id}`);
    console.log(`Files created: ${result.files.length}`);
    if (result.installed) console.log("Dependencies installed.");
    else console.log("Dependency installation skipped.");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`create-mavibase-app failed: ${message}`);
    return 1;
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  process.exitCode = await main();
}

export * from "./create-app.js";
