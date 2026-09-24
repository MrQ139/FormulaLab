import type { EvalFunction } from "mathjs";
import { parse as parseYaml } from "yaml";
import {
	createSlider, formatNumber, getErrorMessage, getThemeColor, isRecord, loadPlotly, optionalString, renderTex, SliderElements,
	TERM, toNumber,
} from "../ui";

export type MathModule = typeof import("mathjs");

export type FormulaParam = {
	label?: string;
	value: number;
	min: number;
	max: number;
	step: number;
};

/** A reference line drawn on the plot; `x`/`y` may be a number or a formula using the parameters. */
export type FormulaMark = {
	x?: string;
	y?: string;
	label?: string;
};

export type FormulaLabConfig = {
	title?: string;
	mode?: string;
	formula: string;
	/** Optional LaTeX shown instead of the formula converted by mathjs. */
	latex?: string;
	x: string;
	x_label?: string;
	y_label?: string;
	x_min: number;
	x_max: number;
	x_init: number;
	params: Record<string, FormulaParam>;
	marks: FormulaMark[];
};

const POINT_COUNT = 300;

export function parseFormulaLabConfig(source: string): FormulaLabConfig {
	let parsed: unknown;

	try {
		parsed = parseYaml(source);
	} catch (error) {
		throw new Error(`YAML parsing failed: ${getErrorMessage(error)}`);
	}

	if (!isRecord(parsed)) {
		throw new Error("FormulaLab block must contain a YAML object.");
	}

	const raw = parsed;
	const rawParams = isRecord(raw.params) ? raw.params : {};
	const params: Record<string, FormulaParam> = {};

	for (const [name, param] of Object.entries(rawParams)) {
		params[name] = isRecord(param)
			? { label: optionalString(param.label), value: toNumber(param.value), min: toNumber(param.min), max: toNumber(param.max), step: toNumber(param.step) }
			: { value: Number.NaN, min: Number.NaN, max: Number.NaN, step: Number.NaN };
	}

	const marks: FormulaMark[] = [];
	for (const mark of Array.isArray(raw.marks) ? raw.marks : []) {
		if (!isRecord(mark)) continue;
		const text = (value: unknown) => (value === undefined || value === null || value === "" ? undefined : String(value));
		marks.push({ x: text(mark.x), y: text(mark.y), label: optionalString(mark.label) });
	}

	return {
		title: optionalString(raw.title),
		mode: optionalString(raw.mode),
		formula: String(raw.formula ?? ""),
		latex: optionalString(raw.latex),
		x: String(raw.x ?? ""),
		x_label: optionalString(raw.x_label),
		y_label: optionalString(raw.y_label),
		x_min: toNumber(raw.x_min),
		x_max: toNumber(raw.x_max),
		x_init: toNumber(raw.x_init),
		params,
		marks,
	};
}

export function validateConfig(config: FormulaLabConfig, math: MathModule): string[] {
	const errors: string[] = [];
	const finite = Number.isFinite;

	if (!config.formula.trim()) errors.push("Missing required field: formula");
	if (!config.x.trim()) errors.push("Missing required field: x");
	if (!finite(config.x_min)) errors.push("x_min must be a valid number.");
	if (!finite(config.x_max)) errors.push("x_max must be a valid number.");
	if (!finite(config.x_init)) errors.push("x_init must be a valid number.");
	if (finite(config.x_min) && finite(config.x_max) && config.x_min >= config.x_max) errors.push("x_min must be smaller than x_max.");
	if (finite(config.x_init) && finite(config.x_min) && finite(config.x_max) && (config.x_init < config.x_min || config.x_init > config.x_max)) {
		errors.push("x_init must be between x_min and x_max.");
	}
	if (Object.keys(config.params).length === 0) errors.push("params must define at least one parameter.");

	for (const [name, param] of Object.entries(config.params)) {
		for (const field of ["value", "min", "max", "step"] as const) {
			if (!finite(param[field])) errors.push(`Parameter "${name}" field "${field}" must be a valid number.`);
		}
		if (finite(param.min) && finite(param.max) && param.min >= param.max) errors.push(`Parameter "${name}" min must be smaller than max.`);
		if (finite(param.step) && param.step <= 0) errors.push(`Parameter "${name}" step must be greater than 0.`);
		if (finite(param.value) && finite(param.min) && finite(param.max) && (param.value < param.min || param.value > param.max)) {
			errors.push(`Parameter "${name}" value must be between min and max.`);
		}
	}

	for (const expression of [config.formula, ...config.marks.flatMap(mark => [mark.x, mark.y])]) {
		if (!expression) continue;
		try {
			math.compile(expression);
		} catch (error) {
			errors.push(`Formula parsing failed (${expression}): ${getErrorMessage(error)}`);
		}
	}
	for (const [index, mark] of config.marks.entries()) {
		if (!mark.x && !mark.y) errors.push(`marks[${index}] needs x or y.`);
	}

	return errors;
}

function evaluate(compiled: EvalFunction, scope: Record<string, number>): number {
	const result = compiled.evaluate(scope);
	const value = typeof result === "number" ? result : Number(result);
	return Number.isFinite(value) ? value : Number.NaN;
}

/** The formula as typeset math; falls back to the raw mathjs text if LaTeX conversion fails. */
function renderFormulaMath(container: HTMLElement, config: FormulaLabConfig, math: MathModule): void {
	try {
		// y_label "Re [-]" → "Re = …", so the formula says what it computes. Non-Latin labels are left out.
		const name = splitUnit(config.y_label ?? "").name;
		const lhs = /^[A-Za-z][A-Za-z0-9]*$/.test(name) ? `\\mathrm{${name}} = ` : "";
		renderTex(container, config.latex ?? lhs + math.parse(config.formula).toTex({ parenthesis: "auto", implicit: "hide" }), true);
	} catch {
		container.classList.remove("formulalab-formula-math");
		container.setText(config.formula);
	}
}

/** "속도 U [m/s]" → "속도 U": readouts put the unit after the number instead. */
function splitUnit(label: string): { name: string; unit: string } {
	const match = label.match(/^(.*?)\s*\[([^\]]*)\]\s*$/);
	return match ? { name: match[1], unit: match[2] === "-" ? "" : match[2] } : { name: label, unit: "" };
}

export function renderFormulaLab(el: HTMLElement, config: FormulaLabConfig, math: MathModule): void {
	el.empty();

	const compiled = math.compile(config.formula);
	const marks = config.marks.map(mark => ({
		label: mark.label ?? "",
		x: mark.x ? math.compile(mark.x) : null,
		y: mark.y ? math.compile(mark.y) : null,
	}));
	const state = {
		currentX: config.x_init,
		params: Object.fromEntries(Object.entries(config.params).map(([name, param]) => [name, param.value])),
	};
	const idPrefix = `formulalab-${Math.random().toString(36).slice(2)}`;
	const xLabel = config.x_label ?? config.x;
	const yLabel = config.y_label ?? "y";
	const xParts = splitUnit(xLabel), yParts = splitUnit(yLabel);

	const card = el.createDiv({ cls: "formulalab-card" });
	const header = card.createDiv({ cls: "formulalab-header" });
	header.createEl("h4", { text: config.title ?? "FormulaLab" });
	if (config.mode) header.createSpan({ cls: "formulalab-mode", text: config.mode });

	renderFormulaMath(card.createDiv({ cls: "formulalab-formula formulalab-formula-math" }), config, math);

	// The answer first: the current value in large type, then the controls that change it.
	const readout = card.createDiv({ cls: "formulalab-readout" });
	const readoutMain = readout.createDiv({ cls: "formulalab-readout-main" });
	const readoutSub = readout.createDiv({ cls: "formulalab-readout-sub" });

	const controls = card.createDiv({ cls: "formulalab-controls" });
	const xSlider = createSlider(controls, {
		id: `${idPrefix}-x`,
		label: `${xLabel} · 그래프 위 점`,
		value: config.x_init,
		min: config.x_min,
		max: config.x_max,
		step: (config.x_max - config.x_min) / 200,
	});
	xSlider.input.closest(".formulalab-slider-row")?.classList.add("is-primary");
	xSlider.input.addEventListener("input", () => {
		state.currentX = Number(xSlider.input.value);
		update();
	});

	const sliders = new Map<string, SliderElements>([[config.x, xSlider]]);
	for (const [name, param] of Object.entries(config.params)) {
		const slider = createSlider(controls, { id: `${idPrefix}-${name}`, label: param.label ?? name, ...param });
		slider.input.addEventListener("input", () => {
			state.params[name] = Number(slider.input.value);
			update();
		});
		sliders.set(name, slider);
	}

	const errorEl = card.createDiv({ cls: "formulalab-runtime-error" });
	const plotEl = card.createDiv({ cls: "formulalab-plot" });

	function update(): void {
		try {
			errorEl.setText("");
			xSlider.value.setText(formatNumber(state.currentX));
			for (const [name, slider] of sliders) if (name !== config.x) slider.value.setText(formatNumber(state.params[name]));

			const xs: number[] = [], ys: number[] = [];
			for (let i = 0; i < POINT_COUNT; i++) {
				const x = config.x_min + ((config.x_max - config.x_min) * i) / (POINT_COUNT - 1);
				xs.push(x);
				ys.push(evaluate(compiled, { ...state.params, [config.x]: x }));
			}
			const currentY = evaluate(compiled, { ...state.params, [config.x]: state.currentX });

			readoutMain.setText(`${yParts.name} = ${formatNumber(currentY)}${yParts.unit ? ` ${yParts.unit}` : ""}`);
			readoutSub.setText(`${xParts.name} = ${formatNumber(state.currentX)}${xParts.unit ? ` ${xParts.unit}` : ""} 일 때`);

			const muted = getThemeColor("--text-muted"), grid = getThemeColor("--background-modifier-border");
			const finiteYs = ys.filter(Number.isFinite);
			const yLow = Math.min(0, ...finiteYs), yHigh = Math.max(...finiteYs, currentY);
			const shapes: Array<Record<string, unknown>> = [];
			const annotations: Array<Record<string, unknown>> = [];

			// Dotted guides from the current point to both axes, like reading a value off a printed chart.
			if (Number.isFinite(currentY)) {
				const guide = { type: "line", line: { color: TERM.orange, width: 1, dash: "dot" }, layer: "below" };
				shapes.push({ ...guide, x0: state.currentX, x1: state.currentX, y0: yLow, y1: currentY });
				shapes.push({ ...guide, x0: config.x_min, x1: state.currentX, y0: currentY, y1: currentY });
				annotations.push({
					x: state.currentX, y: currentY, text: formatNumber(currentY), showarrow: true, arrowhead: 0, arrowcolor: TERM.orange,
					ax: state.currentX > (config.x_min + config.x_max) / 2 ? -46 : 46, ay: -30,
					font: { color: TERM.orange, size: 13 }, bgcolor: getThemeColor("--background-primary"), borderpad: 2,
				});
			}

			const scope = { ...state.params, [config.x]: state.currentX };
			for (const mark of marks) {
				const line = { type: "line", line: { color: muted, width: 1.2, dash: "dash" }, layer: "below" };
				if (mark.x) {
					const x = evaluate(mark.x, scope);
					if (!Number.isFinite(x)) continue;
					shapes.push({ ...line, x0: x, x1: x, yref: "paper", y0: 0, y1: 1 });
					if (mark.label) annotations.push({ x, yref: "paper", y: 1, text: mark.label, showarrow: false, yanchor: "bottom", font: { color: muted, size: 12 } });
				}
				if (mark.y) {
					const y = evaluate(mark.y, scope);
					if (!Number.isFinite(y)) continue;
					shapes.push({ ...line, xref: "paper", x0: 0, x1: 1, y0: y, y1: y });
					if (mark.label) annotations.push({ xref: "paper", x: 1, y, text: mark.label, showarrow: false, xanchor: "right", yanchor: "bottom", font: { color: muted, size: 12 } });
				}
			}

			const axis = (title: string) => ({
				title: { text: title, font: { size: 13 }, standoff: 10 }, automargin: true, gridcolor: grid, zeroline: false, exponentformat: "power", separatethousands: true,
				linecolor: grid, ticks: "outside", tickcolor: grid,
			});
			const data = [
				{ x: xs, y: ys, type: "scatter", mode: "lines", line: { width: 3, color: TERM.blue }, hovertemplate: `${xParts.name} %{x:.3g}<br>${yParts.name} %{y:.3g}<extra></extra>` },
				{ x: [state.currentX], y: [currentY], type: "scatter", mode: "markers", marker: { size: 12, color: TERM.orange, line: { width: 2, color: getThemeColor("--background-primary") } }, hoverinfo: "skip" },
			];
			const layout = {
				margin: { l: 64, r: 20, t: marks.some(m => m.x && m.label) ? 28 : 12, b: 52 },
				height: 340,
				autosize: true,
				paper_bgcolor: "rgba(0,0,0,0)",
				plot_bgcolor: "rgba(0,0,0,0)",
				font: { color: getThemeColor("--text-normal"), size: 12 },
				xaxis: { ...axis(xLabel), range: [config.x_min, config.x_max] },
				yaxis: { ...axis(yLabel), range: yHigh > yLow ? [yLow, yHigh + 0.08 * (yHigh - yLow)] : undefined },
				showlegend: false,
				shapes,
				annotations,
				hovermode: "closest",
			};

			void loadPlotly().then(Plotly => Plotly.react(plotEl, data, layout, { displayModeBar: false, responsive: true }));
		} catch (error) {
			errorEl.setText(`Evaluation failed: ${getErrorMessage(error)}`);
		}
	}

	update();
}
