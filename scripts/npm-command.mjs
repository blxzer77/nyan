import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function execNpmSync(args, options = {}) {
	if (process.platform !== "win32") return execFileSync("npm", args, options);
	const npmCli = process.env.npm_execpath;
	if (npmCli && existsSync(npmCli)) return execFileSync(process.execPath, [npmCli, ...args], options);
	const bundledNpmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
	if (existsSync(bundledNpmCli)) return execFileSync(process.execPath, [bundledNpmCli, ...args], options);
	throw new Error("Cannot locate the npm CLI on Windows");
}
