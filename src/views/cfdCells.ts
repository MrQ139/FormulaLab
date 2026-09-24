import { parse as parseYaml } from "yaml";
import {
	AdvectionScheme, advectStep, Boundary, Diffusion2D, exactConvectionDiffusion, FvmScheme, IterativeMethod,
	pulse, PulseShape, solveConvectionDiffusion,
} from "../solvers/fvm";
import {
	animationLoop, bindSlider, loadPlotly, createButton, createSelect, finiteOrDefault, fitCanvas, formatNumber, getThemeColor,
	isRecord, optionalString, rgb, sequentialColor,
} from "../ui";

type CellsType = "convection-diffusion" | "advection" | "diffusion-2d";

export interface CfdCellsConfig {
	type: CellsType;
	title?: string;
	scheme: string;
	cells: number;
	velocity: number;
	diffusivity: number;
	phiLeft: number;
	phiRight: number;
	courant: number;
	shape: PulseShape;
	left: Boundary;
	right: Boundary;
	top: Boundary;
	bottom: Boundary;
	source: number;
	omega: number;
}

const FVM_SCHEMES: Array<[FvmScheme, string]> = [["central", "중심 차분 (central)"], ["upwind", "상류 (upwind)"], ["hybrid", "하이브리드 (hybrid)"], ["power-law", "멱법칙 (power-law)"]];
const ADVECTION_SCHEMES: Array<[AdvectionScheme, string]> = [["upwind", "상류 (upwind)"], ["lax-wendroff", "Lax–Wendroff"], ["lax-friedrichs", "Lax–Friedrichs"], ["ftcs", "FTCS (중심·전진)"]];
const METHODS: Array<[IterativeMethod, string]> = [["jacobi", "Jacobi"], ["gauss-seidel", "Gauss–Seidel"], ["sor", "SOR"]];

const ADVECTION_NOTES: Record<AdvectionScheme, string> = {
	"upwind": "1차 정확도. C ≤ 1이면 안정하지만 수치 확산 때문에 모서리가 뭉개진다. C = 1이면 정확히 한 셀씩 이동한다.",
	"lax-wendroff": "2차 정확도. 매끈한 파형은 잘 보존하지만 불연속 근처에서 진동(분산 오차)이 생긴다.",
	"lax-friedrichs": "안정하지만 매우 확산적이다. 이웃 평균을 쓰기 때문에 파형이 빠르게 퍼진다.",
	"ftcs": "시간 전진·공간 중심 차분은 C와 상관없이 무조건 불안정하다. 오차가 스텝마다 증폭된다.",
};

export function parseCfdCellsConfig(source: string): CfdCellsConfig {
	const raw = source.trim() ? parseYaml(source) : {};
	if (!isRecord(raw)) throw new Error("cfd-cells 블록은 YAML 객체여야 합니다.");
	const type = String(raw.type ?? "convection-diffusion");
	if (type !== "convection-diffusion" && type !== "advection" && type !== "diffusion-2d") {
		throw new Error("type은 convection-diffusion, advection, diffusion-2d 중 하나여야 합니다.");
	}
	const boundary = (value: unknown, fallback: Boundary): Boundary =>
		value === "insulated" || value === "단열" ? "insulated" : finiteOrDefault(value, fallback as number);
	const defaults = type === "convection-diffusion" ? { scheme: "central", cells: 5 } : type === "advection" ? { scheme: "upwind", cells: 80 } : { scheme: "gauss-seidel", cells: 8 };
	return {
		type,
		title: optionalString(raw.title),
		scheme: String(raw.scheme ?? raw.method ?? defaults.scheme),
		cells: Math.round(finiteOrDefault(raw.cells, defaults.cells)),
		velocity: finiteOrDefault(raw.velocity, 0.1),
		diffusivity: finiteOrDefault(raw.diffusivity, 0.1),
		phiLeft: finiteOrDefault(raw.phi_left, 1),
		phiRight: finiteOrDefault(raw.phi_right, 0),
		courant: finiteOrDefault(raw.courant, 0.8),
		shape: raw.shape === "gauss" ? "gauss" : "square",
		left: boundary(raw.left, 100),
		right: boundary(raw.right, 0),
		top: boundary(raw.top, "insulated"),
		bottom: boundary(raw.bottom, "insulated"),
		source: finiteOrDefault(raw.source, 0),
		omega: finiteOrDefault(raw.omega, 1.5),
	};
}

export function renderCfdCells(el: HTMLElement, config: CfdCellsConfig): void {
	el.empty();
	const card = el.createDiv({ cls: "formulalab-card cfd-cells-card" });
	const header = card.createDiv({ cls: "formulalab-header" });
	const titles: Record<CellsType, string> = {
		"convection-diffusion": "셀로 보는 1D 대류–확산 (유한체적법)",
		"advection": "셀로 보는 1D 이류: 수치 확산과 CFL 조건",
		"diffusion-2d": "셀로 보는 2D 열전도: 반복법 수렴",
	};
	header.createEl("h4", { text: config.title ?? titles[config.type] });
	header.createSpan({ cls: "formulalab-mode", text: "cfd cells" });
	const id = `cfd-cells-${Math.random().toString(36).slice(2)}`;
	if (config.type === "convection-diffusion") renderConvectionDiffusion(card, config, id);
	else if (config.type === "advection") renderAdvection(card, config, id);
	else renderDiffusion2D(card, config, id);
}

function textColorFor([r, g, b]: [number, number, number]): string {
	return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? "#111" : "#fff";
}

function renderConvectionDiffusion(card: HTMLElement, config: CfdCellsConfig, id: string): void {
	const state = {
		n: Math.min(Math.max(config.cells, 2), 40),
		u: config.velocity,
		gamma: config.diffusivity,
		scheme: (FVM_SCHEMES.some(([s]) => s === config.scheme) ? config.scheme : "central") as FvmScheme,
		selected: 0,
	};
	state.selected = Math.min(2, state.n - 1);
	card.createDiv({ cls: "formulalab-formula", text: "d(ρuφ)/dx = d/dx(Γ dφ/dx)   →   각 셀:  a_P φ_P = a_W φ_W + a_E φ_E + S_u" });
	const controls = card.createDiv({ cls: "formulalab-controls" });
	bindSlider(controls, `${id}-n`, "셀 수 N", { value: state.n, min: 2, max: 40, step: 1 }, v => { state.n = v; state.selected = Math.min(state.selected, v - 1); update(); });
	bindSlider(controls, `${id}-u`, "속도 u", { value: state.u, min: -3, max: 3, step: 0.05 }, v => { state.u = v; update(); });
	bindSlider(controls, `${id}-g`, "확산계수 Γ", { value: state.gamma, min: 0.01, max: 1, step: 0.01 }, v => { state.gamma = v; update(); });
	createSelect(controls, "스킴", FVM_SCHEMES, state.scheme, v => { state.scheme = v; update(); });
	const metrics = card.createDiv({ cls: "cfd-metrics" });
	const canvasWrap = card.createDiv({ cls: "cfd-canvas-wrap" });
	const canvas = canvasWrap.createEl("canvas", { cls: "cfd-canvas", attr: { "aria-label": "finite volume cells" } });
	card.createDiv({ cls: "cfd-hint", text: "셀을 누르면 그 셀의 이산 방정식을 숫자로 보여 줍니다." });
	const equation = card.createDiv({ cls: "cfd-equation" });
	const plot = card.createDiv({ cls: "formulalab-plot" });
	let layout = { cellWidth: 0, left: 0 };
	canvas.addEventListener("pointerdown", event => {
		const rect = canvas.getBoundingClientRect(), x = event.clientX - rect.left;
		const k = Math.floor((x - layout.left) / layout.cellWidth);
		if (k >= 0 && k < state.n) { state.selected = k; update(); }
	});
	new ResizeObserver(() => { if (card.isConnected) update(); }).observe(canvasWrap);

	function update(): void {
		const setup ={ n: state.n, length: 1, rho: 1, u: state.u, gamma: state.gamma, phiA: config.phiLeft, phiB: config.phiRight, scheme: state.scheme };
		const result = solveConvectionDiffusion(setup);
		const values = result.cells.map(c => c.phi);
		const lo = Math.min(config.phiLeft, config.phiRight, ...values), hi = Math.max(config.phiLeft, config.phiRight, ...values);

		metrics.empty();
		const metric = (label: string, value: string, warn = false) => {
			const item = metrics.createDiv({ cls: `cfd-metric${warn ? " is-warning" : ""}` });
			item.createSpan({ cls: "cfd-metric-label", text: label });
			item.createSpan({ cls: "cfd-metric-value", text: value });
		};
		metric("대류 F = ρu", formatNumber(result.flux));
		metric("확산 D = Γ/Δx", formatNumber(result.conductance));
		metric("셀 Péclet = F/D", formatNumber(result.cellPeclet), state.scheme === "central" && Math.abs(result.cellPeclet) > 2);
		metric("최대 오차 (정확해 대비)", formatNumber(result.maxError), result.maxError > 0.05);

		const { ctx, width, height } = fitCanvas(canvas, 118);
		const pad = 36, cellWidth = (width - 2 * pad) / state.n, top = 34, boxH = 50;
		layout = { cellWidth, left: pad };
		ctx.clearRect(0, 0, width, height);
		ctx.font = "12px var(--font-interface, sans-serif)";
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		const textColor = getThemeColor("--text-normal"), muted = getThemeColor("--text-muted"), accent = getThemeColor("--interactive-accent");
		const scale = (v: number) => (hi - lo < 1e-12 ? 0.5 : (v - lo) / (hi - lo));
		for (const [x, v, label] of [[pad / 2, config.phiLeft, "φ_A"], [width - pad / 2, config.phiRight, "φ_B"]] as Array<[number, number, string]>) {
			ctx.fillStyle = rgb(sequentialColor(scale(v)));
			ctx.beginPath(); ctx.arc(x, top + boxH / 2, 9, 0, Math.PI * 2); ctx.fill();
			ctx.fillStyle = muted; ctx.fillText(`${label}=${formatNumber(v)}`, x, top + boxH + 16);
		}
		result.cells.forEach((cell, k) => {
			const x = pad + k * cellWidth, color = sequentialColor(scale(cell.phi));
			ctx.fillStyle = rgb(color);
			ctx.fillRect(x, top, cellWidth, boxH);
			ctx.strokeStyle = getThemeColor("--background-primary");
			ctx.lineWidth = 1;
			ctx.strokeRect(x, top, cellWidth, boxH);
			if (cellWidth > 38) { ctx.fillStyle = textColorFor(color); ctx.fillText(cell.phi.toFixed(3), x + cellWidth / 2, top + boxH / 2); }
			else { ctx.fillStyle = textColorFor(color); ctx.beginPath(); ctx.arc(x + cellWidth / 2, top + boxH / 2, 2, 0, Math.PI * 2); ctx.fill(); }
		});
		const sel = state.selected, sx = pad + sel * cellWidth;
		ctx.strokeStyle = accent; ctx.lineWidth = 3; ctx.strokeRect(sx + 1.5, top + 1.5, cellWidth - 3, boxH - 3);
		ctx.fillStyle = accent; ctx.fillText("P", sx + cellWidth / 2, top + boxH + 16);
		ctx.fillStyle = muted;
		if (sel > 0) ctx.fillText("W", sx - cellWidth / 2, top + boxH + 16);
		if (sel < state.n - 1) ctx.fillText("E", sx + cellWidth * 1.5, top + boxH + 16);
		ctx.fillStyle = textColor; ctx.textAlign = "left";
		ctx.fillText(state.u >= 0 ? `흐름 방향 → (u = ${formatNumber(state.u)})` : `← 흐름 방향 (u = ${formatNumber(state.u)})`, pad, 14);

		const c = result.cells[sel], exact = exactConvectionDiffusion(setup, c.x), k = sel + 1;
		equation.empty();
		equation.createDiv({ cls: "cfd-equation-title", text: `셀 ${k} (x = ${formatNumber(c.x)})의 이산 방정식` });
		const west = sel === 0 ? `${c.boundaryWest.toFixed(3)}·φ_A` : `${c.aW.toFixed(3)}·φ${k - 1}`;
		const east = sel === state.n - 1 ? `${c.boundaryEast.toFixed(3)}·φ_B` : `${c.aE.toFixed(3)}·φ${k + 1}`;
		equation.createDiv({ cls: "cfd-equation-line", text: `${c.aP.toFixed(3)}·φ${k} = ${west} + ${east}` });
		equation.createDiv({ cls: "cfd-equation-line", text: `→ φ${k} = ${c.phi.toFixed(4)}   (정확해 ${exact.toFixed(4)}, 오차 ${(c.phi - exact).toExponential(1)})` });
		const notes: string[] = [];
		if (sel === 0 || sel === state.n - 1) notes.push("경계 셀: 경계면이 반 셀(Δx/2) 떨어져 있어 확산 전도도가 2Γ/Δx가 되고, 경계값 항은 생성항 S_u로 넘어간다.");
		if (result.hasNegativeCoefficient) notes.push("음의 계수가 있다: 이웃 값이 커질수록 φ_P가 작아지는 비물리적 결합이라 해가 진동(wiggle)하거나 경계값 범위를 벗어난다. |Pe| > 2에서 중심 차분의 한계.");
		if (state.scheme !== "central" && Math.abs(result.cellPeclet) > 2) notes.push("셀 Péclet이 커서 상류 성분이 지배한다. 계수는 항상 양수라 안정하지만, 격자가 거칠면 수치 확산으로 경계층이 두꺼워 보인다.");
		for (const note of notes) equation.createDiv({ cls: "cfd-note", text: note });

		const xs = [0, ...result.cells.map(cell => cell.x), 1], ys = [config.phiLeft, ...values, config.phiRight];
		const fine = Array.from({ length: 201 }, (_, i) => i / 200);
		const fg = getThemeColor("--text-normal"), grid = getThemeColor("--background-modifier-border");
		void loadPlotly().then(Plotly => Plotly.react(plot, [
			{ x: fine, y: fine.map(x => exactConvectionDiffusion(setup, x)), type: "scatter", mode: "lines", name: "정확해", line: { width: 2, dash: "dot" } },
			{ x: xs, y: ys, type: "scatter", mode: "lines+markers", name: `수치해 (${state.scheme})`, marker: { size: 7 } },
		], {
			margin: { l: 48, r: 16, t: 12, b: 42 }, height: 280, paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
			font: { color: fg }, xaxis: { title: "x", gridcolor: grid }, yaxis: { title: "φ", gridcolor: grid }, legend: { orientation: "h" },
		}, { displayModeBar: false, responsive: true }));
	}
	update();
}

function renderAdvection(card: HTMLElement, config: CfdCellsConfig, id: string): void {
	const state = {
		n: Math.min(Math.max(config.cells, 20), 200),
		courant: config.courant,
		scheme: (ADVECTION_SCHEMES.some(([s]) => s === config.scheme) ? config.scheme : "upwind") as AdvectionScheme,
		shape: config.shape,
		phi: new Float64Array(0) as Float64Array,
		mass0: 0,
		steps: 0,
		playing: false,
		pending: 0,
	};
	card.createDiv({ cls: "formulalab-formula", text: "∂φ/∂t + c ∂φ/∂x = 0,   Courant 수 C = cΔt/Δx" });
	const controls = card.createDiv({ cls: "formulalab-controls" });
	bindSlider(controls, `${id}-n`, "셀 수", { value: state.n, min: 20, max: 200, step: 10 }, v => { state.n = v; reset(); });
	bindSlider(controls, `${id}-c`, "Courant 수 C", { value: state.courant, min: 0.05, max: 1.5, step: 0.05 }, v => { state.courant = v; reset(); });
	createSelect(controls, "스킴", ADVECTION_SCHEMES, state.scheme, v => { state.scheme = v; reset(); });
	createSelect(controls, "초기 파형", [["square", "사각 펄스"], ["gauss", "가우스 펄스"]], state.shape, v => { state.shape = v; reset(); });
	const buttons = card.createDiv({ cls: "cfd-buttons" });
	const play = createButton(buttons, "▶ 재생", () => { state.playing = !state.playing; loop.wake(); draw(); });
	createButton(buttons, "한 스텝", () => { state.playing = false; advance(1); draw(); });
	createButton(buttons, "초기화", () => reset());
	const note = card.createDiv({ cls: "cfd-note" });
	const info = card.createDiv({ cls: "cfd-metrics" });
	const canvasWrap = card.createDiv({ cls: "cfd-canvas-wrap" });
	const canvas = canvasWrap.createEl("canvas", { cls: "cfd-canvas", attr: { "aria-label": "advection cells" } });
	new ResizeObserver(() => { if (card.isConnected) draw(); }).observe(canvasWrap);
	const loop = animationLoop(card, elapsed => {
		state.pending += elapsed * 30 / 1000;
		const steps = Math.floor(state.pending);
		state.pending -= steps;
		advance(steps);
		draw();
	}, () => state.playing);

	function reset(): void {
		state.phi = pulse(state.n, state.shape);
		state.mass0 = state.phi.reduce((a, b) => a + b, 0);
		state.steps = 0;
		state.playing = false;
		draw();
	}
	function advance(steps: number): void {
		for (let s = 0; s < steps; s++) {
			state.phi = advectStep(state.phi, state.courant, state.scheme);
			state.steps++;
			if (Math.max(...state.phi.map(Math.abs)) > 1e3) { state.playing = false; break; }
		}
	}
	function draw(): void {
		play.setText(state.playing ? "⏸ 일시정지" : "▶ 재생");
		const unstable = state.scheme === "ftcs" || state.courant > 1 + 1e-9;
		note.setText(`${ADVECTION_NOTES[state.scheme]}${state.courant > 1 + 1e-9 ? "  ⚠ C > 1: 한 스텝에 정보가 한 셀보다 멀리 가야 하는데 스텐실이 이웃 셀만 보므로 불안정하다(CFL 조건 위반)." : ""}`);
		note.toggleClass("is-warning", unstable);
		const exact = pulse(state.n, state.shape, state.steps * state.courant);
		const max = Math.max(...state.phi.map(Math.abs)), mass = state.phi.reduce((a, b) => a + b, 0);
		info.empty();
		for (const [label, value, warn] of [
			["스텝", String(state.steps), false],
			["이동 거리", `${formatNumber(state.steps * state.courant)} 셀`, false],
			["최대 |φ|", formatNumber(max), max > 1.05],
			["총량 보존", `${formatNumber(mass / (state.mass0 || 1) * 100)} %`, Math.abs(mass / (state.mass0 || 1) - 1) > 1e-6],
		] as Array<[string, string, boolean]>) {
			const item = info.createDiv({ cls: `cfd-metric${warn ? " is-warning" : ""}` });
			item.createSpan({ cls: "cfd-metric-label", text: label });
			item.createSpan({ cls: "cfd-metric-value", text: value });
		}
		const { ctx, width, height } = fitCanvas(canvas, 230);
		const left = 34, right = width - 10, plotTop = 12, plotBottom = 172, stripTop = 190, stripH = 24;
		const yMin = -0.5, yMax = 1.5, toY = (v: number) => plotBottom - (Math.max(yMin, Math.min(yMax, v)) - yMin) / (yMax - yMin) * (plotBottom - plotTop);
		const cellW = (right - left) / state.n, toX = (i: number) => left + (i + 0.5) * cellW;
		ctx.clearRect(0, 0, width, height);
		const grid = getThemeColor("--background-modifier-border"), fg = getThemeColor("--text-muted");
		ctx.strokeStyle = grid; ctx.lineWidth = 1; ctx.font = "11px sans-serif"; ctx.fillStyle = fg; ctx.textAlign = "right"; ctx.textBaseline = "middle";
		for (const v of [0, 0.5, 1]) { ctx.beginPath(); ctx.moveTo(left, toY(v)); ctx.lineTo(right, toY(v)); ctx.stroke(); ctx.fillText(String(v), left - 6, toY(v)); }
		const line = (values: Float64Array, color: string, dash: number[], widthPx: number) => {
			ctx.strokeStyle = color; ctx.setLineDash(dash); ctx.lineWidth = widthPx; ctx.beginPath();
			values.forEach((v, i) => (i === 0 ? ctx.moveTo(toX(i), toY(v)) : ctx.lineTo(toX(i), toY(v))));
			ctx.stroke(); ctx.setLineDash([]);
		};
		line(exact, fg, [5, 4], 1.5);
		line(state.phi, getThemeColor("--interactive-accent"), [], 2.2);
		state.phi.forEach((v, i) => {
			ctx.fillStyle = rgb(sequentialColor(Math.max(0, Math.min(1, v))));
			ctx.fillRect(left + i * cellW, stripTop, Math.max(cellW - (cellW > 4 ? 1 : 0), 1), stripH);
		});
		ctx.textAlign = "left"; ctx.fillStyle = fg;
		ctx.fillText("점선: 정확해 · 실선: 수치해 · 아래 띠: 셀 값", left, stripTop + stripH + 12);
		if (max > 1e3) { ctx.fillStyle = "#d33"; ctx.font = "bold 14px sans-serif"; ctx.fillText("발산! 해가 폭주해 멈췄습니다.", left + 8, plotTop + 12); }
	}
	reset();
}

function renderDiffusion2D(card: HTMLElement, config: CfdCellsConfig, id: string): void {
	const state = {
		n: Math.min(Math.max(config.cells, 3), 24),
		method: (METHODS.some(([m]) => m === config.scheme) ? config.scheme : "gauss-seidel") as IterativeMethod,
		omega: config.omega,
		source: config.source,
		solver: null as Diffusion2D | null,
		selected: [0, 0] as [number, number],
		playing: false,
		pending: 0,
	};
	card.createDiv({ cls: "formulalab-formula", text: "∇·(k∇T) + q = 0   →   각 셀:  a_P T_P = a_W T_W + a_E T_E + a_S T_S + a_N T_N + S_u" });
	const controls = card.createDiv({ cls: "formulalab-controls" });
	bindSlider(controls, `${id}-n`, "셀 수 (한 변)", { value: state.n, min: 3, max: 24, step: 1 }, v => { state.n = v; reset(); });
	createSelect(controls, "반복법", METHODS, state.method, v => { state.method = v; reset(); });
	bindSlider(controls, `${id}-w`, "SOR 이완계수 ω", { value: state.omega, min: 1, max: 1.95, step: 0.05 }, v => { state.omega = v; reset(); });
	bindSlider(controls, `${id}-q`, "열원 q", { value: state.source, min: 0, max: 2000, step: 50 }, v => { state.source = v; reset(); });
	const buttons = card.createDiv({ cls: "cfd-buttons" });
	const play = createButton(buttons, "▶ 반복", () => { state.playing = !state.playing; loop.wake(); draw(); });
	createButton(buttons, "1회 반복", () => { state.playing = false; state.solver?.iterate(); draw(); });
	createButton(buttons, "수렴까지", () => {
		state.playing = false;
		const s = state.solver as Diffusion2D;
		while (s.iterate() > 1e-6 && s.iterations < 20000) { /* iterate to convergence */ }
		draw();
	});
	createButton(buttons, "초기화", () => reset());
	const info = card.createDiv({ cls: "cfd-metrics" });
	const canvasWrap = card.createDiv({ cls: "cfd-canvas-wrap" });
	const canvas = canvasWrap.createEl("canvas", { cls: "cfd-canvas", attr: { "aria-label": "2D conduction cells" } });
	card.createDiv({ cls: "cfd-hint", text: "셀을 누르면 그 셀의 이산 방정식을 보여 줍니다. 처음엔 모두 0에서 출발해 경계 정보가 셀을 타고 안쪽으로 퍼집니다." });
	const equation = card.createDiv({ cls: "cfd-equation" });
	const residualCanvas = card.createDiv({ cls: "cfd-canvas-wrap" }).createEl("canvas", { cls: "cfd-canvas", attr: { "aria-label": "residual history" } });
	let geometry = { x0: 0, y0: 0, size: 0 };
	canvas.addEventListener("pointerdown", event => {
		const rect = canvas.getBoundingClientRect(), cell = geometry.size / state.n;
		const i = Math.floor((event.clientX - rect.left - geometry.x0) / cell), jFromTop = Math.floor((event.clientY - rect.top - geometry.y0) / cell);
		if (i >= 0 && i < state.n && jFromTop >= 0 && jFromTop < state.n) { state.selected = [i, state.n - 1 - jFromTop]; draw(); }
	});
	new ResizeObserver(() => { if (card.isConnected) draw(); }).observe(canvasWrap);
	const loop = animationLoop(card, elapsed => {
		state.pending += elapsed * 12 / 1000;
		const sweeps = Math.floor(state.pending);
		state.pending -= sweeps;
		for (let k = 0; k < sweeps; k++) state.solver?.iterate();
		if ((state.solver?.residuals.slice(-1)[0] ?? 1) < 1e-6) state.playing = false;
		draw();
	}, () => state.playing);

	function reset(): void {
		state.solver = new Diffusion2D({ nx: state.n, ny: state.n, left: config.left, right: config.right, top: config.top, bottom: config.bottom, source: state.source, method: state.method, omega: state.omega });
		state.selected = [Math.min(state.selected[0], state.n - 1), Math.min(state.selected[1], state.n - 1)];
		state.playing = false;
		draw();
	}
	function draw(): void {
		const s = state.solver as Diffusion2D;
		play.setText(state.playing ? "⏸ 멈춤" : "▶ 반복");
		const residual = s.residuals.length ? s.residuals[s.residuals.length - 1] : s.residual();
		info.empty();
		for (const [label, value] of [["반복 횟수", String(s.iterations)], ["잔차 max|a_P T_P − Σa_nb T_nb − S_u|", residual.toExponential(2)], ["방법", `${state.method}${state.method === "sor" ? ` (ω = ${state.omega})` : ""}`]]) {
			const item = info.createDiv({ cls: "cfd-metric" });
			item.createSpan({ cls: "cfd-metric-label", text: label });
			item.createSpan({ cls: "cfd-metric-value", text: value });
		}
		const bounds = [config.left, config.right, config.top, config.bottom].filter((b): b is number => b !== "insulated");
		const lo = Math.min(0, ...bounds, ...Array.from(s.T)), hi = Math.max(1e-9, ...bounds, ...Array.from(s.T));
		const { ctx, width } = fitCanvas(canvas, Math.min(380, Math.max(240, (canvas.parentElement?.clientWidth || 380) * 0.75)));
		const height = canvas.height / (window.devicePixelRatio || 1), margin = 30, size = Math.min(width - 2 * margin, height - 2 * margin), x0 = (width - size) / 2, y0 = margin, cell = size / state.n;
		geometry = { x0, y0, size };
		ctx.clearRect(0, 0, width, height);
		ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.font = `${Math.max(8, Math.min(12, cell / 2.6))}px sans-serif`;
		for (let i = 0; i < state.n; i++) for (let j = 0; j < state.n; j++) {
			const T = s.T[i * state.n + j], color = sequentialColor((T - lo) / (hi - lo)), x = x0 + i * cell, y = y0 + (state.n - 1 - j) * cell;
			ctx.fillStyle = rgb(color); ctx.fillRect(x, y, cell, cell);
			ctx.strokeStyle = getThemeColor("--background-primary"); ctx.lineWidth = 1; ctx.strokeRect(x, y, cell, cell);
			if (cell > 20) { ctx.fillStyle = textColorFor(color); ctx.fillText(T.toFixed(cell > 44 ? 1 : 0), x + cell / 2, y + cell / 2); }
		}
		const [si, sj] = state.selected, sx = x0 + si * cell, sy = y0 + (state.n - 1 - sj) * cell;
		ctx.strokeStyle = getThemeColor("--interactive-accent"); ctx.lineWidth = 3; ctx.strokeRect(sx + 1.5, sy + 1.5, cell - 3, cell - 3);
		ctx.fillStyle = getThemeColor("--text-muted"); ctx.font = "11px sans-serif";
		const label = (b: Boundary) => (b === "insulated" ? "단열" : `${b}`);
		ctx.fillText(`위: ${label(config.top)}`, width / 2, y0 - 14);
		ctx.fillText(`아래: ${label(config.bottom)}`, width / 2, y0 + size + 14);
		ctx.save(); ctx.translate(x0 - 14, y0 + size / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(`왼쪽: ${label(config.left)}`, 0, 0); ctx.restore();
		ctx.save(); ctx.translate(x0 + size + 14, y0 + size / 2); ctx.rotate(Math.PI / 2); ctx.fillText(`오른쪽: ${label(config.right)}`, 0, 0); ctx.restore();

		const eq = s.equation(si, sj), f = (v: number) => v.toFixed(2);
		const term = (a: number, name: string, value: number | null) => (value === null || a === 0 ? null : `${f(a)}·${name}(${f(value)})`);
		const terms = [term(eq.aW, "T_W", eq.neighbours.W), term(eq.aE, "T_E", eq.neighbours.E), term(eq.aS, "T_S", eq.neighbours.S), term(eq.aN, "T_N", eq.neighbours.N)].filter(Boolean);
		equation.empty();
		equation.createDiv({ cls: "cfd-equation-title", text: `셀 (${si + 1}, ${sj + 1})의 이산 방정식` });
		equation.createDiv({ cls: "cfd-equation-line", text: `${f(eq.aP)}·T_P = ${terms.join(" + ") || "0"} + S_u(${f(eq.su)})` });
		const target = ((eq.aW * (eq.neighbours.W ?? 0)) + (eq.aE * (eq.neighbours.E ?? 0)) + (eq.aS * (eq.neighbours.S ?? 0)) + (eq.aN * (eq.neighbours.N ?? 0)) + eq.su) / eq.aP;
		equation.createDiv({ cls: "cfd-equation-line", text: `현재 T_P = ${f(eq.T)}  ·  이웃 값으로 다시 계산하면 ${f(target)}  (차이 ${(target - eq.T).toExponential(1)})` });
		const boundaryNote = eq.aP - (eq.aW + eq.aE + eq.aS + eq.aN) > 1e-9;
		if (boundaryNote) equation.createDiv({ cls: "cfd-note", text: "경계 셀: 벽 온도가 반 셀 떨어진 면에 있어 전도도가 2배(2k·면적/Δx)가 되고, 그 몫이 a_P와 S_u에 들어간다. 단열 벽은 계수 0." });
		equation.createDiv({ cls: "cfd-note", text: state.method === "jacobi" ? "Jacobi: 모든 셀을 이전 반복 값으로만 갱신해 정보가 한 반복에 한 셀씩만 퍼진다." : state.method === "gauss-seidel" ? "Gauss–Seidel: 방금 갱신한 이웃 값을 바로 써서 Jacobi보다 약 2배 빨리 수렴한다." : "SOR: Gauss–Seidel 보정량에 ω(>1)를 곱해 과감하게 앞질러 간다. 적절한 ω에서 반복 수가 크게 준다." });

		const history = s.residuals, { ctx: rc, width: rw } = fitCanvas(residualCanvas, 120), rh = 120;
		rc.clearRect(0, 0, rw, rh);
		rc.fillStyle = getThemeColor("--text-muted"); rc.font = "11px sans-serif"; rc.textAlign = "left"; rc.textBaseline = "top";
		rc.fillText("잔차 (log₁₀) — 반복할수록 내려가면 수렴", 8, 4);
		if (history.length > 1) {
			const logs = history.map(r => Math.log10(Math.max(r, 1e-12))), top = Math.max(...logs), bottom = Math.min(...logs, top - 1);
			rc.strokeStyle = getThemeColor("--interactive-accent"); rc.lineWidth = 2; rc.beginPath();
			logs.forEach((v, k) => { const x = 8 + (k / (logs.length - 1)) * (rw - 16), y = 22 + (top - v) / (top - bottom) * (rh - 30); k === 0 ? rc.moveTo(x, y) : rc.lineTo(x, y); });
			rc.stroke();
		}
	}
	reset();
}
