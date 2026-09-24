import { strict as assert } from "node:assert";
import * as math from "mathjs";
import { parseFlowSceneConfig } from "../src/views/flowScene";
import { parseFormulaLabConfig, validateConfig } from "../src/views/formulaLab";
import { formatNumber } from "../src/ui";

const results: string[] = [];
function test(name: string, body: () => void): void {
	body();
	results.push(`ok  ${name}`);
}

test("numbers read as three significant digits, with ×10ⁿ only for very large or small values", () => {
	assert.equal(formatNumber(0.818804), "0.819");
	assert.equal(formatNumber(50000), "50,000");
	assert.equal(formatNumber(1e6), "1.00×10⁶");
	assert.equal(formatNumber(-0.00012), "-1.20×10⁻⁴");
	assert.equal(formatNumber(0), "0");
	assert.equal(formatNumber(Number.NaN), "—");
});

test("older flow-scene blocks still parse; parameters the new scenes do not use are dropped", () => {
	const cv = parseFlowSceneConfig("type: control-volume-flux\nparams:\n  inflow: { value: 1.1 }\n  outflow: { value: 0.8 }\n  storage: { value: 0.25 }");
	assert.deepEqual(Object.keys(cv.params), ["inflow", "outflow"]);
	assert.equal(cv.params.inflow.value, 1.1);
	assert.equal(cv.params.inflow.label, "유입 ṁ_in");
	const streak = parseFlowSceneConfig("type: streamline-pathline-streakline\nparams:\n  shear: { value: 0.35 }");
	assert.deepEqual(Object.keys(streak.params), ["U", "unsteady"]);
	const bernoulli = parseFlowSceneConfig("type: bernoulli-streamtube\nparams:\n  height: { value: -0.3 }");
	assert.equal(bernoulli.params.zRise.value, -0.3);
	const custom = parseFlowSceneConfig("type: pipe-poiseuille\nparams:\n  extra: { value: 2 }");
	assert.ok(custom.params.extra, "unknown parameters that are not obsolete are kept");
	assert.throws(() => parseFlowSceneConfig("type: nope"));
});

test("formulalab marks accept numbers or formulas and are validated like the main formula", () => {
	const source = [
		"formula: x^2 + a", "x: x", "x_min: 0", "x_max: 1", "x_init: 0.5",
		"params:", "  a: { value: 1, min: 0, max: 2, step: 0.1 }",
		"marks:", "  - x: 'a/4'", "    label: quarter", "  - y: 1",
	].join("\n");
	const config = parseFormulaLabConfig(source);
	assert.deepEqual(config.marks, [{ x: "a/4", y: undefined, label: "quarter" }, { x: undefined, y: "1", label: undefined }]);
	assert.deepEqual(validateConfig(config, math), []);
	const broken = parseFormulaLabConfig(source.replace("'a/4'", "'a/('") + "\n  - label: nothing");
	const errors = validateConfig(broken, math);
	assert.ok(errors.some(e => e.includes("a/(")), errors.join("; "));
	assert.ok(errors.some(e => e.includes("marks[2] needs x or y")), errors.join("; "));
});

console.log(results.join("\n"));
console.log(`\n${results.length} view tests passed`);
