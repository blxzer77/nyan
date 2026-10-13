#!/usr/bin/env node
import { serveStdio } from "../rpc.js";

const root = process.argv[2] ?? process.cwd();
await serveStdio(root);
