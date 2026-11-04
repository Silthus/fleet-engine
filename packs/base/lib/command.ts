export async function runCommand(command: () => number | Promise<number>, label = "fleet"): Promise<never> {
  try {
    process.exit(await command());
  } catch (error) {
    console.error(`${label}: ${(error as Error).message}`);
    process.exit(1);
  }
}
