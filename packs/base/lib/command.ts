export async function runCommand(command: () => number | Promise<number>): Promise<never> {
  try {
    process.exit(await command());
  } catch (error) {
    console.error(`fleet: ${(error as Error).message}`);
    process.exit(1);
  }
}
