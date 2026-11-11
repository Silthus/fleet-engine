/** The exit code of a check that cannot tell, such as a probe that could not read what it looks for. */
export const cannotTell = 3;

/** Exits with the command's code, or prints its error and exits failed, which is 1 unless the command is a probe that then cannot tell. */
export async function runCommand(command: () => number | Promise<number>, label = "fleet", failed = 1): Promise<never> {
  try {
    process.exit(await command());
  } catch (error) {
    console.error(`${label}: ${(error as Error).message}`);
    process.exit(failed);
  }
}

/** The exit code for a failure of a mode: a left probe that fails cannot tell what is still here. */
export const failedExit = (mode: string | undefined) => (mode === "left" ? cannotTell : 1);
