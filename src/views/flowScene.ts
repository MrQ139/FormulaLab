import { parse as parseYaml } from "yaml";
import {
	animationLoop, clamp, createButton, createLegend, createSlider, divergingColor, finiteOrDefault, fitCanvas, formatNumber,
	getErrorMessage, getThemeColor, isRecord, optionalString, renderTex, rgb, tc, TERM,
} from "../ui";
import type { FormulaParam } from "./formulaLab";

export type FlowSceneType =
	| "pipe-poiseuille"
	| "material-derivative"
	| "control-volume-flux"
	| "streamline-pathline-streakline"
	| "bernoulli-streamtube";

export type FlowSceneConfig = {
	title?: string;
	type: FlowSceneType;
	height: number;
	particles: number;
	showProfile: boolean;
	autoplay: boolean;
	params: Record<string, FormulaParam>;
};

const SCENE_TYPES: FlowSceneType[] = ["pipe-poiseuille", "material-derivative", "control-volume-flux", "streamline-pathline-streakline", "bernoulli-streamtube"];

const DEFAULT_PARAMS: Record<FlowSceneType, Record<string, FormulaParam>> = {
	"pipe-poiseuille": {
		umax: { label: "중심 속도 u_max", value: 2, min: 0.2, max: 5, step: 0.05 },
		R: { label: "관 반지름 R", value: 1, min: 0.3, max: 1.5, step: 0.05 },
	},
	"material-derivative": {
		U: { label: "입자 속도 u", value: 1.2, min: 0, max: 3, step: 0.05 },
		gradient: { label: "공간 기울기 ∂φ/∂x", value: 0.8, min: -2, max: 2, step: 0.05 },
		oscillation: { label: "제자리 변화 크기", value: 0.6, min: 0, max: 2, step: 0.05 },
	},
	"control-volume-flux": {
		inflow: { label: "유입 ṁ_in", value: 1.1, min: 0, max: 3, step: 0.05 },
		outflow: { label: "유출 ṁ_out", value: 0.8, min: 0, max: 3, step: 0.05 },
	},
	"streamline-pathline-streakline": {
		U: { label: "평균 속도 U", value: 1, min: 0.1, max: 3, step: 0.05 },
		unsteady: { label: "비정상성 (흔들림 크기)", value: 0.9, min: 0, max: 2, step: 0.05 },
	},
	"bernoulli-streamtube": {
		flow: { label: "유량 Q", value: 1, min: 0.2, max: 2.5, step: 0.05 },
		constriction: { label: "목 수축 정도", value: 0.48, min: 0.15, max: 0.85, step: 0.01 },
		zRise: { label: "출구 높이 변화 Δz", value: 0.25, min: -0.6, max: 0.6, step: 0.05 },
	},
};

/**
 * Parameters older notes still carry but the redrawn scenes no longer use: the control-volume storage is now
 * computed from inflow − outflow, and the other two never changed the picture. They are dropped instead of
 * showing sliders that do nothing.
 */
const OBSOLETE_PARAMS: Partial<Record<FlowSceneType, string[]>> = {
	"pipe-poiseuille": ["viscosity"],
	"control-volume-flux": ["storage"],
	"streamline-pathline-streakline": ["shear"],
};

export function parseFlowSceneConfig(source: string): FlowSceneConfig {
	let parsed: unknown;
	try {
		parsed = source.trim() ? parseYaml(source) : {};
	} catch (error) {
		throw new Error(`YAML parsing failed: ${getErrorMessage(error)}`);
	}
	if (!isRecord(parsed)) throw new Error("flow-scene block must contain a YAML object.");

	const raw = parsed;
	const type = String(raw.type ?? "pipe-poiseuille") as FlowSceneType;
	if (!SCENE_TYPES.includes(type)) throw new Error(`type must be one of ${SCENE_TYPES.join(", ")}.`);

	const rawParams = isRecord(raw.params) ? raw.params : {};
	// Older Bernoulli blocks called the elevation change "height".
	if (type === "bernoulli-streamtube" && !rawParams.zRise && rawParams.height) rawParams.zRise = rawParams.height;
	const params: Record<string, FormulaParam> = {};
	for (const [name, fallback] of Object.entries(DEFAULT_PARAMS[type])) {
		const param = isRecord(rawParams[name]) ? rawParams[name] : {};
		const min = finiteOrDefault(param.min, fallback.min), max = finiteOrDefault(param.max, fallback.max);
		params[name] = {
			label: optionalString(param.label) ?? fallback.label,
			value: clamp(finiteOrDefault(param.value, fallback.value), min, max),
			min,
			max,
			step: finiteOrDefault(param.step, fallback.step),
		};
	}
	const obsolete = OBSOLETE_PARAMS[type] ?? [];
	for (const [name, param] of Object.entries(rawParams)) {
		if (params[name] || obsolete.includes(name) || name === "height" || !isRecord(param)) continue;
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
		height: clamp(finiteOrDefault(raw.height, 340), 220, 700),
		particles: Math.round(clamp(finiteOrDefault(raw.particles, 36), 8, 120)),
		showProfile: raw.show_profile !== false && raw.showProfile !== false,
		autoplay: raw.autoplay !== false,
		params,
	};
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Drawing helpers                                                                                                */
/* ------------------------------------------------------------------------------------------------------------ */

type Theme = { fg: string; muted: string; border: string; bg: string; family: string };

function readTheme(): Theme {
	return {
		fg: getThemeColor("--text-normal"),
		muted: getThemeColor("--text-muted"),
		border: getThemeColor("--background-modifier-border"),
		bg: getThemeColor("--background-primary"),
		// Canvas fonts cannot use CSS variables, so take the resolved family from the page.
		family: getComputedStyle(document.body).fontFamily || "sans-serif",
	};
}

function text(ctx: CanvasRenderingContext2D, theme: Theme, value: string, x: number, y: number, options: { color?: string; size?: number; weight?: string; align?: CanvasTextAlign; baseline?: CanvasTextBaseline; halo?: boolean } = {}): void {
	ctx.font = `${options.weight ?? ""} ${options.size ?? 12}px ${theme.family}`;
	ctx.textAlign = options.align ?? "left";
	ctx.textBaseline = options.baseline ?? "alphabetic";
	if (options.halo) {
		ctx.lineWidth = 3;
		ctx.strokeStyle = theme.bg;
		ctx.lineJoin = "round";
		ctx.strokeText(value, x, y);
	}
	ctx.fillStyle = options.color ?? theme.fg;
	ctx.fillText(value, x, y);
}

function arrow(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string, width = 2, head = 8): void {
	const angle = Math.atan2(y2 - y1, x2 - x1);
	ctx.strokeStyle = color;
	ctx.fillStyle = color;
	ctx.lineWidth = width;
	ctx.beginPath();
	ctx.moveTo(x1, y1);
	ctx.lineTo(x2 - 0.6 * head * Math.cos(angle), y2 - 0.6 * head * Math.sin(angle));
	ctx.stroke();
	ctx.beginPath();
	ctx.moveTo(x2, y2);
	ctx.lineTo(x2 - head * Math.cos(angle - 0.45), y2 - head * Math.sin(angle - 0.45));
	ctx.lineTo(x2 - head * Math.cos(angle + 0.45), y2 - head * Math.sin(angle + 0.45));
	ctx.closePath();
	ctx.fill();
}

function polyline(ctx: CanvasRenderingContext2D, points: Array<[number, number]>, color: string, width: number, dash: number[] = []): void {
	if (points.length < 2) return;
	ctx.strokeStyle = color;
	ctx.lineWidth = width;
	ctx.lineJoin = "round";
	ctx.lineCap = "round";
	ctx.setLineDash(dash);
	ctx.beginPath();
	points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
	ctx.stroke();
	ctx.setLineDash([]);
}

/** A tracer particle with a short fading tail; coordinates are whatever the scene uses. */
type Tracer = { x: number; y: number; trail: Array<[number, number]>; age: number; life: number };

const TRAIL_LENGTH = 14;

function pushTrail(tracer: Tracer): void {
	tracer.trail.push([tracer.x, tracer.y]);
	if (tracer.trail.length > TRAIL_LENGTH) tracer.trail.shift();
}

/** Fade in after spawning and out before dying, so particles never pop in or out. */
function tracerAlpha(tracer: Tracer): number {
	return clamp(Math.min(tracer.age / 0.35, (tracer.life - tracer.age) / 0.35), 0, 1);
}

function drawTracers(ctx: CanvasRenderingContext2D, tracers: Tracer[], map: (x: number, y: number) => [number, number], color: string, radius = 2.4): void {
	ctx.lineCap = "round";
	for (const tracer of tracers) {
		const alpha = tracerAlpha(tracer);
		if (alpha <= 0) continue;
		const points = tracer.trail.map(([x, y]) => map(x, y));
		ctx.strokeStyle = color;
		ctx.lineWidth = radius * 1.1;
		for (let k = 1; k < points.length; k++) {
			ctx.globalAlpha = alpha * 0.55 * (k / points.length);
			ctx.beginPath();
			ctx.moveTo(points[k - 1][0], points[k - 1][1]);
			ctx.lineTo(points[k][0], points[k][1]);
			ctx.stroke();
		}
		const [px, py] = map(tracer.x, tracer.y);
		ctx.globalAlpha = alpha;
		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.arc(px, py, radius, 0, Math.PI * 2);
		ctx.fill();
	}
	ctx.globalAlpha = 1;
}

/* ------------------------------------------------------------------------------------------------------------ */
/* Scenes                                                                                                         */
/* ------------------------------------------------------------------------------------------------------------ */

interface Scene {
	/** Main equation in LaTeX, terms coloured like the drawing. */
	equation: string;
	/** Optional second, smaller equation (e.g. the general form). */
	secondary?: string;
	/** One or two sentences: what to look at and what to try. */
	note: string;
	legend: Array<{ color: string; label: string }>;
	/** Seconds of simulated time to run before the first frame so the picture is not empty. */
	warmup: number;
	reset(): void;
	step(dt: number): void;
	draw(ctx: CanvasRenderingContext2D, width: number, height: number, theme: Theme): void;
	values(): string[];
	pointer?(x: number, y: number, width: number, height: number): void;
}

type Params = Record<string, number>;

function poiseuilleScene(p: Params, config: FlowSceneConfig): Scene {
	const tracerCount = clamp(config.particles, 12, 60);
	let tracers: Tracer[] = [];
	let timelines: Array<{ xs: number[]; age: number }> = [];
	let sinceRelease = 0, probeR = 0.4;
	let geometry = { left: 0, right: 0, mid: 0, half: 1 };
	const LINE_POINTS = 25, RELEASE_EVERY = 1.6;
	// r/R of each dye point on a timeline, wall excluded (wall speed is exactly zero).
	const lineR = Array.from({ length: LINE_POINTS }, (_, k) => -0.97 + (1.94 * k) / (LINE_POINTS - 1));
	const speed = (r: number) => finiteOrDefault(p.umax, 2) * (1 - r * r);
	const pace = 0.07; // domain lengths per second per unit speed

	const spawn = (anywhere: boolean): Tracer => {
		const x = anywhere ? Math.random() : -0.02;
		// Re-enter with probability proportional to the local speed (the flux), otherwise slow particles near
		// the walls would pile up over time.
		let y = 0;
		do { y = (Math.random() * 2 - 1) * 0.94; } while (!anywhere && Math.random() > 1 - y * y);
		return { x, y, trail: [], age: anywhere ? Math.random() * 2 : 0, life: 1e9 };
	};

	return {
		equation: `${tc("orange", "u(r)")} = u_{\\max}\\left[1-\\left(\\dfrac{r}{R}\\right)^{2}\\right]`,
		note: "벽에서는 점착 조건 때문에 속도가 0이고, 관 중심에서 가장 빠르다. 같은 순간에 흘린 염료 선(보라)이 포물선으로 휘는 모양이 바로 속도 분포다. 그림을 누르면 그 반지름 위치의 속도(주황)를 읽는다.",
		legend: [
			{ color: TERM.purple, label: "염료 선 (같은 순간에 흘림)" },
			{ color: TERM.blue, label: "유체 입자" },
			{ color: TERM.orange, label: "탐침 속도" },
		],
		warmup: 5,
		reset() {
			tracers = Array.from({ length: tracerCount }, () => spawn(true));
			timelines = [];
			sinceRelease = RELEASE_EVERY;
		},
		step(dt) {
			sinceRelease += dt;
			if (sinceRelease >= RELEASE_EVERY) {
				sinceRelease = 0;
				timelines.push({ xs: lineR.map(() => 0), age: 0 });
			}
			for (const line of timelines) {
				line.age += dt;
				line.xs = line.xs.map((x, k) => x + pace * speed(lineR[k]) * dt);
			}
			timelines = timelines.filter(line => line.age < 14 && line.xs[Math.floor(LINE_POINTS / 2)] < 1.6);
			tracers = tracers.map(t => {
				t.x += pace * speed(t.y) * dt;
				t.age += dt;
				pushTrail(t);
				return t.x > 1.02 ? spawn(false) : t;
			});
		},
		draw(ctx, width, height, theme) {
			const profileWidth = config.showProfile && width > 460 ? 150 : 0;
			const left = 28, right = width - 28 - profileWidth, mid = height / 2;
			const half = (height / 2 - 34) * clamp(finiteOrDefault(p.R, 1) / 1.5, 0.35, 1);
			geometry = { left, right, mid, half };
			const X = (x: number) => left + x * (right - left), Y = (r: number) => mid + r * half;

			ctx.fillStyle = "rgba(47, 143, 216, 0.07)";
			ctx.fillRect(left, mid - half, right - left, 2 * half);
			ctx.save();
			ctx.beginPath();
			ctx.rect(left, mid - half, right - left, 2 * half);
			ctx.clip();
			for (const line of timelines) {
				ctx.globalAlpha = clamp(1.2 - line.age / 12, 0.15, 1);
				polyline(ctx, line.xs.map((x, k) => [X(x), Y(lineR[k])] as [number, number]), TERM.purple, 2.5);
			}
			ctx.globalAlpha = 1;
			drawTracers(ctx, tracers, (x, y) => [X(x), Y(y)], TERM.blue);
			ctx.restore();

			// Walls with hatching, so they read as solid boundaries.
			ctx.strokeStyle = theme.fg;
			ctx.lineWidth = 2.5;
			ctx.beginPath();
			ctx.moveTo(left, mid - half); ctx.lineTo(right, mid - half);
			ctx.moveTo(left, mid + half); ctx.lineTo(right, mid + half);
			ctx.stroke();
			ctx.lineWidth = 1;
			ctx.strokeStyle = theme.muted;
			for (let x = left + 6; x < right; x += 12) {
				ctx.beginPath();
				ctx.moveTo(x, mid - half); ctx.lineTo(x - 7, mid - half - 7);
				ctx.moveTo(x - 7, mid + half + 7); ctx.lineTo(x, mid + half);
				ctx.stroke();
			}
			polyline(ctx, [[left, mid], [right, mid]], theme.border, 1, [6, 6]);
			text(ctx, theme, "벽: u = 0", left + 4, mid - half - 12, { color: theme.muted, size: 12 });

			// Probe line across the pipe.
			const probeY = Y(probeR);
			polyline(ctx, [[left, probeY], [right, probeY]], TERM.orange, 1.2, [3, 4]);

			if (profileWidth) {
				const x0 = right + 34, scale = (profileWidth - 50) / 5;
				polyline(ctx, [[x0, mid - half], [x0, mid + half]], theme.muted, 1);
				for (let k = 0; k <= 8; k++) {
					const r = -1 + k / 4, u = speed(r);
					if (u > 0.02) arrow(ctx, x0, Y(r), x0 + u * scale, Y(r), TERM.blue, 1.6, 6);
				}
				const curve: Array<[number, number]> = [];
				for (let k = 0; k <= 40; k++) { const r = -1 + k / 20; curve.push([x0 + speed(r) * scale, Y(r)]); }
				polyline(ctx, curve, TERM.blue, 2);
				ctx.fillStyle = TERM.orange;
				ctx.beginPath();
				ctx.arc(x0 + speed(probeR) * scale, probeY, 5, 0, Math.PI * 2);
				ctx.fill();
				text(ctx, theme, "속도 분포 u(r)", x0 - 8, mid - half - 12, { size: 12, weight: "600" });
			}
		},
		values() {
			return ["", "", `r/R = ${formatNumber(Math.abs(probeR), 2)} → u = ${formatNumber(speed(probeR))}`];
		},
		pointer(_x, y) {
			probeR = clamp((y - geometry.mid) / Math.max(geometry.half, 1), -0.98, 0.98);
		},
	};
}

function materialDerivativeScene(p: Params): Scene {
	const OMEGA = 1.2, HISTORY = 8;
	let time = 0, particleX = 0.08, sensorX = 0.32;
	let history: Array<{ t: number; sensor: number; particle: number; wrapped: boolean }> = [];
	const U = () => finiteOrDefault(p.U, 1.2), G = () => finiteOrDefault(p.gradient, 0.8), A = () => finiteOrDefault(p.oscillation, 0.6);
	const phi = (x: number, t: number) => 2 * G() * (x - 0.5) + A() * Math.sin(OMEGA * t);
	const localRate = () => A() * OMEGA * Math.cos(OMEGA * time);
	const movingRate = () => 0.1 * U() * 2 * G();

	return {
		equation: `${tc("purple", "\\dfrac{D\\phi}{Dt}")} = ${tc("orange", "\\dfrac{\\partial \\phi}{\\partial t}")} + ${tc("blue", "u\\,\\dfrac{\\partial \\phi}{\\partial x}")}`,
		note: "제자리에 고정한 센서(주황)는 그 자리의 시간 변화만 읽는다. 흐름을 따라가는 입자(보라)는 거기에 더해, 움직이며 다른 값의 영역으로 들어가서 생기는 변화(파랑)까지 느낀다. 아래 그래프에서 두 기록을 비교해 보자. 그림을 누르면 센서를 옮긴다.",
		legend: [
			{ color: TERM.orange, label: "∂φ/∂t 제자리 변화" },
			{ color: TERM.blue, label: "u ∂φ/∂x 이동해서 생긴 변화" },
			{ color: TERM.purple, label: "Dφ/Dt 입자가 느끼는 변화" },
		],
		warmup: HISTORY,
		reset() {
			time = 0;
			particleX = 0.08;
			history = [];
		},
		step(dt) {
			time += dt;
			particleX += 0.1 * U() * dt;
			let wrapped = false;
			if (particleX > 0.96) { particleX = 0.04; wrapped = true; }
			history.push({ t: time, sensor: phi(sensorX, time), particle: phi(particleX, time), wrapped });
			while (history.length && history[0].t < time - HISTORY) history.shift();
		},
		draw(ctx, width, height, theme) {
			const left = 24, right = width - 24, bandTop = 34, bandBottom = Math.round(height * 0.5);
			const chartTop = bandBottom + 34, chartBottom = height - 22;
			const X = (x: number) => left + x * (right - left);
			const scale = Math.max(0.5, Math.abs(G()) + A());

			const columns = 64;
			for (let c = 0; c < columns; c++) {
				const x = (c + 0.5) / columns;
				ctx.fillStyle = rgb(divergingColor(clamp(phi(x, time) / scale, -1, 1)));
				ctx.fillRect(Math.floor(X(c / columns)), bandTop, Math.ceil((right - left) / columns) + 1, bandBottom - bandTop);
			}
			ctx.strokeStyle = theme.border;
			ctx.lineWidth = 1;
			ctx.strokeRect(left, bandTop, right - left, bandBottom - bandTop);
			text(ctx, theme, "φ 낮음", left, bandTop - 8, { color: theme.muted, size: 11 });
			text(ctx, theme, "φ 높음", right, bandTop - 8, { color: theme.muted, size: 11, align: "right" });
			if (Math.abs(G()) > 1e-6) text(ctx, theme, G() > 0 ? "→ 오른쪽으로 갈수록 φ가 커지는 장" : "→ 오른쪽으로 갈수록 φ가 작아지는 장", (left + right) / 2, bandTop - 8, { color: theme.muted, size: 11, align: "center" });

			const sx = X(sensorX), mid = (bandTop + bandBottom) / 2;
			ctx.strokeStyle = TERM.orange;
			ctx.lineWidth = 2;
			ctx.beginPath(); ctx.moveTo(sx, bandTop); ctx.lineTo(sx, bandBottom); ctx.stroke();
			ctx.fillStyle = TERM.orange;
			ctx.beginPath(); ctx.moveTo(sx - 7, bandTop - 2); ctx.lineTo(sx + 7, bandTop - 2); ctx.lineTo(sx, bandTop + 9); ctx.closePath(); ctx.fill();
			text(ctx, theme, "고정 센서", sx + 6, bandBottom - 8, { color: TERM.orange, size: 12, weight: "700", halo: true });

			const px = X(particleX);
			if (U() > 0.01) arrow(ctx, px + 12, mid, px + 12 + 16 + 10 * U(), mid, TERM.blue, 2.5);
			ctx.fillStyle = TERM.purple;
			ctx.strokeStyle = "#fff";
			ctx.lineWidth = 2;
			ctx.beginPath(); ctx.arc(px, mid, 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
			text(ctx, theme, "입자", px, mid - 16, { color: TERM.purple, size: 12, weight: "700", align: "center", halo: true });

			// History: what each observer recorded over the last few seconds.
			const T = (t: number) => left + (1 - (time - t) / HISTORY) * (right - left);
			const V = (v: number) => (chartTop + chartBottom) / 2 - (v / (scale * 1.1)) * ((chartBottom - chartTop) / 2);
			polyline(ctx, [[left, V(0)], [right, V(0)]], theme.border, 1);
			polyline(ctx, [[left, chartTop], [left, chartBottom]], theme.border, 1);
			text(ctx, theme, "지난 8초 동안 읽은 φ", left + 6, chartTop - 8, { color: theme.muted, size: 11 });
			polyline(ctx, history.map(h => [T(h.t), V(h.sensor)] as [number, number]), TERM.orange, 2.2);
			let segment: Array<[number, number]> = [];
			for (const h of history) {
				if (h.wrapped) { polyline(ctx, segment, TERM.purple, 2.2); segment = []; }
				segment.push([T(h.t), V(h.particle)]);
			}
			polyline(ctx, segment, TERM.purple, 2.2);
			text(ctx, theme, "지금", right, chartBottom + 14, { color: theme.muted, size: 11, align: "right" });
		},
		values() {
			return [formatNumber(localRate()), formatNumber(movingRate()), formatNumber(localRate() + movingRate())];
		},
		pointer(x, _y, width) {
			sensorX = clamp((x - 24) / Math.max(width - 48, 1), 0.02, 0.98);
			history = [];
		},
	};
}

function controlVolumeScene(p: Params): Scene {
	const SPEED = 110; // px per second along the pipes
	let level = 0.45, inParticles: number[] = [], outParticles: number[] = [], inCarry = 0, outCarry = 0, status = "";
	let geometry = { inLength: 200, outLength: 200 };
	const inflow = () => Math.max(0, finiteOrDefault(p.inflow, 1.1)), outflow = () => Math.max(0, finiteOrDefault(p.outflow, 0.8));

	return {
		equation: `${tc("purple", "\\dfrac{dm_{CV}}{dt}")} = ${tc("blue", "\\dot m_{in}")} - ${tc("orange", "\\dot m_{out}")}`,
		secondary: "\\frac{d}{dt}\\int_{CV}\\rho\\,dV + \\int_{CS}\\rho\\,(\\mathbf{V}\\cdot\\mathbf{n})\\,dA = 0",
		note: "검사체적 안 질량의 변화율은 들어온 양에서 나간 양을 뺀 값이다. 유입과 유출을 같게 맞추면 수위가 멈춘다(정상 상태). 아래 식은 이것을 일반화한 레이놀즈 전달 정리(질량 보존)다.",
		legend: [
			{ color: TERM.blue, label: "유입 ṁ_in" },
			{ color: TERM.orange, label: "유출 ṁ_out" },
			{ color: TERM.purple, label: "저장 dm/dt" },
		],
		warmup: 3,
		reset() {
			level = 0.45;
			inParticles = [];
			outParticles = [];
		},
		step(dt) {
			const net = inflow() - outflow();
			level += 0.06 * net * dt;
			status = level >= 0.95 && net > 0 ? "탱크가 가득 찼습니다 — 유출을 늘려 보세요" : level <= 0.04 && net < 0 ? "탱크가 비었습니다 — 유입을 늘려 보세요" : "";
			level = clamp(level, 0.04, 0.95);
			// Particles per second is proportional to the mass flow, so a denser stream means a larger flux.
			inCarry += 5 * inflow() * dt;
			while (inCarry >= 1) { inCarry -= 1; inParticles.push(Math.random() * 0.02); }
			const drained = level <= 0.04 && net < 0;
			outCarry += 5 * (drained ? inflow() : outflow()) * dt;
			while (outCarry >= 1) { outCarry -= 1; outParticles.push(Math.random() * 0.02); }
			inParticles = inParticles.map(s => s + (SPEED * dt) / geometry.inLength).filter(s => s < 1);
			outParticles = outParticles.map(s => s + (SPEED * dt) / geometry.outLength).filter(s => s < 1);
		},
		draw(ctx, width, height, theme) {
			const tx0 = width * 0.37, tx1 = width * 0.63, ty0 = 30, ty1 = height - 30;
			const pipe = 26, inY = ty0 + (ty1 - ty0) * 0.42, outY = ty1 - pipe / 2 - 10;
			geometry = { inLength: tx0 - 16, outLength: width - 16 - tx1 };

			// Pipes
			ctx.fillStyle = "rgba(127,127,127,0.08)";
			ctx.fillRect(16, inY - pipe / 2, tx0 - 16, pipe);
			ctx.fillRect(tx1, outY - pipe / 2, width - 16 - tx1, pipe);
			ctx.strokeStyle = theme.muted;
			ctx.lineWidth = 1.5;
			for (const [x0, x1, y] of [[16, tx0, inY], [tx1, width - 16, outY]]) {
				ctx.beginPath();
				ctx.moveTo(x0, y - pipe / 2); ctx.lineTo(x1, y - pipe / 2);
				ctx.moveTo(x0, y + pipe / 2); ctx.lineTo(x1, y + pipe / 2);
				ctx.stroke();
			}

			// Tank and water
			const waterTop = ty1 - level * (ty1 - ty0);
			ctx.fillStyle = "rgba(139, 92, 246, 0.16)";
			ctx.fillRect(tx0, waterTop, tx1 - tx0, ty1 - waterTop);
			polyline(ctx, [[tx0, waterTop], [tx1, waterTop]], TERM.purple, 2.5);
			ctx.strokeStyle = theme.fg;
			ctx.lineWidth = 2.5;
			ctx.beginPath();
			ctx.moveTo(tx0, ty0); ctx.lineTo(tx0, inY - pipe / 2);
			ctx.moveTo(tx0, inY + pipe / 2); ctx.lineTo(tx0, ty1); ctx.lineTo(tx1, ty1); ctx.lineTo(tx1, outY + pipe / 2);
			ctx.moveTo(tx1, outY - pipe / 2); ctx.lineTo(tx1, ty0);
			ctx.stroke();

			// Control volume: dashed box around the tank
			ctx.strokeStyle = theme.muted;
			ctx.lineWidth = 1.5;
			ctx.setLineDash([7, 5]);
			ctx.strokeRect(tx0 - 10, ty0 - 12, tx1 - tx0 + 20, ty1 - ty0 + 22);
			ctx.setLineDash([]);
			text(ctx, theme, "검사체적 (CV)", tx0 - 6, ty0 - 16, { color: theme.muted, size: 12 });

			for (const s of inParticles) {
				ctx.fillStyle = TERM.blue;
				ctx.beginPath(); ctx.arc(16 + s * (tx0 - 16), inY + Math.sin(s * 40) * 6, 3.4, 0, Math.PI * 2); ctx.fill();
			}
			for (const s of outParticles) {
				ctx.fillStyle = TERM.orange;
				ctx.beginPath(); ctx.arc(tx1 + s * (width - 16 - tx1), outY + Math.sin(s * 40) * 6, 3.4, 0, Math.PI * 2); ctx.fill();
			}
			text(ctx, theme, `ṁ_in = ${formatNumber(inflow())}`, 18, inY - pipe / 2 - 8, { color: TERM.blue, size: 13, weight: "700" });
			text(ctx, theme, `ṁ_out = ${formatNumber(outflow())}`, width - 18, outY - pipe / 2 - 8, { color: TERM.orange, size: 13, weight: "700", align: "right" });

			const net = inflow() - outflow(), cx = (tx0 + tx1) / 2;
			if (Math.abs(net) > 1e-3 && !status) arrow(ctx, cx, waterTop - (net > 0 ? 6 : 34), cx, waterTop - (net > 0 ? 34 : 6), TERM.purple, 3, 10);
			text(ctx, theme, `dm/dt = ${net > 0 ? "+" : ""}${formatNumber(net)}`, cx, Math.max(ty0 + 16, waterTop - 42), { color: TERM.purple, size: 13, weight: "700", align: "center", halo: true });
			if (Math.abs(net) <= 1e-3) text(ctx, theme, "정상 상태: 수위 일정", cx, waterTop + 20, { color: TERM.purple, size: 12, align: "center", halo: true });
			if (status) text(ctx, theme, status, width / 2, height - 10, { color: TERM.red, size: 12, weight: "600", align: "center", halo: true });
		},
		values() {
			const net = inflow() - outflow();
			return [formatNumber(inflow()), formatNumber(outflow()), `${net > 0 ? "+" : ""}${formatNumber(net)}`];
		},
	};
}

/**
 * The "flapping hose": u is constant and the cross-stream velocity travels downstream as a wave,
 * v = V0 sin(ω(t − x/u)). A particle keeps the v it left the nozzle with, so its pathline is straight; the dye
 * that left at different moments spreads into a growing wave (streakline); and the instantaneous streamlines
 * are a wave of fixed amplitude. With a spatially uniform v(t) the three curves would look almost alike.
 */
function streakScene(p: Params): Scene {
	const OMEGA = 1.0, RELEASE = 0.04, SOURCE_X = 0.05;
	let time = 0, sinceRelease = 0, sourceY = 0.5;
	let dye: Array<[number, number]> = [];
	let tagged = { x: SOURCE_X, y: sourceY, path: [] as Array<[number, number]> };
	// The previous particle's finished pathline stays on screen (faded) while the next one starts.
	let previousPath: Array<[number, number]> = [];
	const u = () => 0.12 * Math.max(finiteOrDefault(p.U, 1), 0.05);
	const amplitude = () => 0.04 * finiteOrDefault(p.unsteady, 0.9);
	const v = (x: number, t: number) => amplitude() * Math.sin(OMEGA * (t - (x - SOURCE_X) / u()));
	const reset = () => {
		time = 0;
		dye = [];
		tagged = { x: SOURCE_X, y: sourceY, path: [] };
		previousPath = [];
	};
	const advance = (point: [number, number], dt: number): [number, number] => [point[0] + u() * dt, point[1] + v(point[0], time) * dt];

	return {
		equation: `${tc("blue", "\\left.\\dfrac{dy}{dx}\\right|_{t} = \\dfrac{v}{u}")} \\qquad ${tc("orange", "\\dfrac{d\\mathbf{x}_p}{dt} = \\mathbf{V}(\\mathbf{x}_p, t)")}`,
		secondary: "u = U, \\qquad v = V_0 \\sin\\!\\big[\\omega\\,(t - x/U)\\big]",
		note: "호스를 위아래로 흔들며 물을 뿌리는 것과 같은 비정상 유동이다. 한 입자는 떠날 때의 방향 그대로 직선으로 날아간다(유적선, 주황). 그런데 주입점을 지난 입자들을 이으면 점점 크게 출렁이는 물줄기가 된다(유맥선, 보라). 지금 순간의 속도 방향을 이은 유선(파랑)은 또 다른 물결이다. 비정상성을 0으로 내리면 세 선이 한 직선으로 겹친다.",
		legend: [
			{ color: TERM.blue, label: "유선 — 지금 순간의 속도 방향" },
			{ color: TERM.orange, label: "유적선 — 한 입자의 궤적" },
			{ color: TERM.purple, label: "유맥선 — 주입점을 지난 입자들" },
		],
		warmup: 9,
		reset,
		step(dt) {
			time += dt;
			dye = dye.map(point => advance(point, dt)).filter(([x]) => x < 1.02);
			sinceRelease += dt;
			while (sinceRelease >= RELEASE) { sinceRelease -= RELEASE; dye.push([SOURCE_X, sourceY]); }
			[tagged.x, tagged.y] = advance([tagged.x, tagged.y], dt);
			tagged.path.push([tagged.x, tagged.y]);
			if (tagged.x > 1.02) {
				previousPath = [[SOURCE_X, sourceY], ...tagged.path];
				tagged = { x: SOURCE_X, y: sourceY, path: [] };
			}
		},
		draw(ctx, width, height, theme) {
			const left = 18, right = width - 18, top = 18, bottom = height - 18;
			const X = (x: number) => left + x * (right - left), Y = (y: number) => bottom - y * (bottom - top);
			ctx.save();
			ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();

			// Streamlines right now: dy/dx = v/u integrates to y = c + (V0/ω) cos(ω(t − x/U)).
			ctx.globalAlpha = 0.55;
			for (let k = -1; k <= 8; k++) {
				const c = k / 7;
				const points: Array<[number, number]> = [];
				for (let i = 0; i <= 120; i++) {
					const x = i / 120;
					points.push([X(x), Y(c + (amplitude() / OMEGA) * Math.cos(OMEGA * (time - (x - SOURCE_X) / u())))]);
				}
				polyline(ctx, points, TERM.blue, 1.4);
				const i = 84, [ax, ay] = points[i], [bx, by] = points[i + 2];
				arrow(ctx, ax, ay, bx + (bx - ax) * 2, by + (by - ay) * 2, TERM.blue, 1.4, 7);
			}
			ctx.globalAlpha = 1;

			polyline(ctx, dye.map(([x, y]) => [X(x), Y(y)] as [number, number]).reverse(), TERM.purple, 3.5);
			ctx.globalAlpha = 0.4;
			polyline(ctx, previousPath.map(([x, y]) => [X(x), Y(y)] as [number, number]), TERM.orange, 2.5, [7, 4]);
			ctx.globalAlpha = 1;
			polyline(ctx, [[X(SOURCE_X), Y(sourceY)], ...tagged.path.map(([x, y]) => [X(x), Y(y)] as [number, number])], TERM.orange, 2.5, [7, 4]);
			ctx.fillStyle = TERM.orange;
			ctx.strokeStyle = "#fff";
			ctx.lineWidth = 2;
			ctx.beginPath(); ctx.arc(X(tagged.x), Y(tagged.y), 6.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
			ctx.restore();

			// Dye nozzle
			const nx = X(SOURCE_X), ny = Y(sourceY);
			ctx.fillStyle = theme.fg;
			ctx.fillRect(nx - 16, ny - 4, 14, 8);
			ctx.beginPath(); ctx.arc(nx, ny, 5, 0, Math.PI * 2); ctx.fill();
			text(ctx, theme, "주입점", nx - 12, ny - 12, { color: theme.fg, size: 12, weight: "600", halo: true });
			text(ctx, theme, "그림을 눌러 주입점을 옮길 수 있습니다", right - 4, bottom - 6, { color: theme.muted, size: 11, align: "right", halo: true });
		},
		values() {
			return ["", "", ""];
		},
		pointer(_x, y, _width, height) {
			sourceY = clamp(1 - (y - 18) / Math.max(height - 36, 1), 0.2, 0.8);
			reset();
		},
	};
}

function bernoulliScene(p: Params, config: FlowSceneConfig): Scene {
	const Z0 = 0.7, P_IN = 1, K = 0.1;
	let probeX = 0.5;
	let tracers: Tracer[] = [];
	const area = (x: number) => clamp(1 - clamp(finiteOrDefault(p.constriction, 0.48), 0.05, 0.9) * Math.exp(-Math.pow((x - 0.5) / 0.16, 2)), 0.1, 1);
	const Q = () => finiteOrDefault(p.flow, 1);
	const zRise = () => finiteOrDefault(p.zRise, 0.25);
	const velocityHead = (x: number) => K * Math.pow(Q() / area(x), 2);
	const elevation = (x: number) => Z0 + zRise() * x;
	const total = () => Z0 + P_IN + K * Q() * Q();
	const pressureHead = (x: number) => total() - elevation(x) - velocityHead(x);
	const tracerCount = clamp(config.particles, 12, 60);
	const spawn = (anywhere: boolean): Tracer => ({ x: anywhere ? Math.random() : -0.01, y: (Math.random() * 2 - 1) * 0.8, trail: [], age: anywhere ? Math.random() : 0, life: 1e9 });

	return {
		equation: `${tc("orange", "\\dfrac{p}{\\rho g}")} + ${tc("blue", "\\dfrac{V^{2}}{2g}")} + ${tc("green", "z")} = ${tc("purple", "H")} = \\text{const}`,
		note: "좁은 목에서는 속도가 빨라져 속도수두(파랑)가 커지고, 그만큼 압력수두(주황)가 줄어든다. 손실을 무시하면 전수두 H(보라 점선, 에너지선)는 어디서나 같다. 그림을 누르면 그 위치의 수두 기둥을 읽는다.",
		legend: [
			{ color: TERM.green, label: "위치수두 z" },
			{ color: TERM.orange, label: "압력수두 p/ρg" },
			{ color: TERM.blue, label: "속도수두 V²/2g" },
			{ color: TERM.purple, label: "전수두 H" },
		],
		warmup: 3,
		reset() {
			tracers = Array.from({ length: tracerCount }, () => spawn(true));
		},
		step(dt) {
			tracers = tracers.map(t => {
				// The along-pipe speed is V = Q/A, so particles visibly speed up through the throat.
				t.x += 0.045 * Math.min(Q() / area(clamp(t.x, 0, 1)), 12) * dt;
				t.age += dt;
				pushTrail(t);
				return t.x > 1.01 ? spawn(false) : t;
			});
		},
		draw(ctx, width, height, theme) {
			const left = 26, right = width - 96, datum = height - 26, top = 24;
			const headMax = Math.max(total(), Z0 + Math.max(0, zRise())) * 1.12;
			const X = (x: number) => left + x * (right - left);
			const Y = (head: number) => datum - (head / headMax) * (datum - top);
			const radius = (x: number) => area(x) * Math.min(24, (datum - top) * 0.09);
			const samples = Array.from({ length: 81 }, (_, k) => k / 80);

			// Datum
			polyline(ctx, [[left - 10, datum], [width - 10, datum]], theme.muted, 1, [4, 4]);
			text(ctx, theme, "기준면 z = 0", left - 8, datum + 16, { color: theme.muted, size: 11 });

			// Pipe (drawn at its real elevation in the same scale as the heads)
			ctx.fillStyle = "rgba(47, 143, 216, 0.08)";
			ctx.beginPath();
			samples.forEach((x, k) => (k === 0 ? ctx.moveTo(X(x), Y(elevation(x)) - radius(x)) : ctx.lineTo(X(x), Y(elevation(x)) - radius(x))));
			[...samples].reverse().forEach(x => ctx.lineTo(X(x), Y(elevation(x)) + radius(x)));
			ctx.closePath();
			ctx.fill();
			polyline(ctx, samples.map(x => [X(x), Y(elevation(x)) - radius(x)] as [number, number]), theme.fg, 2);
			polyline(ctx, samples.map(x => [X(x), Y(elevation(x)) + radius(x)] as [number, number]), theme.fg, 2);
			drawTracers(ctx, tracers, (x, y) => { const xc = clamp(x, 0, 1); return [X(x), Y(elevation(xc)) + y * radius(xc)]; }, TERM.blue, 2.2);

			// Energy grade line (constant) and hydraulic grade line (z + p/ρg).
			polyline(ctx, [[left, Y(total())], [right, Y(total())]], TERM.purple, 2, [8, 5]);
			text(ctx, theme, "에너지선 H", right + 6, Y(total()) - 4, { color: TERM.purple, size: 12, weight: "600" });
			const hgl = samples.map(x => [X(x), Math.min(datum, Y(elevation(x) + pressureHead(x)))] as [number, number]);
			polyline(ctx, hgl, TERM.orange, 2);
			text(ctx, theme, "수력구배선", right + 6, Math.max(hgl[hgl.length - 1][1] + 14, Y(total()) + 16), { color: TERM.orange, size: 12, weight: "600" });

			// Head columns: inlet, outlet and the probe.
			const column = (x: number, strong: boolean) => {
				const cx = X(x), w = strong ? 16 : 10, z = elevation(x), pHead = pressureHead(x);
				ctx.globalAlpha = strong ? 1 : 0.55;
				ctx.fillStyle = TERM.green;
				ctx.fillRect(cx - w / 2, Y(z), w, datum - Y(z));
				if (pHead >= 0) {
					ctx.fillStyle = TERM.orange;
					ctx.fillRect(cx - w / 2, Y(z + pHead), w, Y(z) - Y(z + pHead));
				} else {
					ctx.strokeStyle = TERM.red;
					ctx.lineWidth = 2;
					ctx.strokeRect(cx - w / 2, Y(z), w, Math.min(datum, Y(z + pHead)) - Y(z));
				}
				ctx.fillStyle = TERM.blue;
				ctx.fillRect(cx - w / 2, Y(total()), w, Y(z + Math.max(pHead, 0)) - Y(total()));
				ctx.globalAlpha = 1;
				if (strong) {
					ctx.strokeStyle = theme.fg;
					ctx.lineWidth = 1;
					ctx.strokeRect(cx - w / 2, Y(total()), w, datum - Y(total()));
					const label = (value: string, y: number, color: string) => text(ctx, theme, value, cx + w / 2 + 5, y + 4, { color, size: 12, weight: "600", halo: true });
					label("z", (Y(z) + datum) / 2, TERM.green);
					if (pHead > 0.05) label("p/ρg", (Y(z) + Y(z + pHead)) / 2, TERM.orange);
					label("V²/2g", (Y(total()) + Y(z + Math.max(pHead, 0))) / 2, TERM.blue);
				}
			};
			column(0.06, false);
			column(0.94, false);
			column(probeX, true);

			if (pressureHead(probeX) < 0) {
				text(ctx, theme, "압력수두 < 0 : 실제로는 여기서 공동(캐비테이션)이 생긴다", left, top - 6, { color: TERM.red, size: 12, weight: "600", halo: true });
			}
		},
		values() {
			return [formatNumber(elevation(probeX)), formatNumber(pressureHead(probeX)), formatNumber(velocityHead(probeX)), formatNumber(total())];
		},
		pointer(x, _y, width) {
			probeX = clamp((x - 26) / Math.max(width - 122, 1), 0.02, 0.98);
		},
	};
}

function createScene(config: FlowSceneConfig, params: Params): Scene {
	switch (config.type) {
		case "material-derivative": return materialDerivativeScene(params);
		case "control-volume-flux": return controlVolumeScene(params);
		case "streamline-pathline-streakline": return streakScene(params);
		case "bernoulli-streamtube": return bernoulliScene(params, config);
		case "pipe-poiseuille":
		default: return poiseuilleScene(params, config);
	}
}

const TITLES: Record<FlowSceneType, string> = {
	"pipe-poiseuille": "원관 속 층류 (하겐–푸아죄유)",
	"material-derivative": "물질 도함수: 센서와 입자",
	"control-volume-flux": "검사체적의 질량 보존",
	"streamline-pathline-streakline": "유선 · 유적선 · 유맥선",
	"bernoulli-streamtube": "벤투리관의 베르누이 수두",
};

/* ------------------------------------------------------------------------------------------------------------ */
/* Card                                                                                                           */
/* ------------------------------------------------------------------------------------------------------------ */

export function renderFlowScene(el: HTMLElement, config: FlowSceneConfig): void {
	el.empty();
	const params: Params = Object.fromEntries(Object.entries(config.params).map(([name, param]) => [name, param.value]));
	const scene = createScene(config, params);
	const state = { playing: config.autoplay };
	const idPrefix = `flow-scene-${Math.random().toString(36).slice(2)}`;

	const card = el.createDiv({ cls: "formulalab-card flow-scene-card" });
	const header = card.createDiv({ cls: "formulalab-header" });
	header.createEl("h4", { text: config.title ?? TITLES[config.type] });
	header.createSpan({ cls: "formulalab-mode", text: "유동 장면" });

	const equation = card.createDiv({ cls: "flow-scene-equation-panel" });
	renderTex(equation.createDiv({ cls: "flow-scene-equation" }), scene.equation, true);
	if (scene.secondary) renderTex(equation.createDiv({ cls: "flow-scene-equation-secondary" }), scene.secondary, true);
	equation.createDiv({ cls: "flow-scene-equation-interpretation", text: scene.note });

	const controls = card.createDiv({ cls: "formulalab-controls flow-scene-controls" });
	for (const [name, param] of Object.entries(config.params)) {
		const slider = createSlider(controls, { id: `${idPrefix}-${name}`, label: param.label ?? name, ...param });
		slider.input.addEventListener("input", () => {
			params[name] = Number(slider.input.value);
			slider.value.setText(formatNumber(params[name]));
			draw();
		});
	}

	const toolbar = card.createDiv({ cls: "cfd-buttons flow-scene-toolbar-row" });
	const play = createButton(toolbar, "", () => { state.playing = !state.playing; loop.wake(); draw(); });
	createButton(toolbar, "처음부터", () => { scene.reset(); warm(); draw(); });

	const setValues = createLegend(card, scene.legend);
	const canvasWrap = card.createDiv({ cls: "flow-scene-canvas-wrap" });
	const canvas = canvasWrap.createEl("canvas", { cls: "flow-scene-canvas", attr: { "aria-label": TITLES[config.type] } });

	let theme = readTheme(), themeAge = 0;
	function draw(): void {
		if (!card.isConnected && themeAge > 0) return;
		const wrapWidth = canvasWrap.clientWidth || 640;
		const { ctx, width, height } = fitCanvas(canvas, Math.round(clamp(wrapWidth * 0.55, 240, config.height)));
		ctx.clearRect(0, 0, width, height);
		scene.draw(ctx, width, height, theme);
		scene.values().forEach((value, k) => setValues[k]?.(value));
		play.setText(state.playing ? "⏸ 멈춤" : "▶ 재생");
	}
	function warm(): void {
		for (let t = 0; t < scene.warmup; t += 1 / 30) scene.step(1 / 30);
	}

	const loop = animationLoop(card, elapsed => {
		// Re-read theme colours about once a second so switching light/dark mode is picked up.
		themeAge += elapsed;
		if (themeAge > 1000) { theme = readTheme(); themeAge = 1; }
		scene.step(Math.min(elapsed, 50) / 1000);
		draw();
	}, () => state.playing);

	const onPointer = (event: PointerEvent) => {
		if (!scene.pointer) return;
		const rect = canvas.getBoundingClientRect();
		scene.pointer(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
		draw();
	};
	let dragging = false;
	canvas.addEventListener("pointerdown", event => { dragging = true; canvas.setPointerCapture(event.pointerId); onPointer(event); });
	canvas.addEventListener("pointermove", event => { if (dragging) onPointer(event); });
	canvas.addEventListener("pointerup", () => { dragging = false; });
	canvas.addEventListener("pointercancel", () => { dragging = false; });
	if (!scene.pointer) canvas.style.cursor = "default";

	new ResizeObserver(() => { if (card.isConnected) draw(); }).observe(canvasWrap);
	scene.reset();
	warm();
	draw();
	themeAge = 1;
	if (state.playing) loop.wake();
}
