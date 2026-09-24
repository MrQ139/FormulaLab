import { finishRenderMath, MarkdownPostProcessorContext, Plugin, renderMath } from "obsidian";
import { parse as parseYaml } from "yaml";
import { parseCfdCellsConfig, renderCfdCells } from "./src/views/cfdCells";
import { parseFlowSceneConfig, renderFlowScene } from "./src/views/flowScene";
import { MathModule, parseFormulaLabConfig, renderFormulaLab, validateConfig } from "./src/views/formulaLab";
import { parseNs2DConfig, renderNs2D } from "./src/views/ns2dView";
import { finiteOrDefault, getErrorMessage, renderError, setMathRenderer, toNumber } from "./src/ui";

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

const PRESSURE_UNITS: PressureUnit[] = ["Pa", "kPa", "bar", "MPa"];

let mathModule: Promise<MathModule> | null = null;
// mathjs builds its whole function table on import; defer that to the first formulalab block so Obsidian starts fast.
const loadMath = (): Promise<MathModule> => (mathModule ??= import("mathjs"));

export default class FormulaLabPlugin extends Plugin {
	async onload() {
		setMathRenderer(renderMath, finishRenderMath);

		this.registerMarkdownCodeBlockProcessor(
			"formulalab",
			async (source: string, el: HTMLElement, _ctx: MarkdownPostProcessorContext) => {
				try {
					const config = parseFormulaLabConfig(source);
					const math = await loadMath();
					const errors = validateConfig(config, math);

					if (errors.length > 0) {
						renderError(el, errors.join("\n"));
						return;
					}

					renderFormulaLab(el, config, math);
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
		this.registerMarkdownCodeBlockProcessor("cfd-cells", (source: string, el: HTMLElement) => {
			try {
				renderCfdCells(el, parseCfdCellsConfig(source));
			} catch (error) {
				renderError(el, getErrorMessage(error));
			}
		});
		this.registerMarkdownCodeBlockProcessor("ns2d", (source: string, el: HTMLElement) => {
			try {
				renderNs2D(el, parseNs2DConfig(source));
			} catch (error) {
				renderError(el, getErrorMessage(error));
			}
		});
	}
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

function optionalNumber(value: unknown): number | undefined {
	const number = toNumber(value);
	return Number.isFinite(number) ? number : undefined;
}

function isPressureUnit(value: string): value is PressureUnit {
	return PRESSURE_UNITS.includes(value as PressureUnit);
}
