# Coding standards

## Coding preferences

- The top priority is the next smallest pull request that delivers something useful to the product's users.
- Keep things simple. Build only what is needed now.
- Take advantage of type safety.
- Leave the code better than you found it. Refactor to clean code without fear.
- Let the code explain itself through small, self-describing functions. Write a comment only for what the code cannot say.

## Tests

Each test is outside-in, focused on one behaviour, and as well written as the code it tests.

- Write the test first. Watch it fail, then make it pass.
- Drive the code through its public entry point, such as a command, an HTTP route, or an exported function. Give it real input.
- Assert only on what a caller can see: the output, the exit code, the stored data, the file written.
- Use the real dependency when a test can run it, such as a temporary directory, a local database, or a child process. Fake only what the test cannot run. A fake accepts only what the real dependency accepts.
- Do not assert on which internal function ran, how often, or with which arguments. Such a test breaks on a refactor and misses a real bug.
- Never wait on real time. Control the clock instead.
- Break the behaviour on purpose and check that the test fails.
- Avoid smoke tests that guard nothing.
