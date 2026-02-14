import { hookCommand } from "./hook-command.js";

async function main(): Promise<void> {
  const [, , command, platform, event] = process.argv;

  if (command !== "hook") {
    console.error("Usage: bun run src/cli/index.ts hook <platform> <event>");
    process.exit(2);
  }

  if (!platform || !event) {
    console.error("Missing platform or event");
    process.exit(2);
  }

  const code = await hookCommand(platform, event);
  process.exit(code);
}

main().catch((error) => {
  console.error(`[codexmem] cli fatal: ${String(error)}`);
  process.exit(2);
});
