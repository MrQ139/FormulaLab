// Parses every FormulaLab block in a Markdown note with the plugin's own parsers: `node validate-note.cjs <note.md>`.
import { readFileSync } from "node:fs";
import * as math from "mathjs";
import { parseCfdCellsConfig } from "../src/views/cfdCells";
import { parseFlowSceneConfig } from "../src/views/flowScene";
import { parseFormulaLabConfig, validateConfig } from "../src/views/formulaLab";
import { parseNs2DConfig } from "../src/views/ns2dView";

const note = readFileSync(process.argv[2], "utf8");
let failures = 0, count = 0;
for (const match of note.matchAll(/^(`{3,})(formulalab|cfd-cells|ns2d|flow-scene)\s*\r?\n([\s\S]*?)^\1\s*$/gm)) {
	count++;
	const [, , kind, body] = match;
	try {
		if (kind === "cfd-cells") parseCfdCellsConfig(body);
		else if (kind === "ns2d") parseNs2DConfig(body);
		else if (kind === "flow-scene") parseFlowSceneConfig(body);
		else {
			const errors = validateConfig(parseFormulaLabConfig(body), math);
			if (errors.length) throw new Error(errors.join("; "));
		}
		console.log(`ok   ${kind}`);
	} catch (error) {
		failures++;
		console.log(`FAIL ${kind}: ${(error as Error).message}`);
	}
}
console.log(`${count} blocks, ${failures} failures`);
process.exitCode = failures ? 1 : 0;
