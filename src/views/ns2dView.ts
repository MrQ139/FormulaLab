import { parse as parseYaml } from "yaml";
import { Convection, GHIA_CAVITY_U, Ns2D, NsCase, NsField } from "../solvers/ns2d";
import {
	animationLoop, bindSlider, loadPlotly, createButton, createDetails, createSelect, createToggle, divergingColor, finiteOrDefault,
	fitCanvas, formatNumber, getThemeColor, isRecord, optionalString, renderTex, rgb, sequentialColor, tc,
} from "../ui";

export interface Ns2DConfig {
	title?: string;
	flowCase: NsCase;
	re: number;
	grid: number;
	convection: Convection;
	field: NsField;
	tracers: boolean;
	arrows: boolean;
	autoplay: boolean;
}

const CASES: Record<NsCase, { title: string; description: string; re: [number, number, number]; grid: [number, number, number, number] }> = {
	cavity: {
		title: "뚜껑 구동 공동 (lid-driven cavity)",
		description: "윗면이 속도 1로 미끄러지는 정사각 공동. 점성이 운동량을 안쪽으로 전달해 큰 주 와류가 생기고, Re가 커질수록 와류 중심이 오른쪽 위에서 가운데로 내려오며 아래 모서리에 2차 와류가 자란다.",
		re: [10, 1000, 100], grid: [16, 80, 8, 32],
	},
	channel: {
		title: "평행 평판 채널 (Poiseuille)",
		description: "좌우가 이어진(주기 경계) 채널을 일정한 압력구배로 민다. 벽의 점착 조건과 점성 확산이 균형을 이루면 포물선 속도 분포가 된다. 중심 속도가 1이 되도록 구동력을 맞췄다.",
		re: [1, 200, 20], grid: [12, 48, 4, 20],
	},
	couette: {
		title: "쿠에트 유동 (Couette)",
		description: "위쪽 벽만 속도 1로 움직이는 평행 평판. 압력구배가 없으면 점성 전단만으로 선형 속도 분포가 된다. 초기 정지 상태에서 운동량이 벽에서 확산되어 들어오는 과정을 볼 수 있다.",
		re: [1, 200, 20], grid: [12, 48, 4, 20],
	},
	obstacle: {
		title: "원기둥 주위 유동과 와류 방출",
		description: "균일한 유입 속에 지름 D = 0.2인 원기둥(계단형 셀 근사). Re = UD/ν가 약 50을 넘으면 후류가 흔들리며 좌우 교대로 와류가 떨어져 나간다(카르만 와열). 와도(vorticity) 보기에서 가장 잘 보인다.",
		re: [20, 250, 120], grid: [16, 40, 4, 24],
	},
};

const FIELDS: Array<[NsField, string]> = [["speed", "속도 크기 |u|"], ["vorticity", "와도 ω"], ["pressure", "압력 p"], ["divergence", "발산 ∇·u (질량보존 오차)"], ["u", "u (x 방향)"], ["v", "v (y 방향)"]];
const SCHEMES: Array<[Convection, string]> = [["hybrid", "혼합 (donor-cell + 중심)"], ["upwind", "1차 상류 (donor-cell)"], ["central", "2차 중심"]];

export function parseNs2DConfig(source: string): Ns2DConfig {
	const raw = source.trim() ? parseYaml(source) : {};
	if (!isRecord(raw)) throw new Error("ns2d 블록은 YAML 객체여야 합니다.");
	const flowCase = String(raw.case ?? "cavity") as NsCase;
	if (!(flowCase in CASES)) throw new Error("case는 cavity, channel, couette, obstacle 중 하나여야 합니다.");
	const spec = CASES[flowCase];
	const field = String(raw.field ?? (flowCase === "obstacle" ? "vorticity" : "speed")) as NsField;
	const convection = String(raw.scheme ?? "hybrid") as Convection;
	return {
		flowCase,
		title: optionalString(raw.title),
		re: Math.min(Math.max(finiteOrDefault(raw.re, spec.re[2]), spec.re[0]), spec.re[1]),
		grid: Math.min(Math.max(Math.round(finiteOrDefault(raw.grid, spec.grid[3])), spec.grid[0]), spec.grid[1]),
		convection: SCHEMES.some(([s]) => s === convection) ? convection : "hybrid",
		field: FIELDS.some(([f]) => f === field) ? field : "speed",
		tracers: raw.tracers !== false,
		arrows: raw.arrows === true,
		autoplay: raw.autoplay === true,
	};
}

interface Tracer { x: number; y: number; trail: Array<[number, number]>; age: number; life: number }

const TRAIL = 10;

export function renderNs2D(el: HTMLElement, config: Ns2DConfig): void {
	el.empty();
	const spec = CASES[config.flowCase];
	const id = `ns2d-${Math.random().toString(36).slice(2)}`;
	const state = {
		re: config.re, grid: config.grid, convection: config.convection, field: config.field,
		tracers: config.tracers, arrows: config.arrows, playing: config.autoplay, phaseMode: false,
		solver: null as unknown as Ns2D, particles: [] as Tracer[], probe: [] as Array<[number, number]>, lastPlot: 0,
	};

	const card = el.createDiv({ cls: "formulalab-card ns2d-card" });
	const header = card.createDiv({ cls: "formulalab-header" });
	header.createEl("h4", { text: config.title ?? spec.title });
	header.createSpan({ cls: "formulalab-mode", text: "2D Navier–Stokes" });
	renderTex(card.createDiv({ cls: "formulalab-formula formulalab-formula-math" }),
		`${tc("blue", "\\dfrac{\\partial \\mathbf{u}}{\\partial t} + (\\mathbf{u}\\cdot\\nabla)\\mathbf{u}")} = ${tc("orange", "-\\nabla p")} + ${tc("green", "\\dfrac{1}{Re}\\nabla^{2}\\mathbf{u}")}, \\qquad \\nabla\\cdot\\mathbf{u} = 0`, true);
	card.createDiv({ cls: "ns2d-description", text: spec.description });

	// Everyday controls stay on top; the step-by-step view, grid, scheme and numbers sit in "자세히".
	const controls = card.createDiv({ cls: "formulalab-controls" });
	bindSlider(controls, `${id}-re`, config.flowCase === "obstacle" ? "레이놀즈 수 Re = UD/ν" : "레이놀즈 수 Re", { value: state.re, min: spec.re[0], max: spec.re[1], step: 1 }, v => { state.re = v; reset(); }, v => String(Math.round(v)));
	createSelect(controls, "색으로 볼 값", FIELDS, state.field, v => { state.field = v; draw(); });
	const buttons = card.createDiv({ cls: "cfd-buttons" });
	const play = createButton(buttons, "▶ 재생", () => { state.playing = !state.playing; state.phaseMode = false; loop.wake(); draw(); });
	createButton(buttons, "처음부터", () => reset());
	const canvasWrap = card.createDiv({ cls: "cfd-canvas-wrap" });
	const canvas = canvasWrap.createEl("canvas", { cls: "cfd-canvas", attr: { "aria-label": "2D Navier-Stokes field" } });
	const legend = card.createDiv({ cls: "ns2d-legend" });

	const details = createDetails(card, "자세히 — 한 스텝 뜯어보기 · 격자 · 스킴 · 수치 지표");
	const phases = details.createDiv({ cls: "ns2d-phases" });
	const phaseCards = ([
		["① 예측 (운동량)", "\\mathbf{u}^{*} = \\mathbf{u}^{n} + \\Delta t\\,\\big[\\,\\nu\\nabla^{2}\\mathbf{u} - (\\mathbf{u}\\cdot\\nabla)\\mathbf{u}\\,\\big]", "압력을 빼고 대류·확산만으로 속도를 한 스텝 전진시킨다. 이 u*는 질량보존을 만족하지 않는다."],
		["② 압력 푸아송", "\\nabla^{2} p = \\dfrac{\\nabla\\cdot\\mathbf{u}^{*}}{\\Delta t}", "u*의 발산을 정확히 지우는 압력을 푼다(SOR 반복). 압력은 '비압축 조건을 지키게 하는 힘'이다."],
		["③ 보정 (투영)", "\\mathbf{u}^{n+1} = \\mathbf{u}^{*} - \\Delta t\\,\\nabla p", "압력 기울기로 속도를 밀어 발산 없는 장으로 투영한다. 이렇게 한 스텝이 끝난다."],
	] as Array<[string, string, string]>).map(([title, formula, text]) => {
		const box = phases.createDiv({ cls: "ns2d-phase" });
		box.createDiv({ cls: "ns2d-phase-title", text: title });
		renderTex(box.createDiv({ cls: "ns2d-phase-formula" }), formula, true);
		box.createDiv({ cls: "ns2d-phase-text", text });
		return { box, live: box.createDiv({ cls: "ns2d-phase-live" }) };
	});
	const stepButtons = details.createDiv({ cls: "cfd-buttons" });
	createButton(stepButtons, "단계별 ▷", () => { state.playing = false; state.phaseMode = true; state.solver.advancePhase(); draw(); }, "예측 → 압력 → 보정을 한 단계씩 실행");
	createButton(stepButtons, "한 스텝", () => { state.playing = false; state.phaseMode = false; finishPhase(); advance(1); draw(); });
	const phaseNote = details.createDiv({ cls: "cfd-note ns2d-phase-note" });
	const advanced = details.createDiv({ cls: "formulalab-controls" });
	bindSlider(advanced, `${id}-grid`, config.flowCase === "cavity" ? "격자 (N×N)" : "격자 (세로 셀 수)", { value: state.grid, min: spec.grid[0], max: spec.grid[1], step: spec.grid[2] }, v => { state.grid = v; reset(); }, v => String(Math.round(v)));
	createSelect(advanced, "대류항 스킴", SCHEMES, state.convection, v => { state.convection = v; reset(); });
	const toggles = details.createDiv({ cls: "cfd-buttons" });
	createToggle(toggles, "입자 흐름 표시", state.tracers, v => { state.tracers = v; draw(); });
	createToggle(toggles, "속도 화살표", state.arrows, v => { state.arrows = v; draw(); });
	const metrics = details.createDiv({ cls: "cfd-metrics" });

	const validation = createDetails(card, config.flowCase === "obstacle" ? "검증 — 후류 진동과 Strouhal 수" : "검증 — 기준 해와 비교");
	const plotNote = validation.createDiv({ cls: "cfd-hint" });
	const plot = validation.createDiv({ cls: "formulalab-plot" });
	validation.parentElement?.addEventListener("toggle", () => drawPlot());
	new ResizeObserver(() => { if (card.isConnected) draw(); }).observe(canvasWrap);
	const heat = document.createElement("canvas");

	const loop = animationLoop(card, () => {
		const start = performance.now();
		let simulated = 0;
		// At most ~12 ms of solver work per frame keeps phones responsive; capping simulated time per frame
		// keeps tracer motion smooth instead of jumping on fast machines.
		do { simulated += advance(1); } while (performance.now() - start < 12 && simulated < 0.03 && state.playing);
		moveTracers(simulated);
		draw();
	}, () => state.playing);

	function reset(): void {
		state.solver = new Ns2D({ flowCase: config.flowCase, n: state.grid, re: state.re, convection: state.convection });
		state.probe = [];
		state.particles = Array.from({ length: config.flowCase === "obstacle" ? 320 : 200 }, () => spawn(true));
		state.phaseMode = false;
		state.lastPlot = 0;
		// Start from a flow that has already begun to develop (about one time unit, at most ~150 ms of work),
		// so the first picture is not an empty field.
		const start = performance.now();
		while (state.solver.stats.time < 1 && performance.now() - start < 150) advance(1);
		draw(true);
	}
	function finishPhase(): void {
		while (state.solver.phase !== "idle") state.solver.advancePhase();
	}
	function advance(steps: number): number {
		const s = state.solver;
		let simulated = 0;
		for (let k = 0; k < steps; k++) {
			s.step();
			simulated += s.stats.dt;
			if (!Number.isFinite(s.stats.maxSpeed) || s.stats.maxSpeed > 50) { state.playing = false; break; }
			if (config.flowCase === "obstacle") {
				state.probe.push([s.stats.time, s.velocityAt(s.obstacle.x + 4 * s.obstacle.r, s.obstacle.y)[1]]);
				if (state.probe.length > 4000) state.probe.splice(0, state.probe.length - 4000);
			}
		}
		return simulated;
	}
	function spawn(anywhere: boolean): Tracer {
		const s = state.solver;
		for (let tries = 0; tries < 20; tries++) {
			const x = config.flowCase === "obstacle" && !anywhere ? Math.random() * 0.05 : Math.random() * s.lx, y = Math.random() * s.ly;
			const i = Math.min(Math.floor(x / s.dx), s.nx - 1), j = Math.min(Math.floor(y / s.dy), s.ny - 1);
			if (!s.isSolidCell(i, j)) return { x, y, trail: [], age: 0, life: 160 + Math.random() * 240 };
		}
		return { x: 0.01, y: 0.5, trail: [], age: 0, life: 200 };
	}
	function moveTracers(dt: number): void {
		if (!state.tracers || dt <= 0) return;
		const s = state.solver;
		state.particles = state.particles.map(p => {
			const [u1, v1] = s.velocityAt(p.x, p.y);
			const [u2, v2] = s.velocityAt(p.x + u1 * dt / 2, p.y + v1 * dt / 2);
			let x = p.x + u2 * dt, y = p.y + v2 * dt;
			if (s.periodic) x = ((x % s.lx) + s.lx) % s.lx;
			const i = Math.floor(x / s.dx), j = Math.floor(y / s.dy);
			const dead = x < 0 || x > s.lx || y < 0 || y > s.ly || p.age > p.life || (i >= 0 && j >= 0 && i < s.nx && j < s.ny && s.isSolidCell(i, j));
			if (dead) return spawn(config.flowCase !== "obstacle");
			// A periodic wrap would draw a tail across the whole channel, so the tail restarts there.
			const trail = Math.abs(x - p.x) > s.lx / 2 ? [] : [...p.trail, [p.x, p.y] as [number, number]].slice(-TRAIL);
			return { x, y, trail, age: p.age + 1, life: p.life };
		});
	}

	function fieldRange(values: Float64Array, symmetric: boolean): [number, number] {
		const finite = Array.from(values).filter(Number.isFinite);
		if (!finite.length) return [0, 1];
		if (!symmetric) return [0, Math.max(1e-9, ...finite)];
		// Corner singularities make a few cells extreme; clip to the 98th percentile so the structure stays visible,
		// but never below 5 % of the peak, or a field that is non-zero in only a few cells would vanish.
		const sorted = finite.map(Math.abs).sort((a, b) => a - b);
		const peak = sorted[sorted.length - 1];
		const limit = Math.max(1e-12, sorted[Math.floor(0.98 * (sorted.length - 1))], 0.05 * peak);
		return [-limit, limit];
	}

	function draw(forcePlot = false): void {
		const s = state.solver;
		play.setText(state.playing ? "⏸ 일시정지" : "▶ 재생");
		const displayField: NsField = state.phaseMode ? (s.phase === "predicted" ? "divergence" : s.phase === "pressure" ? "pressure" : state.field) : state.field;
		const st = s.stats;
		phaseCards[0].live.setText(`|∇·u*|max = ${st.divergenceBefore.toExponential(2)}`);
		phaseCards[1].live.setText(`SOR ${st.poissonIterations}회 · 잔차 ${st.poissonResidual.toExponential(1)}`);
		phaseCards[2].live.setText(`|∇·u|max = ${st.divergenceAfter.toExponential(2)}`);
		const active = !state.phaseMode ? -1 : s.phase === "predicted" ? 0 : s.phase === "pressure" ? 1 : st.steps > 0 ? 2 : -1;
		phaseCards.forEach((c, k) => c.box.toggleClass("is-active", k === active));
		const reduction = st.divergenceAfter > 0 ? st.divergenceBefore / st.divergenceAfter : 0;
		phaseNote.setText(!state.phaseMode ? "‘단계별 ▷’을 누르면 한 스텝을 세 단계로 나눠 각 단계 직후의 장을 보여 줍니다."
			: s.phase === "predicted" ? "① 직후: 화면은 u*의 발산입니다. 빨강·파랑이 질량이 생기거나 사라지는 곳 — 압력 없이 전진하면 연속 방정식이 깨집니다."
			: s.phase === "pressure" ? "② 직후: 화면은 방금 푼 압력장입니다. 발산이 양(+)인 곳은 압력이 높아져 유체를 밀어내고, 음(−)인 곳은 끌어당깁니다."
			: `③ 직후: 압력 기울기로 보정해 발산이 ${reduction ? `약 ${Math.round(reduction).toLocaleString()}배` : ""} 줄었습니다. 이것이 한 타임스텝입니다.`);

		metrics.empty();
		for (const [label, value, warn] of [
			["시간 t", formatNumber(st.time), false], ["스텝", String(st.steps), false], ["Δt", st.dt ? st.dt.toExponential(2) : "-", false],
			["Courant 수", formatNumber(st.cfl), st.cfl > 1],
			["셀 Re = |u|Δx/ν", formatNumber(st.cellRe), state.convection === "central" && st.cellRe > 2],
			["donor-cell 가중 γ", formatNumber(st.gamma), false],
			["최대 속도", formatNumber(st.maxSpeed), st.maxSpeed > 5],
		] as Array<[string, string, boolean]>) {
			const item = metrics.createDiv({ cls: `cfd-metric${warn ? " is-warning" : ""}` });
			item.createSpan({ cls: "cfd-metric-label", text: label });
			item.createSpan({ cls: "cfd-metric-value", text: value });
		}

		const values = s.cellField(displayField);
		const symmetric = displayField !== "speed";
		const [lo, hi] = fieldRange(values, symmetric);
		heat.width = s.nx; heat.height = s.ny;
		const hctx = heat.getContext("2d") as CanvasRenderingContext2D, image = hctx.createImageData(s.nx, s.ny);
		for (let i = 0; i < s.nx; i++) for (let j = 0; j < s.ny; j++) {
			const value = values[i * s.ny + j], k = ((s.ny - 1 - j) * s.nx + i) * 4;
			const color = Number.isNaN(value) ? [110, 110, 110] as [number, number, number] : symmetric ? divergingColor(value / hi) : sequentialColor((value - lo) / (hi - lo));
			image.data[k] = color[0]; image.data[k + 1] = color[1]; image.data[k + 2] = color[2]; image.data[k + 3] = 255;
		}
		hctx.putImageData(image, 0, 0);
		const wrapWidth = canvas.parentElement?.clientWidth || 600;
		const cssHeight = Math.max(170, Math.min(460, wrapWidth * s.ly / s.lx));
		const { ctx, width, height } = fitCanvas(canvas, cssHeight);
		const plotW = Math.min(width, height * s.lx / s.ly), plotH = plotW * s.ly / s.lx, ox = (width - plotW) / 2, oy = (height - plotH) / 2;
		const toX = (x: number) => ox + x / s.lx * plotW, toY = (y: number) => oy + plotH - y / s.ly * plotH;
		ctx.clearRect(0, 0, width, height);
		ctx.imageSmoothingEnabled = true;
		ctx.drawImage(heat, ox, oy, plotW, plotH);
		if (s.obstacle.r > 0) {
			ctx.fillStyle = "rgba(90,90,90,0.95)"; ctx.beginPath();
			ctx.ellipse(toX(s.obstacle.x), toY(s.obstacle.y), s.obstacle.r / s.lx * plotW, s.obstacle.r / s.ly * plotH, 0, 0, Math.PI * 2); ctx.fill();
		}
		if (state.arrows) {
			const count = Math.round(14 * s.lx / s.ly), spacing = s.lx / count, scale = 0.9 * spacing / Math.max(st.maxSpeed, 1e-6);
			ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.fillStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 1.2;
			for (let x = spacing / 2; x < s.lx; x += spacing) for (let y = spacing / 2; y < s.ly; y += spacing) {
				const [u, v] = s.velocityAt(x, y), x1 = toX(x), y1 = toY(y), x2 = toX(x + u * scale), y2 = toY(y + v * scale);
				if (Math.hypot(x2 - x1, y2 - y1) < 1.5) continue;
				ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
				const angle = Math.atan2(y2 - y1, x2 - x1);
				ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x2 - 5 * Math.cos(angle - 0.4), y2 - 5 * Math.sin(angle - 0.4)); ctx.lineTo(x2 - 5 * Math.cos(angle + 0.4), y2 - 5 * Math.sin(angle + 0.4)); ctx.fill();
			}
		}
		if (state.tracers) {
			// Short fading tails show where each particle came from; particles also fade in and out at the start
			// and end of their life so nothing pops. Tail segments of the same age share one stroke call.
			ctx.lineCap = "round"; ctx.lineWidth = 1.5;
			for (let k = 0; k < TRAIL; k++) {
				ctx.beginPath();
				for (const p of state.particles) {
					const n = p.trail.length, a = n - TRAIL + k;
					if (a < 0) continue;
					const [x1, y1] = p.trail[a], [x2, y2] = a + 1 < n ? p.trail[a + 1] : [p.x, p.y];
					ctx.moveTo(toX(x1), toY(y1)); ctx.lineTo(toX(x2), toY(y2));
				}
				ctx.strokeStyle = `rgba(255,255,255,${(0.08 + 0.6 * (k + 1) / TRAIL).toFixed(2)})`;
				ctx.stroke();
			}
			ctx.fillStyle = "rgba(255,255,255,0.95)";
			for (const p of state.particles) {
				const fade = Math.min(1, p.age / 12, (p.life - p.age) / 12);
				if (fade <= 0) continue;
				ctx.globalAlpha = fade;
				ctx.beginPath(); ctx.arc(toX(p.x), toY(p.y), 1.6, 0, Math.PI * 2); ctx.fill();
			}
			ctx.globalAlpha = 1;
		}
		ctx.fillStyle = getThemeColor("--text-normal"); ctx.font = "12px sans-serif"; ctx.textBaseline = "bottom"; ctx.textAlign = "left";
		if (config.flowCase === "cavity" || config.flowCase === "couette") ctx.fillText("움직이는 벽  U = 1  →", ox + 6, oy - 2 > 12 ? oy - 2 : oy + 14);
		ctx.strokeStyle = getThemeColor("--background-modifier-border"); ctx.lineWidth = 1; ctx.strokeRect(ox, oy, plotW, plotH);

		legend.empty();
		const labels = Object.fromEntries(FIELDS) as Record<NsField, string>;
		legend.createSpan({ cls: "ns2d-legend-label", text: labels[displayField] });
		legend.createSpan({ cls: "ns2d-legend-value", text: formatNumber(symmetric ? -hi : lo) });
		const bar = legend.createDiv({ cls: "ns2d-legend-bar" });
		const stops = Array.from({ length: 9 }, (_, k) => rgb(symmetric ? divergingColor(k / 4 - 1) : sequentialColor(k / 8)));
		bar.style.background = `linear-gradient(90deg, ${stops.join(", ")})`;
		legend.createSpan({ cls: "ns2d-legend-value", text: formatNumber(hi) });
		legend.createSpan({ cls: "ns2d-legend-status", text: `t = ${formatNumber(st.time)} · ${st.steps} 스텝` });

		const now = performance.now();
		if (forcePlot || !state.playing || now - state.lastPlot > 500) { state.lastPlot = now; drawPlot(); }
	}

	function drawPlot(): void {
		if (!(validation.parentElement as HTMLDetailsElement | null)?.open) return;
		const s = state.solver, fg = getThemeColor("--text-normal"), grid = getThemeColor("--background-modifier-border");
		const layout = (xTitle: string, yTitle: string) => ({
			margin: { l: 52, r: 16, t: 10, b: 44 }, height: 290, paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
			font: { color: fg }, xaxis: { title: xTitle, gridcolor: grid, zeroline: true }, yaxis: { title: yTitle, gridcolor: grid }, legend: { orientation: "h" },
		});
		if (config.flowCase === "obstacle") {
			const tail = state.probe.slice(-2000);
			let crossings: number[] = [];
			for (let k = 1; k < tail.length; k++) if (tail[k - 1][1] < 0 && tail[k][1] >= 0) crossings.push(tail[k][0]);
			crossings = crossings.slice(-6);
			const period = crossings.length >= 3 ? (crossings[crossings.length - 1] - crossings[0]) / (crossings.length - 1) : 0;
			const amplitude = tail.length ? Math.max(...tail.map(p => Math.abs(p[1]))) : 0;
			plotNote.setText(period > 0 && amplitude > 0.02
				? `후류 탐침 v(t)가 주기적으로 진동: 주기 T ≈ ${formatNumber(period)}, Strouhal 수 St = fD/U ≈ ${formatNumber(0.2 / period)} (실험값: Re≈100~200에서 약 0.16~0.19, 계단형 격자라 오차가 있다).`
				: "원기둥 뒤 4r 지점의 세로 속도 v(t)를 기록합니다. Re가 충분히 크면 와류 방출로 진동이 시작됩니다(초기 과도 구간 이후).");
			void loadPlotly().then(Plotly => Plotly.react(plot, [{ x: tail.map(p => p[0]), y: tail.map(p => p[1]), type: "scatter", mode: "lines", name: "탐침 v(t)" }], layout("시간 t", "v"), { displayModeBar: false, responsive: true }));
			return;
		}
		const profile = s.verticalProfile(0.5, 81);
		const traces: Array<Record<string, unknown>> = [{ x: profile.u, y: profile.y, type: "scatter", mode: "lines", name: `수치해 (${s.nx}×${s.ny})`, line: { width: 2.5 } }];
		if (config.flowCase === "cavity") {
			const reference = GHIA_CAVITY_U[Math.round(state.re)];
			if (reference && Math.abs(state.re - Math.round(state.re)) < 1e-9) {
				traces.push({ x: reference.map(p => p[1]), y: reference.map(p => p[0]), type: "scatter", mode: "markers", name: `Ghia et al. (1982), Re=${Math.round(state.re)}`, marker: { size: 8, symbol: "circle-open" } });
				plotNote.setText("세로 중심선(x = 0.5)의 u 분포를 Ghia et al. (1982)의 129×129 기준 해와 비교합니다. 정상상태에 가까워질수록 겹칩니다.");
			} else {
				plotNote.setText("세로 중심선(x = 0.5)의 u 분포입니다. Re를 100, 400, 1000으로 맞추면 Ghia et al. (1982) 기준 데이터와 비교할 수 있습니다.");
			}
		} else {
			const ys = Array.from({ length: 81 }, (_, k) => k / 80);
			traces.push({ x: ys.map(y => s.analyticProfile(y) as number), y: ys, type: "scatter", mode: "lines", name: config.flowCase === "channel" ? "해석해 u = 4y(1−y)" : "해석해 u = y", line: { dash: "dot", width: 2 } });
			plotNote.setText("채널 중앙 단면의 u(y)를 정상상태 해석해와 비교합니다. 처음엔 벽 근처부터 운동량이 확산되어 들어오다 해석해로 수렴합니다.");
		}
		void loadPlotly().then(Plotly => Plotly.react(plot, traces, layout("u", "y"), { displayModeBar: false, responsive: true }));
	}

	reset();
	if (state.playing) loop.wake();
}
