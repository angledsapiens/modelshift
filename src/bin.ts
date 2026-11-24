#!/usr/bin/env node
import { main } from "./cli.js";

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`modelshift: ${(err as Error).message}\n`);
    process.exit(2);
  },
);
