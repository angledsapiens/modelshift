#!/usr/bin/env node
import { main } from "./cli.js";

// Set the exit code and let Node shut down by itself. Calling process.exit() while network
// connections are still closing crashes Node on Windows (libuv "UV_HANDLE_CLOSING" assertion, exit 127).
// A backstop timer (unref'd, so it never delays a clean exit) ends the process if a stray handle lingers.
const finish = (code: number) => {
  process.exitCode = code;
  setTimeout(() => process.exit(code), 3000).unref();
};

main().then(finish, (err) => {
  process.stderr.write(`modelshift: ${(err as Error).message}\n`);
  finish(2);
});
