import { MarkdownPostProcessorContext, Plugin } from "obsidian";
import Plotly from "plotly.js-dist-min";
import { compile, EvalFunction } from "mathjs";
import { parse as parseYaml } from "yaml";

type FormulaParam = {
	label?: string;
	value: number;
	min: number;
	max: number;
	step: number;
};

type FormulaLabConfig = {
	title?: string;
	mode?: string;
	formula: string;
	x: string;
	x_label?: string;
	y_label?: string;
	x_min: number;
	x_max: number;
	x_init: number;
	params: Record<string, FormulaParam>;
};

type CurveData = {
	xValues: number[];
	yValues: number[];
};

type SliderElements = {
	input: HTMLInputElement;
	value: HTMLElement;
};

type FlowSceneType =
	| "pipe-poiseuille"
	| "material-derivative"
	| "control-volume-flux"
	| "streamline-pathline-streakline"
	| "bernoulli-streamtube";

type FlowSceneConfig = {
	title?: string;
	type: FlowSceneType;
	width: number;
	height: number;
	particles: number;
	showProfile: boolean;
	params: Record<string, FormulaParam>;
};

type FlowParticle = {
	x: number;
	y: number;
	seed: number;
	age: number;
};

type FlowSceneState = {
	params: Record<string, number>;
	particles: FlowParticle[];
	time: number;
	viewMode: "eulerian" | "lagrangian";
	probe: {
		x: number;
		y: number;
		dragging: boolean;
	};
};

type FlowSceneTerm = {
	label: string;
	symbol: string;
	value: string;
	meaning: string;
	tone?: "local" | "convective" | "total" | "loss" | "neutral";
};

type FlowSceneFormulaModel = {
	equation: string;
	interpretation: string;
	terms: FlowSceneTerm[];
	probe: string;
};

type PitotVelocityConfig = {
	p0: number;
	pstatic: number;
	unit: PressureUnit;
	rho: number;
	mdotJet?: number;
	diameterJet?: number;
	rhoJet?: number;
};

type PressureUnit = "Pa" | "kPa" | "bar" | "MPa";

type PitotVelocityStatus = {
	ok: boolean;
	message: string;
	deltaP: number;
	velocity: number;
	dynamicPressure: number;
	rho: number;
};

const POINT_COUNT = 300;
const PRESSURE_UNITS: PressureUnit[] = ["Pa", "kPa", "bar", "MPa"];

export default class FormulaLabPlugin extends Plugin {
	async onload() {
		this.registerMarkdownCodeBlockProcessor(
			"formulalab",
			(source: string, el: HTMLElement, _ctx: MarkdownPostProcessorContext) => {
				try {
					const config = parseFormulaLabConfig(source);
					const errors = validateConfig(config);

					if (errors.length > 0) {
						renderError(el, errors.join("\n"));
						return;
					}

					renderFormulaLab(el, config);
				} catch (error) {
					renderError(el, getErrorMessage(error));
				}
			}
		);

		const renderPitotProcessor = (source: string, el: HTMLElement) => {
			try {
				const config = parsePitotVelocityConfig(source);
				renderPitotVelocityCalculator(el, config);
			} catch (error) {
				renderError(el, getErrorMessage(error));
			}
		};

		this.registerMarkdownCodeBlockProcessor("pitot-velocity", renderPitotProcessor);
		this.registerMarkdownCodeBlockProcessor("pitot-n2", renderPitotProcessor);
		this.registerMarkdownCodeBlockProcessor(
			"flow-scene",
			(source: string, el: HTMLElement, _ctx: MarkdownPostProcessorContext) => {
				try {
					const config = parseFlowSceneConfig(source);
					renderFlowScene(el, config);
				} catch (error) {
					renderError(el, getErrorMessage(error));
				}
			}
		);
	}
}

function parseFormulaLabConfig(source: string): FormulaLabConfig {
	let parsed: unknown;

	try {
		parsed = parseYaml(source);
	} catch (error) {
		throw new Error(`YAML parsing failed: ${getErrorMessage(error)}`);
	}

	if (!parsed || typeof parsed !== "object") {
		throw new Error("FormulaLab block must contain a YAML object.");
	}

	const raw = parsed as Record<string, unknown>;
	const rawParams = isRecord(raw.params) ? raw.params : {};
	const params: Record<string, FormulaParam> = {};

	for (const [name, param] of Object.entries(rawParams)) {
		if (!isRecord(param)) {
			params[name] = {
				value: Number.NaN,
				min: Number.NaN,
				max: Number.NaN,
				step: Number.NaN,
			};
			continue;
		}

		params[name] = {
			label: optionalString(param.label),
			value: toNumber(param.value),
			min: toNumber(param.min),
			max: toNumber(param.max),
			step: toNumber(param.step),
		};
	}

	return {
		title: optionalString(raw.title),
		mode: optionalString(raw.mode),
		formula: String(raw.formula ?? ""),
		x: String(raw.x ?? ""),
		x_label: optionalString(raw.x_label),
		y_label: optionalString(raw.y_label),
		x_min: toNumber(raw.x_min),
		x_max: toNumber(raw.x_max),
		x_init: toNumber(raw.x_init),
		params,
	};
}

function validateConfig(config: FormulaLabConfig): string[] {
	const errors: string[] = [];

	if (!config.formula.trim()) {
		errors.push("Missing required field: formula");
	}

	if (!config.x.trim()) {
		errors.push("Missing required field: x");
	}

	if (!Number.isFinite(config.x_min)) {
		errors.push("x_min must be a valid number.");
	}

	if (!Number.isFinite(config.x_max)) {
		errors.push("x_max must be a valid number.");
	}

	if (!Number.isFinite(config.x_init)) {
		errors.push("x_init must be a valid number.");
	}

	if (Number.isFinite(config.x_min) && Number.isFinite(config.x_max) && config.x_min >= config.x_max) {
		errors.push("x_min must be smaller than x_max.");
	}

	if (
		Number.isFinite(config.x_init) &&
		Number.isFinite(config.x_min) &&
		Number.isFinite(config.x_max) &&
		(config.x_init < config.x_min || config.x_init > config.x_max)
	) {
		errors.push("x_init must be between x_min and x_max.");
	}

	if (!config.params || Object.keys(config.params).length === 0) {
		errors.push("params must define at least one parameter.");
	}

	for (const [name, param] of Object.entries(config.params ?? {})) {
		for (const field of ["value", "min", "max", "step"] as const) {
			if (!Number.isFinite(param[field])) {
				errors.push(`Parameter "${name}" field "${field}" must be a valid number.`);
			}
		}

		if (Number.isFinite(param.min) && Number.isFinite(param.max) && param.min >= param.max) {
			errors.push(`Parameter "${name}" min must be smaller than max.`);
		}

		if (Number.isFinite(param.step) && param.step <= 0) {
			errors.push(`Parameter "${name}" step must be greater than 0.`);
		}

		if (
			Number.isFinite(param.value) &&
			Number.isFinite(param.min) &&
			Number.isFinite(param.max) &&
			(param.value < param.min || param.value > param.max)
		) {
			errors.push(`Parameter "${name}" value must be between min and max.`);
		}
	}

	try {
		compile(config.formula);
	} catch (error) {
		errors.push(`Formula parsing failed: ${getErrorMessage(error)}`);
	}

	return errors;
}

function evaluateFormula(compiledExpression: EvalFunction, scope: Record<string, number>): number {
	const result = compiledExpression.evaluate(scope);
	const numericResult = typeof result === "number" ? result : Number(result);

	if (!Number.isFinite(numericResult)) {
		return Number.NaN;
	}

	return numericResult;
}

function generateCurve(
	config: FormulaLabConfig,
	compiledExpression: EvalFunction,
	currentParams: Record<string, number>
): CurveData {
	const xValues: number[] = [];
	const yValues: number[] = [];
	const denominator = Math.max(POINT_COUNT - 1, 1);

	for (let index = 0; index < POINT_COUNT; index += 1) {
		const xValue = config.x_min + ((config.x_max - config.x_min) * index) / denominator;
		const yValue = evaluateFormula(compiledExpression, {
			...currentParams,
			[config.x]: xValue,
		});

		xValues.push(xValue);
		yValues.push(yValue);
	}

	return { xValues, yValues };
}

function renderFormulaLab(el: HTMLElement, config: FormulaLabConfig): void {
	el.empty();

	const compiledExpression = compile(config.formula);
	const state = {
		currentX: config.x_init,
		params: Object.fromEntries(Object.entries(config.params).map(([name, param]) => [name, param.value])),
	};
	const controlIdPrefix = `formulalab-${Math.random().toString(36).slice(2)}`;

	const card = el.createDiv({ cls: "formulalab-card" });
	const header = card.createDiv({ cls: "formulalab-header" });
	header.createEl("h4", { text: config.title ?? "FormulaLab" });

	if (config.mode) {
		header.createSpan({ cls: "formulalab-mode", text: config.mode });
	}

	card.createDiv({ cls: "formulalab-formula", text: config.formula });

	const controls = card.createDiv({ cls: "formulalab-controls" });
	const paramSliders = new Map<string, SliderElements>();

	for (const [name, param] of Object.entries(config.params)) {
		const slider = createSlider(controls, {
			id: `${controlIdPrefix}-param-${name}`,
			label: param.label ?? name,
			value: param.value,
			min: param.min,
			max: param.max,
			step: param.step,
		});

		slider.input.addEventListener("input", () => {
			state.params[name] = Number(slider.input.value);
			slider.value.setText(formatNumber(state.params[name]));
			updatePlot();
		});

		paramSliders.set(name, slider);
	}

	const xSlider = createSlider(controls, {
		id: `${controlIdPrefix}-current-x`,
		label: config.x_label ?? config.x,
		value: config.x_init,
		min: config.x_min,
		max: config.x_max,
		step: getAutoStep(config.x_min, config.x_max),
	});

	const result = card.createDiv({ cls: "formulalab-result" });
	const xResult = result.createDiv();
	const yResult = result.createDiv();
	const errorEl = card.createDiv({ cls: "formulalab-runtime-error" });
	const plotEl = card.createDiv({ cls: "formulalab-plot" });

	xSlider.input.addEventListener("input", () => {
		state.currentX = Number(xSlider.input.value);
		xSlider.value.setText(formatNumber(state.currentX));
		updatePlot();
	});

	function updatePlot(): void {
		try {
			errorEl.setText("");

			const curve = generateCurve(config, compiledExpression, state.params);
			const currentY = evaluateFormula(compiledExpression, {
				...state.params,
				[config.x]: state.currentX,
			});

			xResult.setText(`${config.x_label ?? config.x}: ${formatNumber(state.currentX)}`);
			yResult.setText(`${config.y_label ?? "result"}: ${formatNumber(currentY)}`);

			const data = [
				{
					x: curve.xValues,
					y: curve.yValues,
					type: "scatter",
					mode: "lines",
					name: config.title ?? config.formula,
					line: { width: 2 },
				},
				{
					x: [state.currentX],
					y: [currentY],
					type: "scatter",
					mode: "markers",
					name: "current",
					marker: { size: 9 },
				},
			];

			const layout = {
				margin: { l: 56, r: 20, t: 16, b: 48 },
				height: 360,
				autosize: true,
				paper_bgcolor: "rgba(0,0,0,0)",
				plot_bgcolor: "rgba(0,0,0,0)",
				font: {
					color: getComputedStyle(document.body).getPropertyValue("--text-normal").trim() || undefined,
				},
				xaxis: {
					title: config.x_label ?? config.x,
					zeroline: true,
					gridcolor: getThemeColor("--background-modifier-border"),
				},
				yaxis: {
					title: config.y_label ?? config.formula,
					zeroline: true,
					gridcolor: getThemeColor("--background-modifier-border"),
				},
				showlegend: true,
				legend: { orientation: "h" },
			};

			Plotly.react(plotEl, data, layout, {
				displayModeBar: false,
				responsive: true,
			});
		} catch (error) {
			errorEl.setText(`Evaluation failed: ${getErrorMessage(error)}`);
		}
	}

	updatePlot();

	for (const [name, slider] of paramSliders) {
		slider.value.setText(formatNumber(state.params[name]));
	}
}

function parseFlowSceneConfig(source: string): FlowSceneConfig {
	let parsed: unknown;

	try {
		parsed = source.trim() ? parseYaml(source) : {};
	} catch (error) {
		throw new Error(`YAML parsing failed: ${getErrorMessage(error)}`);
	}

	if (!parsed || typeof parsed !== "object") {
		throw new Error("flow-scene block must contain a YAML object.");
	}

	const raw = parsed as Record<string, unknown>;
	const type = String(raw.type ?? "pipe-poiseuille");

	if (!isFlowSceneType(type)) {
		throw new Error(
			"type must be one of pipe-poiseuille, material-derivative, control-volume-flux, streamline-pathline-streakline, bernoulli-streamtube."
		);
	}

	const defaults = getDefaultFlowSceneParams(type);
	const rawParams = isRecord(raw.params) ? raw.params : {};
	const params: Record<string, FormulaParam> = {};

	for (const [name, defaultParam] of Object.entries(defaults)) {
		const param = isRecord(rawParams[name]) ? rawParams[name] : {};
		params[name] = {
			label: optionalString(param.label) ?? defaultParam.label,
			value: finiteOrDefault(param.value, defaultParam.value),
			min: finiteOrDefault(param.min, defaultParam.min),
			max: finiteOrDefault(param.max, defaultParam.max),
			step: finiteOrDefault(param.step, defaultParam.step),
		};
	}

	for (const [name, param] of Object.entries(rawParams)) {
		if (params[name] || !isRecord(param)) {
			continue;
		}

		const value = finiteOrDefault(param.value, 1);
		params[name] = {
			label: optionalString(param.label) ?? name,
			value,
			min: finiteOrDefault(param.min, Math.min(0, value)),
			max: finiteOrDefault(param.max, Math.max(2 * value, 1)),
			step: finiteOrDefault(param.step, 0.1),
		};
	}

	return {
		title: optionalString(raw.title),
		type,
		width: clamp(finiteOrDefault(raw.width, 760), 420, 1400),
		height: clamp(finiteOrDefault(raw.height, 360), 260, 820),
		particles: Math.round(clamp(finiteOrDefault(raw.particles, 36), 8, 120)),
		showProfile: raw.show_profile !== false && raw.showProfile !== false,
		params,
	};
}

function renderFlowScene(el: HTMLElement, config: FlowSceneConfig): void {
	el.empty();

	const state: FlowSceneState = {
		params: Object.fromEntries(Object.entries(config.params).map(([name, param]) => [name, param.value])),
		particles: createFlowParticles(config.particles),
		time: 0,
		viewMode: "lagrangian",
		probe: getDefaultProbe(config.type),
	};

	const controlIdPrefix = `flow-scene-${Math.random().toString(36).slice(2)}`;
	const card = el.createDiv({ cls: "formulalab-card flow-scene-card" });
	const header = card.createDiv({ cls: "formulalab-header" });
	header.createEl("h4", { text: config.title ?? getFlowSceneTitle(config.type) });
	header.createSpan({ cls: "formulalab-mode", text: "flow scene" });

	const equationPanel = card.createDiv({ cls: "flow-scene-equation-panel" });
	let viewModeButtons: Record<"eulerian" | "lagrangian", HTMLButtonElement> | null = null;
	if (config.type === "material-derivative") {
		const modeSwitch = card.createDiv({ cls: "flow-scene-mode-switch" });
		viewModeButtons = {
			eulerian: modeSwitch.createEl("button", {
				cls: "flow-scene-mode-button",
				text: "Eulerian: fixed point",
				attr: { type: "button" },
			}),
			lagrangian: modeSwitch.createEl("button", {
				cls: "flow-scene-mode-button",
				text: "Lagrangian: follow particle",
				attr: { type: "button" },
			}),
		};

		for (const [mode, button] of Object.entries(viewModeButtons) as Array<["eulerian" | "lagrangian", HTMLButtonElement]>) {
			button.addEventListener("click", () => {
				state.viewMode = mode;
				updateScene();
			});
		}
	}

	const controls = card.createDiv({ cls: "formulalab-controls flow-scene-controls" });
	for (const [name, param] of Object.entries(config.params)) {
		const slider = createSlider(controls, {
			id: `${controlIdPrefix}-param-${name}`,
			label: param.label ?? name,
			value: param.value,
			min: param.min,
			max: param.max,
			step: param.step,
		});

		slider.input.addEventListener("input", () => {
			state.params[name] = Number(slider.input.value);
			slider.value.setText(formatNumber(state.params[name]));
			updateScene();
		});
	}

	const termGrid = card.createDiv({ cls: "flow-scene-term-grid" });
	const readout = card.createDiv({ cls: "flow-scene-readout flow-scene-readout-panel" });
	const canvasWrap = card.createDiv({ cls: "flow-scene-canvas-wrap" });
	const canvas = canvasWrap.createEl("canvas", {
		cls: "flow-scene-canvas",
		attr: {
			width: String(config.width),
			height: String(config.height),
			"aria-label": `${config.type} interactive fluid simulator`,
		},
	});

	canvas.style.height = `${config.height}px`;

	const resizeObserver = new ResizeObserver(() => updateScene());
	resizeObserver.observe(canvasWrap);

	canvas.addEventListener("pointerdown", (event) => {
		state.probe.dragging = true;
		canvas.setPointerCapture(event.pointerId);
		updateProbeFromPointer(canvas, state, event);
		updateScene();
	});

	canvas.addEventListener("pointermove", (event) => {
		if (!state.probe.dragging) {
			return;
		}

		updateProbeFromPointer(canvas, state, event);
		updateScene();
	});

	canvas.addEventListener("pointerup", (event) => {
		state.probe.dragging = false;
		canvas.releasePointerCapture(event.pointerId);
	});

	canvas.addEventListener("pointercancel", () => {
		state.probe.dragging = false;
	});

	function updateScene(): void {
		if (!document.body.contains(card)) {
			resizeObserver.disconnect();
			return;
		}

		drawFlowScene(canvas, config, state);
		const model = getFlowSceneFormulaModel(config, state);
		if (viewModeButtons) {
			for (const [mode, button] of Object.entries(viewModeButtons) as Array<["eulerian" | "lagrangian", HTMLButtonElement]>) {
				button.classList.toggle("is-active", state.viewMode === mode);
				button.setAttribute("aria-pressed", String(state.viewMode === mode));
			}
		}
		renderFlowSceneEquation(equationPanel, model);
		renderFlowSceneTerms(termGrid, model);
		readout.setText(model.probe);
	}

	updateScene();
}

function isFlowSceneType(value: string): value is FlowSceneType {
	return [
		"pipe-poiseuille",
		"material-derivative",
		"control-volume-flux",
		"streamline-pathline-streakline",
		"bernoulli-streamtube",
	].includes(value);
}

function getDefaultFlowSceneParams(type: FlowSceneType): Record<string, FormulaParam> {
	switch (type) {
		case "material-derivative":
			return {
				U: { label: "Particle velocity U", value: 1.2, min: 0, max: 3, step: 0.05 },
				gradient: { label: "Spatial gradient ∂φ/∂x", value: 0.8, min: -2, max: 2, step: 0.05 },
				oscillation: { label: "Local change ∂φ/∂t scale", value: 0.6, min: 0, max: 2, step: 0.05 },
			};
		case "control-volume-flux":
			return {
				inflow: { label: "Inflow flux Σṁ_in", value: 1.1, min: 0, max: 3, step: 0.05 },
				outflow: { label: "Outflow flux Σṁ_out", value: 0.8, min: 0, max: 3, step: 0.05 },
				storage: { label: "Storage cue d/dt ∫CV ρdV", value: 0.25, min: -1, max: 1, step: 0.05 },
			};
		case "streamline-pathline-streakline":
			return {
				U: { label: "Mean velocity U", value: 1.0, min: 0.1, max: 3, step: 0.05 },
				unsteady: { label: "Unsteadiness", value: 0.9, min: 0, max: 2, step: 0.05 },
				shear: { label: "Vertical shear", value: 0.35, min: -1.5, max: 1.5, step: 0.05 },
			};
		case "bernoulli-streamtube":
			return {
				flow: { label: "Flow rate scale Q", value: 1.0, min: 0.2, max: 2.5, step: 0.05 },
				constriction: { label: "Throat constriction A_min/A", value: 0.48, min: 0.15, max: 0.85, step: 0.01 },
				zRise: { label: "Elevation rise z2 - z1", value: 0.25, min: -0.6, max: 0.6, step: 0.05 },
			};
		case "pipe-poiseuille":
		default:
			return {
				umax: { label: "Centerline speed umax", value: 2.0, min: 0.2, max: 5, step: 0.05 },
				R: { label: "Pipe radius R", value: 1.0, min: 0.2, max: 2, step: 0.05 },
				viscosity: { label: "Viscous damping cue", value: 1.0, min: 0.2, max: 3, step: 0.05 },
			};
	}
}

function getFlowSceneTitle(type: FlowSceneType): string {
	switch (type) {
		case "material-derivative":
			return "Material Derivative Scene";
		case "control-volume-flux":
			return "Control Volume Flux Scene";
		case "streamline-pathline-streakline":
			return "Streamline / Pathline / Streakline Scene";
		case "bernoulli-streamtube":
			return "Bernoulli Streamtube Scene";
		case "pipe-poiseuille":
		default:
			return "Pipe Poiseuille Flow Scene";
	}
}

function createFlowParticles(count: number): FlowParticle[] {
	const particles: FlowParticle[] = [];

	for (let index = 0; index < count; index += 1) {
		particles.push({
			x: Math.random(),
			y: Math.random(),
			seed: Math.random(),
			age: Math.random() * 10,
		});
	}

	return particles;
}

function getDefaultProbe(type: FlowSceneType): FlowSceneState["probe"] {
	switch (type) {
		case "pipe-poiseuille":
			return { x: 0.32, y: 0.5, dragging: false };
		case "control-volume-flux":
			return { x: 0.5, y: 0.5, dragging: false };
		case "bernoulli-streamtube":
			return { x: 0.5, y: 0.48, dragging: false };
		case "streamline-pathline-streakline":
			return { x: 0.42, y: 0.5, dragging: false };
		case "material-derivative":
		default:
			return { x: 0.35, y: 0.5, dragging: false };
	}
}

function updateProbeFromPointer(canvas: HTMLCanvasElement, state: FlowSceneState, event: PointerEvent): void {
	const rect = canvas.getBoundingClientRect();
	state.probe.x = clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
	state.probe.y = clamp((event.clientY - rect.top) / Math.max(rect.height, 1), 0, 1);
}

function advanceFlowParticles(config: FlowSceneConfig, state: FlowSceneState, dt: number): void {
	for (const particle of state.particles) {
		const velocity = getParticleVelocity(config, state, particle);
		particle.x += velocity.u * dt;
		particle.y += velocity.v * dt;
		particle.age += dt;

		if (config.type === "pipe-poiseuille") {
			if (particle.x > 1.04) {
				particle.x = -0.04;
				particle.y = Math.random();
			}
		} else if (particle.x > 1.06 || particle.x < -0.06 || particle.y > 1.08 || particle.y < -0.08) {
			particle.x = Math.random() * 0.12;
			particle.y = 0.2 + Math.random() * 0.6;
			particle.age = 0;
		}
	}
}

function getParticleVelocity(
	config: FlowSceneConfig,
	state: FlowSceneState,
	particle: FlowParticle
): { u: number; v: number } {
	const p = state.params;

	switch (config.type) {
		case "pipe-poiseuille": {
			const yNorm = 2 * particle.y - 1;
			const profile = Math.max(0.04, 1 - yNorm * yNorm);
			return { u: 0.16 * finiteOrDefault(p.umax, 2) * profile, v: 0 };
		}
		case "material-derivative": {
			const U = finiteOrDefault(p.U, 1.2);
			const wave = Math.sin(2 * Math.PI * (particle.x - 0.35 * state.time + particle.seed));
			return { u: 0.12 * U, v: 0.025 * finiteOrDefault(p.oscillation, 0.6) * wave };
		}
		case "control-volume-flux": {
			const leftBias = particle.x < 0.52 ? finiteOrDefault(p.inflow, 1.1) : finiteOrDefault(p.outflow, 0.8);
			const storage = finiteOrDefault(p.storage, 0.25);
			return { u: 0.12 * leftBias, v: 0.025 * storage * Math.sin(6 * particle.x + state.time) };
		}
		case "streamline-pathline-streakline": {
			const U = finiteOrDefault(p.U, 1);
			const unsteady = finiteOrDefault(p.unsteady, 0.9);
			const shear = finiteOrDefault(p.shear, 0.35);
			return {
				u: 0.11 * U * (1 + shear * (particle.y - 0.5)),
				v: 0.08 * unsteady * Math.sin(2 * Math.PI * (particle.x + 0.18 * state.time)),
			};
		}
		case "bernoulli-streamtube": {
			const throat = getBernoulliHalfHeight(p, particle.x);
			const speed = finiteOrDefault(p.flow, 1) / Math.max(throat, 0.2);
			return { u: 0.08 * speed, v: 0.02 * Math.sin(2 * Math.PI * particle.x + state.time) };
		}
		default:
			return { u: 0.1, v: 0 };
	}
}

function drawFlowScene(canvas: HTMLCanvasElement, config: FlowSceneConfig, state: FlowSceneState): void {
	const ctx = canvas.getContext("2d");
	if (!ctx) {
		return;
	}

	const cssWidth = Math.max(320, canvas.parentElement?.clientWidth ?? config.width);
	const cssHeight = config.height;
	const dpr = window.devicePixelRatio || 1;
	if (canvas.width !== Math.round(cssWidth * dpr) || canvas.height !== Math.round(cssHeight * dpr)) {
		canvas.width = Math.round(cssWidth * dpr);
		canvas.height = Math.round(cssHeight * dpr);
		canvas.style.width = `${cssWidth}px`;
		canvas.style.height = `${cssHeight}px`;
	}

	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, cssWidth, cssHeight);

	const palette = getFlowPalette();
	drawSceneBackground(ctx, cssWidth, cssHeight, palette);

	switch (config.type) {
		case "material-derivative":
			drawMaterialDerivativeScene(ctx, cssWidth, cssHeight, config, state, palette);
			break;
		case "control-volume-flux":
			drawControlVolumeScene(ctx, cssWidth, cssHeight, config, state, palette);
			break;
		case "streamline-pathline-streakline":
			drawStreamlinePathlineScene(ctx, cssWidth, cssHeight, config, state, palette);
			break;
		case "bernoulli-streamtube":
			drawBernoulliScene(ctx, cssWidth, cssHeight, config, state, palette);
			break;
		case "pipe-poiseuille":
		default:
			drawPoiseuilleScene(ctx, cssWidth, cssHeight, config, state, palette);
			break;
	}

	drawProbe(ctx, cssWidth, cssHeight, state, palette);
}

function drawSceneBackground(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	palette: Record<string, string>
): void {
	ctx.fillStyle = palette.background;
	roundRect(ctx, 0.5, 0.5, width - 1, height - 1, 8);
	ctx.fill();
	ctx.strokeStyle = palette.border;
	ctx.lineWidth = 1;
	ctx.stroke();
}

function drawPoiseuilleScene(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	config: FlowSceneConfig,
	state: FlowSceneState,
	palette: Record<string, string>
): void {
	const left = 48;
	const right = config.showProfile ? width - 190 : width - 48;
	const top = 70;
	const bottom = height - 70;
	const mid = (top + bottom) / 2;
	const half = (bottom - top) / 2;

	drawPipe(ctx, left, right, top, bottom, palette);
	drawParticles(ctx, state.particles, (p) => left + p.x * (right - left), (p) => top + p.y * (bottom - top), palette);

	for (let i = 0; i < 7; i += 1) {
		const y = top + (i / 6) * (bottom - top);
		const yNorm = (y - mid) / half;
		const u = 1 - yNorm * yNorm;
		drawArrow(ctx, left + 24, y, left + 24 + 70 * u, y, palette.accent);
	}

	ctx.fillStyle = palette.text;
	ctx.font = "13px var(--font-interface), sans-serif";
	ctx.fillText("no slip: u = 0 at wall", left + 6, top - 18);
	ctx.fillText("fastest particles near centerline", left + 6, bottom + 30);

	if (config.showProfile) {
		drawPoiseuilleProfile(ctx, width - 150, mid, 92, half, finiteOrDefault(state.params.umax, 2), palette);
	}
}

function drawMaterialDerivativeScene(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	_config: FlowSceneConfig,
	state: FlowSceneState,
	palette: Record<string, string>
): void {
	const left = 48;
	const right = width - 48;
	const top = 64;
	const bottom = height - 104;
	const U = finiteOrDefault(state.params.U, 1.2);
	const gradient = finiteOrDefault(state.params.gradient, 0.8);
	const localRate = finiteOrDefault(state.params.oscillation, 0.6);
	const dt = 0.16;
	const probeX = left + state.probe.x * (right - left);
	const probeY = top + state.probe.y * (bottom - top);
	const nextXNorm = clamp(state.probe.x + U * dt * 0.18, 0, 1);
	const nextX = left + nextXNorm * (right - left);
	const fixedPointY = Math.max(top + 34, probeY - 46);
	const localDelta = localRate * dt;
	const convective = U * gradient;
	const convectiveDelta = convective * dt;
	const materialDelta = localDelta + convectiveDelta;
	const phiNow = gradient * (state.probe.x - 0.5);
	const phiFixedLater = phiNow + localDelta;
	const phiParticleLater = phiNow + materialDelta;
	const isEulerian = state.viewMode === "eulerian";

	for (let i = 0; i < 28; i += 1) {
		const x = left + (i / 28) * (right - left);
		const value = ((i + 0.5) / 28 - 0.5) * gradient;
		ctx.fillStyle = scalarColor(value);
		ctx.fillRect(x, top, (right - left) / 28 + 1, bottom - top);
	}

	ctx.strokeStyle = palette.border;
	ctx.lineWidth = 1;
	roundRect(ctx, left, top, right - left, bottom - top, 8);
	ctx.stroke();

	ctx.globalAlpha = 0.5;
	drawVectorField(ctx, left, right, top, bottom, 7, 3, palette.accent, (_x, y) => ({
		u: 0.28 + 0.18 * U,
		v: 0,
	}));
	ctx.globalAlpha = 1;

	ctx.strokeStyle = isEulerian ? palette.warning : palette.muted;
	ctx.lineWidth = isEulerian ? 3 : 1.5;
	ctx.setLineDash([6, 5]);
	ctx.beginPath();
	ctx.moveTo(probeX, probeY);
	ctx.lineTo(probeX, fixedPointY);
	ctx.stroke();
	ctx.setLineDash([]);

	ctx.fillStyle = palette.background;
	ctx.beginPath();
	ctx.arc(probeX, fixedPointY, 12, 0, Math.PI * 2);
	ctx.fill();
	ctx.strokeStyle = palette.warning;
	ctx.lineWidth = isEulerian ? 3 : 2;
	ctx.stroke();

	ctx.strokeStyle = palette.highlight;
	ctx.lineWidth = isEulerian ? 1.5 : 3;
	ctx.globalAlpha = isEulerian ? 0.32 : 1;
	ctx.beginPath();
	ctx.moveTo(probeX, probeY);
	ctx.lineTo(nextX, probeY);
	ctx.stroke();
	drawArrow(ctx, probeX, probeY, nextX, probeY, palette.highlight);
	ctx.globalAlpha = 1;

	ctx.fillStyle = palette.background;
	ctx.beginPath();
	ctx.arc(probeX, probeY, 18, 0, Math.PI * 2);
	ctx.fill();
	ctx.strokeStyle = palette.highlight;
	ctx.lineWidth = 3;
	ctx.stroke();

	ctx.fillStyle = palette.background;
	ctx.beginPath();
	ctx.arc(nextX, probeY, 14, 0, Math.PI * 2);
	ctx.fill();
	ctx.strokeStyle = palette.accent;
	ctx.lineWidth = isEulerian ? 1.5 : 3;
	ctx.globalAlpha = isEulerian ? 0.45 : 1;
	ctx.stroke();
	ctx.globalAlpha = 1;

	ctx.fillStyle = palette.text;
	ctx.font = "600 13px var(--font-interface), sans-serif";
	ctx.fillText(isEulerian ? "fixed observation point" : "particle now", Math.max(left + 4, probeX - 62), probeY - 24);
	ctx.fillText("same particle after dt", Math.min(nextX + 18, right - 154), probeY - 18);

	ctx.font = "12px var(--font-interface), sans-serif";
	ctx.fillStyle = palette.muted;
	ctx.fillText("fixed point after dt: only local change", Math.min(probeX + 18, right - 226), fixedPointY - 8);
	ctx.fillText(
		isEulerian
			? "Eulerian mode: watch a fixed point in the field"
			: "Lagrangian mode: compare values following the same moving particle",
		left + 4,
		top - 20
	);
	ctx.fillText(`φ now=${formatNumber(phiNow)} | fixed later=${formatNumber(phiFixedLater)} | particle later=${formatNumber(phiParticleLater)}`, left + 4, bottom + 24);

	drawTermBar(ctx, left, height - 68, 150, "local Δφ", localDelta, palette.warning);
	drawTermBar(ctx, left + 176, height - 68, 190, "move Δφ", convectiveDelta, palette.highlight);
	drawTermBar(ctx, left + 392, height - 68, 170, "total Δφ", materialDelta, palette.accent);

	ctx.fillStyle = palette.text;
	ctx.font = "600 13px var(--font-interface), sans-serif";
	ctx.fillText(
		isEulerian
			? "Eulerian view reads ∂φ/∂t at a fixed location"
			: "Lagrangian view follows the particle: Δφ = (∂φ/∂t)dt + U(∂φ/∂x)dt",
		left,
		height - 18
	);

	if (Math.abs(gradient) > 0.001) {
		const up = gradient > 0 ? "larger" : "smaller";
		ctx.fillStyle = palette.muted;
		ctx.font = "12px var(--font-interface), sans-serif";
		ctx.fillText(`Because dphi/dx is ${gradient > 0 ? "positive" : "negative"}, moving right meets ${up} phi.`, width - 330, height - 18);
	}
}

function drawTermBar(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	width: number,
	label: string,
	value: number,
	color: string
): void {
	const mid = x + width / 2;
	const scale = Math.min(width / 2 - 8, Math.abs(value) * 24);
	ctx.strokeStyle = getThemeColor("--background-modifier-border");
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.moveTo(x, y + 22);
	ctx.lineTo(x + width, y + 22);
	ctx.stroke();

	ctx.fillStyle = color;
	ctx.fillRect(value >= 0 ? mid : mid - scale, y + 14, Math.max(scale, 2), 16);
	ctx.fillStyle = getThemeColor("--text-normal");
	ctx.font = "12px var(--font-interface), sans-serif";
	ctx.fillText(`${label}: ${formatNumber(value)}`, x, y);
}

function drawControlVolumeScene(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	_config: FlowSceneConfig,
	state: FlowSceneState,
	palette: Record<string, string>
): void {
	const cv = { x: width * 0.32, y: height * 0.24, w: width * 0.36, h: height * 0.52 };
	ctx.strokeStyle = palette.highlight;
	ctx.lineWidth = 2;
	ctx.setLineDash([8, 6]);
	ctx.strokeRect(cv.x, cv.y, cv.w, cv.h);
	ctx.setLineDash([]);

	const inflow = finiteOrDefault(state.params.inflow, 1.1);
	const outflow = finiteOrDefault(state.params.outflow, 0.8);
	const storage = finiteOrDefault(state.params.storage, 0.25);

	for (let i = 0; i < 5; i += 1) {
		const y = cv.y + 30 + i * ((cv.h - 60) / 4);
		drawArrow(ctx, cv.x - 90, y, cv.x - 8, y, palette.accent, 2 + inflow);
		drawArrow(ctx, cv.x + cv.w + 8, y, cv.x + cv.w + 72 + 22 * outflow, y, palette.warning, 2 + outflow);
	}

	drawParticles(ctx, state.particles, (p) => 24 + p.x * (width - 48), (p) => height * 0.2 + p.y * height * 0.6, palette);

	ctx.fillStyle = palette.text;
	ctx.font = "13px var(--font-interface), sans-serif";
	ctx.fillText("fixed control volume", cv.x + 14, cv.y + 24);
	ctx.fillText(`storage cue: ${formatNumber(storage)}`, cv.x + 14, cv.y + cv.h - 16);
	ctx.fillText("RTT converts system balance into CV storage + surface flux", 44, height - 26);
}

function drawStreamlinePathlineScene(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	_config: FlowSceneConfig,
	state: FlowSceneState,
	palette: Record<string, string>
): void {
	const left = 46;
	const right = width - 46;
	const top = 54;
	const bottom = height - 54;

	for (let line = 0; line < 5; line += 1) {
		ctx.strokeStyle = line === 2 ? palette.highlight : palette.muted;
		ctx.lineWidth = line === 2 ? 2 : 1.2;
		ctx.beginPath();
		for (let i = 0; i <= 80; i += 1) {
			const x = left + (i / 80) * (right - left);
			const nx = i / 80;
			const yBase = top + ((line + 1) / 6) * (bottom - top);
			const y = yBase + 18 * Math.sin(2 * Math.PI * (nx + 0.18 * state.time)) * finiteOrDefault(state.params.unsteady, 0.9);
			if (i === 0) {
				ctx.moveTo(x, y);
			} else {
				ctx.lineTo(x, y);
			}
		}
		ctx.stroke();
	}

	ctx.strokeStyle = palette.warning;
	ctx.lineWidth = 2;
	ctx.beginPath();
	for (let i = 0; i <= 40; i += 1) {
		const age = i / 40;
		const x = left + age * (right - left) * 0.76;
		const y = top + (bottom - top) * (0.5 + 0.16 * Math.sin(7 * age - 1.4 * state.time));
		if (i === 0) {
			ctx.moveTo(x, y);
		} else {
			ctx.lineTo(x, y);
		}
	}
	ctx.stroke();

	drawParticles(ctx, state.particles, (p) => left + p.x * (right - left), (p) => top + p.y * (bottom - top), palette);

	ctx.fillStyle = palette.text;
	ctx.font = "13px var(--font-interface), sans-serif";
	ctx.fillText("blue: instantaneous streamlines", left, height - 34);
	ctx.fillStyle = palette.warning;
	ctx.fillText("orange: one particle pathline", left + 220, height - 34);
}

function drawBernoulliScene(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	config: FlowSceneConfig,
	state: FlowSceneState,
	palette: Record<string, string>
): void {
	const left = 48;
	const right = width - 48;
	const mid = height * 0.48;
	const scale = height * 0.24;
	const zRise = getBernoulliZRise(state.params);
	const elevationScale = height * 0.34;

	const centerY = (xNorm: number): number => mid - zRise * elevationScale * xNorm;

	ctx.strokeStyle = "rgba(120, 140, 160, 0.35)";
	ctx.lineWidth = 1;
	ctx.setLineDash([6, 6]);
	ctx.beginPath();
	ctx.moveTo(left, mid);
	ctx.lineTo(right, mid);
	ctx.stroke();
	ctx.setLineDash([]);

	ctx.fillStyle = "rgba(80, 150, 220, 0.12)";
	ctx.beginPath();
	for (let i = 0; i <= 80; i += 1) {
		const xNorm = i / 80;
		const x = left + xNorm * (right - left);
		const half = getBernoulliHalfHeight(state.params, xNorm) * scale;
		if (i === 0) {
			ctx.moveTo(x, centerY(xNorm) - half);
		} else {
			ctx.lineTo(x, centerY(xNorm) - half);
		}
	}
	for (let i = 80; i >= 0; i -= 1) {
		const xNorm = i / 80;
		const x = left + xNorm * (right - left);
		const half = getBernoulliHalfHeight(state.params, xNorm) * scale;
		ctx.lineTo(x, centerY(xNorm) + half);
	}
	ctx.closePath();
	ctx.fill();
	ctx.strokeStyle = palette.border;
	ctx.lineWidth = 2;
	ctx.stroke();

	ctx.strokeStyle = palette.highlight;
	ctx.lineWidth = 2;
	ctx.setLineDash([5, 5]);
	ctx.beginPath();
	for (let i = 0; i <= 80; i += 1) {
		const xNorm = i / 80;
		const x = left + xNorm * (right - left);
		if (i === 0) {
			ctx.moveTo(x, centerY(xNorm));
		} else {
			ctx.lineTo(x, centerY(xNorm));
		}
	}
	ctx.stroke();
	ctx.setLineDash([]);

	drawParticles(ctx, state.particles, (p) => left + p.x * (right - left), (p) => {
		const half = getBernoulliHalfHeight(state.params, p.x) * scale;
		return centerY(p.x) + (p.y - 0.5) * 2 * half * 0.82;
	}, palette);

	const outletY = centerY(1);
	drawArrow(ctx, right + 14, mid, right + 14, outletY, palette.highlight);
	ctx.fillStyle = palette.highlight;
	ctx.font = "11px var(--font-interface), sans-serif";
	ctx.fillText(zRise >= 0 ? "z rise" : "z drop", right - 52, outletY + (zRise >= 0 ? -8 : 16));

	const stations = [0.18, 0.5, 0.82];
	for (const xNorm of stations) {
		const x = left + xNorm * (right - left);
		const half = getBernoulliHalfHeight(state.params, xNorm);
		const speed = finiteOrDefault(state.params.flow, 1) / Math.max(half, 0.2);
		const velocityHead = 0.16 * speed * speed;
		const elevationHead = getBernoulliElevationHead(state.params, xNorm);
		const totalHead = 1.55;
		const pressureHead = Math.max(0.08, totalHead - velocityHead - elevationHead);
		drawHeadBars(ctx, x, height - 94, pressureHead, velocityHead, elevationHead, totalHead, palette);
	}

	ctx.fillStyle = palette.text;
	ctx.font = "13px var(--font-interface), sans-serif";
	ctx.fillText("z rise trades with pressure head; velocity head changes only when Q or area changes", left, height - 24);

	if (config.showProfile) {
		drawArrow(ctx, left + 20, mid, left + 110, mid, palette.accent);
	}
}

function drawPipe(
	ctx: CanvasRenderingContext2D,
	left: number,
	right: number,
	top: number,
	bottom: number,
	palette: Record<string, string>
): void {
	ctx.fillStyle = "rgba(80, 150, 220, 0.10)";
	ctx.fillRect(left, top, right - left, bottom - top);
	ctx.strokeStyle = palette.border;
	ctx.lineWidth = 3;
	ctx.beginPath();
	ctx.moveTo(left, top);
	ctx.lineTo(right, top);
	ctx.moveTo(left, bottom);
	ctx.lineTo(right, bottom);
	ctx.stroke();
	ctx.strokeStyle = palette.muted;
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.moveTo(left, (top + bottom) / 2);
	ctx.lineTo(right, (top + bottom) / 2);
	ctx.stroke();
}

function drawPoiseuilleProfile(
	ctx: CanvasRenderingContext2D,
	x0: number,
	y0: number,
	width: number,
	halfHeight: number,
	umax: number,
	palette: Record<string, string>
): void {
	ctx.strokeStyle = palette.muted;
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.moveTo(x0, y0 - halfHeight);
	ctx.lineTo(x0, y0 + halfHeight);
	ctx.stroke();

	ctx.strokeStyle = palette.highlight;
	ctx.lineWidth = 2;
	ctx.beginPath();
	for (let i = 0; i <= 80; i += 1) {
		const yNorm = -1 + (2 * i) / 80;
		const u = (1 - yNorm * yNorm) * Math.max(umax, 0.01);
		const x = x0 + (u / Math.max(umax, 0.01)) * width;
		const y = y0 + yNorm * halfHeight;
		if (i === 0) {
			ctx.moveTo(x, y);
		} else {
			ctx.lineTo(x, y);
		}
	}
	ctx.stroke();
	ctx.fillStyle = palette.text;
	ctx.font = "12px var(--font-interface), sans-serif";
	ctx.fillText("u(r)", x0 + 12, y0 - halfHeight - 12);
}

function drawParticles(
	ctx: CanvasRenderingContext2D,
	particles: FlowParticle[],
	xMap: (particle: FlowParticle) => number,
	yMap: (particle: FlowParticle) => number,
	palette: Record<string, string>
): void {
	for (const particle of particles) {
		const x = xMap(particle);
		const y = yMap(particle);
		const radius = 2.2 + 1.4 * particle.seed;
		ctx.fillStyle = particle.seed > 0.55 ? palette.particle : palette.particleAlt;
		ctx.beginPath();
		ctx.arc(x, y, radius, 0, Math.PI * 2);
		ctx.fill();
	}
}

function drawProbe(
	ctx: CanvasRenderingContext2D,
	width: number,
	height: number,
	state: FlowSceneState,
	palette: Record<string, string>
): void {
	const x = state.probe.x * width;
	const y = state.probe.y * height;

	ctx.save();
	ctx.strokeStyle = palette.highlight;
	ctx.fillStyle = palette.background;
	ctx.lineWidth = state.probe.dragging ? 3 : 2;
	ctx.beginPath();
	ctx.arc(x, y, 10, 0, Math.PI * 2);
	ctx.fill();
	ctx.stroke();

	ctx.beginPath();
	ctx.moveTo(x - 15, y);
	ctx.lineTo(x + 15, y);
	ctx.moveTo(x, y - 15);
	ctx.lineTo(x, y + 15);
	ctx.stroke();

	ctx.fillStyle = palette.text;
	ctx.font = "11px var(--font-interface), sans-serif";
	ctx.fillText("probe", x + 14, y - 12);
	ctx.restore();
}

function drawVectorField(
	ctx: CanvasRenderingContext2D,
	left: number,
	right: number,
	top: number,
	bottom: number,
	cols: number,
	rows: number,
	color: string,
	vector: (xNorm: number, yNorm: number) => { u: number; v: number }
): void {
	for (let row = 0; row < rows; row += 1) {
		for (let col = 0; col < cols; col += 1) {
			const xNorm = cols === 1 ? 0.5 : col / (cols - 1);
			const yNorm = rows === 1 ? 0.5 : row / (rows - 1);
			const x = left + xNorm * (right - left);
			const y = top + yNorm * (bottom - top);
			const v = vector(xNorm, yNorm);
			drawArrow(ctx, x - 10 * v.u, y - 10 * v.v, x + 34 * v.u, y + 34 * v.v, color, 1.5);
		}
	}
}

function drawArrow(
	ctx: CanvasRenderingContext2D,
	x1: number,
	y1: number,
	x2: number,
	y2: number,
	color: string,
	lineWidth = 2
): void {
	const angle = Math.atan2(y2 - y1, x2 - x1);
	const head = 8;
	ctx.strokeStyle = color;
	ctx.fillStyle = color;
	ctx.lineWidth = lineWidth;
	ctx.beginPath();
	ctx.moveTo(x1, y1);
	ctx.lineTo(x2, y2);
	ctx.stroke();
	ctx.beginPath();
	ctx.moveTo(x2, y2);
	ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6));
	ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6));
	ctx.closePath();
	ctx.fill();
}

function drawHeadBars(
	ctx: CanvasRenderingContext2D,
	x: number,
	baseline: number,
	pressureHead: number,
	velocityHead: number,
	elevationHead: number,
	totalHead: number,
	palette: Record<string, string>
): void {
	const scale = 58;
	const totalHeight = clamp(totalHead * scale, 24, 116);
	const available = Math.max(totalHead, 0.01);
	const zHeight = clamp((Math.max(elevationHead, 0) / available) * totalHeight, 3, totalHeight - 6);
	const vHeight = clamp((Math.max(velocityHead, 0) / available) * totalHeight, 3, totalHeight - zHeight - 3);
	const pHeight = Math.max(3, totalHeight - zHeight - vHeight);
	const barLeft = x - 13;
	const barWidth = 26;

	ctx.strokeStyle = palette.muted;
	ctx.lineWidth = 1;
	ctx.setLineDash([4, 4]);
	ctx.beginPath();
	ctx.moveTo(x - 24, baseline - totalHeight);
	ctx.lineTo(x + 34, baseline - totalHeight);
	ctx.stroke();
	ctx.setLineDash([]);

	ctx.strokeStyle = palette.border;
	ctx.strokeRect(barLeft, baseline - totalHeight, barWidth, totalHeight);

	ctx.fillStyle = palette.highlight;
	ctx.fillRect(barLeft, baseline - zHeight, barWidth, zHeight);
	ctx.fillStyle = palette.accent;
	ctx.fillRect(barLeft, baseline - zHeight - vHeight, barWidth, vHeight);
	ctx.fillStyle = palette.warning;
	ctx.fillRect(barLeft, baseline - totalHeight, barWidth, pHeight);

	ctx.fillStyle = palette.text;
	ctx.font = "10px var(--font-interface), sans-serif";
	ctx.fillText("z", barLeft + barWidth + 5, baseline - zHeight / 2 + 3);
	ctx.fillText("V", barLeft + barWidth + 5, baseline - zHeight - vHeight / 2 + 3);
	ctx.fillText("p", barLeft + barWidth + 5, baseline - totalHeight + pHeight / 2 + 3);
	ctx.fillText("head", x - 12, baseline + 14);
	ctx.fillStyle = palette.muted;
	ctx.fillText("H", x + 23, baseline - totalHeight + 3);
}

function getBernoulliHalfHeight(params: Record<string, number>, xNorm: number): number {
	const constriction = clamp(finiteOrDefault(params.constriction, 0.48), 0.12, 0.9);
	const throat = 1 - constriction * Math.exp(-Math.pow((xNorm - 0.5) / 0.18, 2));
	return clamp(throat, 0.16, 1.1);
}

function getBernoulliZRise(params: Record<string, number>): number {
	if (Number.isFinite(params.zRise)) {
		return params.zRise;
	}
	return finiteOrDefault(params.height, 0.25);
}

function getBernoulliElevationHead(params: Record<string, number>, xNorm: number): number {
	return 0.35 + 0.85 * getBernoulliZRise(params) * xNorm;
}

function scalarColor(value: number): string {
	const normalized = clamp(0.5 + value * 0.28, 0, 1);
	const r = Math.round(65 + normalized * 135);
	const g = Math.round(120 + (1 - Math.abs(normalized - 0.5) * 2) * 70);
	const b = Math.round(210 - normalized * 120);
	return `rgba(${r}, ${g}, ${b}, 0.25)`;
}

function renderFlowSceneEquation(container: HTMLElement, model: FlowSceneFormulaModel): void {
	container.empty();

	const equation = container.createDiv({ cls: "flow-scene-equation" });
	equation.createSpan({ cls: "flow-scene-equation-label", text: "governing idea" });
	equation.createSpan({ cls: "flow-scene-equation-math", text: model.equation });

	container.createDiv({ cls: "flow-scene-equation-interpretation", text: model.interpretation });
}

function renderFlowSceneTerms(container: HTMLElement, model: FlowSceneFormulaModel): void {
	container.empty();

	for (const term of model.terms) {
		const card = container.createDiv({
			cls: `flow-scene-term-card flow-scene-term-${term.tone ?? "neutral"}`,
		});
		const top = card.createDiv({ cls: "flow-scene-term-top" });
		top.createSpan({ cls: "flow-scene-term-label", text: term.label });
		top.createSpan({ cls: "flow-scene-term-value", text: term.value });
		card.createDiv({ cls: "flow-scene-term-symbol", text: term.symbol });
		card.createDiv({ cls: "flow-scene-term-meaning", text: term.meaning });
	}
}

function getFlowSceneFormulaModel(config: FlowSceneConfig, state: FlowSceneState): FlowSceneFormulaModel {
	const x = state.probe.x;
	const y = state.probe.y;
	const p = state.params;

	switch (config.type) {
		case "pipe-poiseuille": {
			const rOverR = clamp(Math.abs(2 * y - 1), 0, 1);
			const uRatio = 1 - rOverR * rOverR;
			const u = finiteOrDefault(p.umax, 2) * uRatio;
			return {
				equation: "u(r) = u_max [1 - (r/R)^2]",
				interpretation: "No-slip makes the wall velocity zero, while viscous momentum diffusion leaves the fastest fluid at the centerline.",
				probe: `probe: r/R=${formatNumber(rOverR)} | u/umax=${formatNumber(uRatio)} | u=${formatNumber(u)}`,
				terms: [
					{
						label: "radial position",
						symbol: "r/R",
						value: formatNumber(rOverR),
						meaning: "0 is centerline, 1 is wall.",
						tone: "neutral",
					},
					{
						label: "local speed fraction",
						symbol: "u/u_max",
						value: formatNumber(uRatio),
						meaning: "Velocity drops quadratically toward the wall.",
						tone: "convective",
					},
					{
						label: "local velocity",
						symbol: "u",
						value: formatNumber(u),
						meaning: "Speed experienced by the probe point.",
						tone: "total",
					},
				],
			};
		}
		case "material-derivative": {
			const local = finiteOrDefault(p.oscillation, 0.6);
			const convective = finiteOrDefault(p.U, 1.2) * finiteOrDefault(p.gradient, 0.8);
			const material = local + convective;
			const modeLabel = state.viewMode === "eulerian" ? "Eulerian fixed-point view" : "Lagrangian particle-following view";
			return {
				equation:
					state.viewMode === "eulerian"
						? "Eulerian: ∂φ/∂t at fixed x"
						: "Lagrangian: Dφ/Dt = ∂φ/∂t + V · ∇φ",
				interpretation:
					state.viewMode === "eulerian"
						? "Stay at one spatial point and watch the field value change there. This is only the local term, not the full material derivative."
						: "Follow the same fluid particle. Its value changes because the field changes locally and because the particle moves into a different part of the field.",
				probe: `${modeLabel} | x=${formatNumber(x)} | ∂φ/∂t=${formatNumber(local)} | V·∇φ=${formatNumber(convective)} | Dφ/Dt=${formatNumber(material)}`,
				terms: [
					{
						label: "Eulerian local term",
						symbol: "∂φ/∂t",
						value: formatNumber(local),
						meaning: "What changes at the fixed point where the probe sits.",
						tone: "local",
					},
					{
						label: "motion through field",
						symbol: "V · ∇φ",
						value: formatNumber(convective),
						meaning: "Extra change caused by following a particle into neighboring values.",
						tone: "convective",
					},
					{
						label: "Lagrangian particle rate",
						symbol: "Dφ/Dt",
						value: formatNumber(material),
						meaning: "The rate experienced by the same moving fluid particle.",
						tone: "total",
					},
				],
			};
		}
		case "control-volume-flux": {
			const inflow = finiteOrDefault(p.inflow, 1.1);
			const outflow = finiteOrDefault(p.outflow, 0.8);
			const storage = finiteOrDefault(p.storage, 0.25);
			const netOut = outflow - inflow;
			return {
				equation: "dB_CV/dt = B_in - B_out + source",
				interpretation: "A fixed control volume changes because material is stored inside or crosses the control surface.",
				probe: `probe: x=${formatNumber(x)} | inflow=${formatNumber(inflow)} | outflow=${formatNumber(outflow)} | net out=${formatNumber(netOut)} | storage cue=${formatNumber(storage)}`,
				terms: [
					{
						label: "inflow",
						symbol: "Σṁ_in",
						value: formatNumber(inflow),
						meaning: "Amount entering through the control surface.",
						tone: "local",
					},
					{
						label: "outflow",
						symbol: "Σṁ_out",
						value: formatNumber(outflow),
						meaning: "Amount leaving through the control surface.",
						tone: "loss",
					},
					{
						label: "storage cue",
						symbol: "d/dt ∫CV ρ dV",
						value: formatNumber(storage),
						meaning: "Accumulation inside the fixed volume.",
						tone: "total",
					},
				],
			};
		}
		case "streamline-pathline-streakline": {
			const particle = { x, y, seed: 0.5, age: 0 };
			const velocity = getParticleVelocity(config, state, particle);
			return {
				equation: "dx_p/dt = V(x_p,t)",
				interpretation: "A streamline is an instant direction field; a pathline is the history of one moving particle. They differ when the field is unsteady.",
				probe: `probe: x=${formatNumber(x)}, y=${formatNumber(y)} | local velocity u=${formatNumber(velocity.u)} | v=${formatNumber(velocity.v)}`,
				terms: [
					{
						label: "streamline",
						symbol: "V tangent now",
						value: "instant",
						meaning: "Direction field at this moment.",
						tone: "local",
					},
					{
						label: "pathline",
						symbol: "x_p(t)",
						value: "history",
						meaning: "Where one marked particle has moved.",
						tone: "convective",
					},
					{
						label: "probe velocity",
						symbol: "(u, v)",
						value: `${formatNumber(velocity.u)}, ${formatNumber(velocity.v)}`,
						meaning: "Local velocity that would carry a particle from the probe.",
						tone: "total",
					},
				],
			};
		}
		case "bernoulli-streamtube": {
			const half = getBernoulliHalfHeight(p, x);
			const speed = finiteOrDefault(p.flow, 1) / Math.max(half, 0.2);
			const velocityHead = 0.16 * speed * speed;
			const elevationHead = getBernoulliElevationHead(p, x);
			const totalHead = 1.55;
			const pressureHead = Math.max(0.08, totalHead - velocityHead - elevationHead);
			return {
				equation: "p/(ρg) + V²/(2g) + z = constant",
				interpretation: "Along an ideal streamtube, pressure head, velocity head, and elevation head share one total head budget.",
				probe: `probe: x=${formatNumber(x)} | p head=${formatNumber(pressureHead)} | V head=${formatNumber(velocityHead)} | z head=${formatNumber(elevationHead)} | H=${formatNumber(totalHead)}`,
				terms: [
					{
						label: "pressure head",
						symbol: "p/(ρg)",
						value: formatNumber(pressureHead),
						meaning: "Static pressure part left after velocity and elevation take their share.",
						tone: "local",
					},
					{
						label: "velocity head",
						symbol: "V²/(2g)",
						value: formatNumber(velocityHead),
						meaning: "Kinetic part of mechanical energy.",
						tone: "convective",
					},
					{
						label: "elevation head",
						symbol: "z",
						value: formatNumber(elevationHead),
						meaning: "Height term that also consumes or returns head.",
						tone: "total",
					},
				],
			};
		}
		default:
			return {
				equation: "probe reads local field values",
				interpretation: "Move the probe to inspect how the local physical interpretation changes.",
				probe: `probe: x=${formatNumber(x)}, y=${formatNumber(y)}`,
				terms: [],
			};
	}
}

function getFlowPalette(): Record<string, string> {
	return {
		background: getThemeColor("--background-primary"),
		border: getThemeColor("--background-modifier-border"),
		text: getThemeColor("--text-normal"),
		muted: getThemeColor("--text-muted"),
		accent: getThemeColor("--interactive-accent"),
		highlight: "#3aaed8",
		warning: "#d88c3a",
		particle: "#4fb3d8",
		particleAlt: "#f0a84d",
	};
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
	const radius = Math.min(r, w / 2, h / 2);
	ctx.beginPath();
	ctx.moveTo(x + radius, y);
	ctx.arcTo(x + w, y, x + w, y + h, radius);
	ctx.arcTo(x + w, y + h, x, y + h, radius);
	ctx.arcTo(x, y + h, x, y, radius);
	ctx.arcTo(x, y, x + w, y, radius);
	ctx.closePath();
}

function parsePitotVelocityConfig(source: string): PitotVelocityConfig {
	if (!source.trim()) {
		return getDefaultPitotVelocityConfig();
	}

	let parsed: unknown;

	try {
		parsed = parseYaml(source);
	} catch (error) {
		throw new Error(`YAML parsing failed: ${getErrorMessage(error)}`);
	}

	if (!parsed || typeof parsed !== "object") {
		throw new Error("Pitot velocity block must contain a YAML object.");
	}

	const raw = parsed as Record<string, unknown>;
	const unit = String(raw.unit ?? "MPa");

	if (!isPressureUnit(unit)) {
		throw new Error("unit must be one of Pa, kPa, bar, MPa.");
	}

	return {
		p0: finiteOrDefault(raw.p0, 20.010),
		pstatic: finiteOrDefault(raw.pstatic, 20.000),
		unit,
		rho: finiteOrDefault(raw.rho, 220),
		mdotJet: optionalNumber(raw.mdotJet),
		diameterJet: optionalNumber(raw.diameterJet),
		rhoJet: optionalNumber(raw.rhoJet),
	};
}

function getDefaultPitotVelocityConfig(): PitotVelocityConfig {
	return {
		p0: 20.010,
		pstatic: 20.000,
		unit: "MPa",
		rho: 220,
	};
}

function renderPitotVelocityCalculator(el: HTMLElement, config: PitotVelocityConfig): void {
	el.empty();

	const controlIdPrefix = `pitot-velocity-${Math.random().toString(36).slice(2)}`;
	const card = el.createDiv({ cls: "pitot-card" });
	const header = card.createDiv({ cls: "pitot-header" });
	const titleWrap = header.createDiv();
	titleWrap.createEl("h4", { text: "Pitot Differential Pressure Velocity Calculator" });
	titleWrap.createDiv({ cls: "pitot-subtitle", text: "N2 crossflow velocity estimator" });
	header.createSpan({ cls: "formulalab-mode", text: "N2 Pitot" });

	const body = card.createDiv({ cls: "pitot-grid" });
	const inputPanel = body.createDiv({ cls: "pitot-panel" });
	inputPanel.createEl("h5", { text: "Inputs" });
	const p0Input = createNumberInput(inputPanel, `${controlIdPrefix}-p0`, "Total Pressure P0", config.p0, "0.001");
	const pstaticInput = createNumberInput(
		inputPanel,
		`${controlIdPrefix}-pstatic`,
		"Static Pressure Pstatic",
		config.pstatic,
		"0.001"
	);
	const unitSelect = createPressureUnitSelect(inputPanel, `${controlIdPrefix}-unit`, config.unit);
	const rhoInput = createNumberInput(
		inputPanel,
		`${controlIdPrefix}-rho`,
		"Nitrogen Density rho [kg/m^3]",
		config.rho,
		"0.1"
	);
	const calculateButton = inputPanel.createEl("button", {
		cls: "pitot-button",
		text: "Calculate",
		type: "button",
	});
	inputPanel.createDiv({
		cls: "pitot-message pitot-warn",
		text:
			"고압 질소는 이상기체 거동에서 벗어날 수 있습니다. 정확한 밀도는 온도, 압력, 압축성계수 Z 또는 REFPROP/NIST 등 실제 물성값으로 보정하세요.",
	});
	inputPanel.createDiv({
		cls: "pitot-formula",
		text: "Delta P = P0 - Pstatic\nU = sqrt(2 Delta P / rho)",
	});

	const resultPanel = body.createDiv({ cls: "pitot-panel" });
	resultPanel.createEl("h5", { text: "Results" });
	const deltaPResult = createResultRow(resultPanel, "Delta P [Pa]");
	const velocityResult = createResultRow(resultPanel, "Velocity U [m/s]");
	const dynamicPressureResult = createResultRow(resultPanel, "Dynamic Pressure q [Pa]");
	const rhoResult = createResultRow(resultPanel, "Used Density rho [kg/m^3]");
	const momentumRatioResult = createResultRow(resultPanel, "Momentum Ratio J");
	resultPanel.createDiv({
		cls: "pitot-message pitot-info",
		text: "Momentum ratio 계산용 메모: crossflow 속도 Uc는 위 Pitot 계산 결과를 사용합니다.",
	});
	const statusMessage = resultPanel.createDiv({ cls: "pitot-message pitot-info", text: "Ready" });

	const jetPanel = card.createDiv({ cls: "pitot-panel pitot-optional" });
	jetPanel.createEl("h5", { text: "Optional Jet Momentum Ratio Inputs" });
	const jetGrid = jetPanel.createDiv({ cls: "pitot-grid" });
	const mdotJetInput = createNumberInput(
		jetGrid,
		`${controlIdPrefix}-mdot`,
		"jet mass flow rate mdot_j [g/s]",
		config.mdotJet,
		"0.001",
		"optional"
	);
	const diameterJetInput = createNumberInput(
		jetGrid,
		`${controlIdPrefix}-diameter`,
		"jet diameter d_j [mm]",
		config.diameterJet,
		"0.001",
		"optional"
	);
	const rhoJetInput = createNumberInput(
		jetGrid,
		`${controlIdPrefix}-rho-jet`,
		"jet density rho_j [kg/m^3]",
		config.rhoJet,
		"0.1",
		"optional"
	);
	const jetVelocityRow = jetGrid.createDiv({ cls: "pitot-field" });
	jetVelocityRow.createEl("label", { text: "Jet Velocity U_j [m/s]" });
	const jetVelocityResult = jetVelocityRow.createDiv({ cls: "pitot-inline-result", text: "-" });
	jetPanel.createDiv({
		cls: "pitot-formula",
		text: "A_j = pi d_j^2 / 4\nU_j = mdot_j / (rho_j A_j)\nJ = rho_j U_j^2 / (rho_c U_c^2)",
	});

	const notes = card.createDiv({ cls: "pitot-notes" });
	notes.createEl("h5", { text: "Experimental Notes" });
	const list = notes.createEl("ul");
	[
		"Pitot line이 길면 고주파 압력 변동은 신뢰하지 말고 시간 평균값만 사용하세요.",
		"A-10 같은 bar급 압력센서는 동압 해상도가 부족할 수 있습니다.",
		"20 MPa 질소는 이상기체 오차가 클 수 있으므로 최종 논문화 전에는 실제 물성값으로 rho를 보정하세요.",
		"본 계산기는 preliminary crossflow velocity estimation 용도입니다.",
	].forEach((note) => list.createEl("li", { text: note }));

	function updateVelocityResults(status: PitotVelocityStatus): void {
		deltaPResult.setText(formatEngineeringNumber(status.deltaP, 4));
		velocityResult.setText(formatEngineeringNumber(status.velocity, 4));
		dynamicPressureResult.setText(formatEngineeringNumber(status.dynamicPressure, 4));
		rhoResult.setText(Number.isFinite(status.rho) ? formatEngineeringNumber(status.rho, 4) : "-");
		statusMessage.setText(status.message);
		statusMessage.removeClasses(["pitot-info", "pitot-warn", "pitot-error"]);

		if (status.ok) {
			statusMessage.addClass("pitot-info");
		} else if (status.message === "전압은 정압보다 커야 합니다.") {
			statusMessage.addClass("pitot-warn");
		} else {
			statusMessage.addClass("pitot-error");
		}
	}

	function calculateVelocity(): PitotVelocityStatus {
		const p0Pa = convertPressureToPa(p0Input.value, unitSelect.value);
		const pstaticPa = convertPressureToPa(pstaticInput.value, unitSelect.value);
		const rho = Number(rhoInput.value);
		const status: PitotVelocityStatus = {
			ok: false,
			message: "",
			deltaP: Number.NaN,
			velocity: Number.NaN,
			dynamicPressure: Number.NaN,
			rho,
		};

		if (!Number.isFinite(p0Pa) || !Number.isFinite(pstaticPa)) {
			status.message = "압력 입력값을 확인하세요.";
			updateVelocityResults(status);
			return status;
		}

		if (!Number.isFinite(rho) || rho <= 0) {
			status.message = "밀도 rho는 0보다 큰 숫자여야 합니다.";
			updateVelocityResults(status);
			return status;
		}

		const deltaP = p0Pa - pstaticPa;

		if (deltaP <= 0) {
			status.message = "전압은 정압보다 커야 합니다.";
			status.deltaP = deltaP;
			updateVelocityResults(status);
			return status;
		}

		const velocity = Math.sqrt((2 * deltaP) / rho);
		const dynamicPressure = 0.5 * rho * velocity * velocity;

		status.ok = true;
		status.message = "Calculation complete";
		status.deltaP = deltaP;
		status.velocity = velocity;
		status.dynamicPressure = dynamicPressure;
		updateVelocityResults(status);
		return status;
	}

	function calculateMomentumRatio(velocityStatus: PitotVelocityStatus): void {
		const mdotInput = mdotJetInput.value;
		const diameterInput = diameterJetInput.value;
		const rhoJetValue = rhoJetInput.value;

		if (mdotInput === "" && diameterInput === "" && rhoJetValue === "") {
			momentumRatioResult.setText("Jet inputs not provided");
			jetVelocityResult.setText("-");
			return;
		}

		if (mdotInput === "" || diameterInput === "" || rhoJetValue === "") {
			momentumRatioResult.setText("Complete all jet inputs");
			jetVelocityResult.setText("-");
			return;
		}

		if (!velocityStatus.ok) {
			momentumRatioResult.setText("Crossflow velocity unavailable");
			jetVelocityResult.setText("-");
			return;
		}

		const mdotKgS = Number(mdotInput) / 1000;
		const diameterM = Number(diameterInput) / 1000;
		const rhoJet = Number(rhoJetValue);

		if (
			!Number.isFinite(mdotKgS) ||
			!Number.isFinite(diameterM) ||
			!Number.isFinite(rhoJet) ||
			mdotKgS <= 0 ||
			diameterM <= 0 ||
			rhoJet <= 0
		) {
			momentumRatioResult.setText("Invalid jet input");
			jetVelocityResult.setText("-");
			return;
		}

		const areaJet = Math.PI * diameterM * diameterM / 4;
		const velocityJet = mdotKgS / (rhoJet * areaJet);
		const momentumRatio = (rhoJet * velocityJet * velocityJet) /
			(velocityStatus.rho * velocityStatus.velocity * velocityStatus.velocity);

		jetVelocityResult.setText(formatEngineeringNumber(velocityJet, 4));
		momentumRatioResult.setText(formatEngineeringNumber(momentumRatio, 4));
	}

	function updateAll(): void {
		const velocityStatus = calculateVelocity();
		calculateMomentumRatio(velocityStatus);
	}

	[p0Input, pstaticInput, unitSelect, rhoInput, mdotJetInput, diameterJetInput, rhoJetInput].forEach((input) => {
		input.addEventListener("input", updateAll);
		input.addEventListener("change", updateAll);
	});
	calculateButton.addEventListener("click", updateAll);
	updateAll();
}

function createNumberInput(
	container: HTMLElement,
	id: string,
	labelText: string,
	value: number | undefined,
	step: string,
	placeholder?: string
): HTMLInputElement {
	const field = container.createDiv({ cls: "pitot-field" });
	field.createEl("label", { text: labelText, attr: { for: id } });
	const input = field.createEl("input", {
		type: "number",
		attr: {
			id,
			step,
			inputmode: "decimal",
			"aria-label": labelText,
		},
	});

	if (Number.isFinite(value)) {
		input.value = String(value);
	}

	if (placeholder) {
		input.placeholder = placeholder;
	}

	return input;
}

function createPressureUnitSelect(container: HTMLElement, id: string, selectedUnit: PressureUnit): HTMLSelectElement {
	const field = container.createDiv({ cls: "pitot-field" });
	field.createEl("label", { text: "Pressure Unit", attr: { for: id } });
	const select = field.createEl("select", { attr: { id, "aria-label": "Pressure Unit" } });

	for (const unit of PRESSURE_UNITS) {
		const option = select.createEl("option", { text: unit, value: unit });
		option.selected = unit === selectedUnit;
	}

	return select;
}

function createResultRow(container: HTMLElement, label: string): HTMLElement {
	const row = container.createDiv({ cls: "pitot-result-row" });
	row.createDiv({ cls: "pitot-result-label", text: label });
	return row.createDiv({ cls: "pitot-result-value", text: "-" });
}

function convertPressureToPa(value: string | number, unit: string): number {
	const number = Number(value);

	if (!Number.isFinite(number)) {
		return Number.NaN;
	}

	switch (unit) {
		case "Pa":
			return number;
		case "kPa":
			return number * 1000;
		case "bar":
			return number * 100000;
		case "MPa":
			return number * 1000000;
		default:
			return Number.NaN;
	}
}

function createSlider(
	container: HTMLElement,
	options: { id: string; label: string; value: number; min: number; max: number; step: number }
): SliderElements {
	const row = container.createDiv({ cls: "formulalab-slider-row" });
	const label = row.createEl("label", { cls: "formulalab-slider-label", attr: { for: options.id } });
	label.createSpan({ text: options.label });
	const value = label.createSpan({ cls: "formulalab-slider-value", text: formatNumber(options.value) });

	const input = row.createEl("input", {
		cls: "formulalab-slider",
		type: "range",
		attr: {
			id: options.id,
			min: String(options.min),
			max: String(options.max),
			step: String(options.step),
			value: String(options.value),
			"aria-label": options.label,
		},
	});

	return { input, value };
}

function renderError(el: HTMLElement, message: string): void {
	el.empty();
	const card = el.createDiv({ cls: "formulalab-card formulalab-error-card" });
	card.createEl("strong", { text: "FormulaLab error" });
	card.createEl("pre", { text: message });
}

function getAutoStep(min: number, max: number): number {
	return Math.abs(max - min) / 1000;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

function formatNumber(value: number): string {
	if (!Number.isFinite(value)) {
		return "NaN";
	}

	if (value === 0) {
		return "0";
	}

	const absolute = Math.abs(value);
	if (absolute >= 10000 || absolute < 0.001) {
		return value.toExponential(4);
	}

	return Number(value.toPrecision(6)).toString();
}

function formatEngineeringNumber(value: number, digits: number): string {
	if (!Number.isFinite(value)) {
		return "-";
	}

	if ((Math.abs(value) >= 100000 || Math.abs(value) < 0.001) && value !== 0) {
		return value.toExponential(digits);
	}

	return value.toLocaleString(undefined, {
		maximumFractionDigits: digits,
		minimumFractionDigits: 0,
	});
}

function getThemeColor(variableName: string): string {
	return getComputedStyle(document.body).getPropertyValue(variableName).trim() || "rgba(127,127,127,0.25)";
}

function toNumber(value: unknown): number {
	if (typeof value === "number") {
		return value;
	}

	if (typeof value === "string" && value.trim() !== "") {
		return Number(value);
	}

	return Number.NaN;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	const number = toNumber(value);
	return Number.isFinite(number) ? number : undefined;
}

function finiteOrDefault(value: unknown, defaultValue: number): number {
	const number = toNumber(value);
	return Number.isFinite(number) ? number : defaultValue;
}

function isPressureUnit(value: string): value is PressureUnit {
	return PRESSURE_UNITS.includes(value as PressureUnit);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
