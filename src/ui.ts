export type SliderElements = {
	input: HTMLInputElement;
	value: HTMLElement;
};

export function createSlider(
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

export function createSelect<T extends string>(
	container: HTMLElement,
	label: string,
	options: Array<[T, string]>,
	value: T,
	onChange: (value: T) => void
): HTMLSelectElement {
	const row = container.createDiv({ cls: "formulalab-slider-row" });
	row.createEl("label", { cls: "formulalab-slider-label" }).createSpan({ text: label });
	const select = row.createEl("select", { cls: "formulalab-select dropdown", attr: { "aria-label": label } });
	for (const [optionValue, text] of options) select.createEl("option", { text, value: optionValue });
	select.value = value;
	select.addEventListener("change", () => onChange(select.value as T));
	return select;
}

export function createButton(container: HTMLElement, text: string, onClick: () => void, title?: string): HTMLButtonElement {
	const button = container.createEl("button", { cls: "formulalab-button", text, attr: { type: "button", ...(title ? { title } : {}) } });
	button.addEventListener("click", onClick);
	return button;
}

export function createToggle(container: HTMLElement, text: string, checked: boolean, onChange: (checked: boolean) => void): HTMLInputElement {
	const label = container.createEl("label", { cls: "formulalab-toggle" });
	const input = label.createEl("input", { type: "checkbox" });
	input.checked = checked;
	label.createSpan({ text });
	input.addEventListener("change", () => onChange(input.checked));
	return input;
}

/** Slider bound to a numeric setter, with the value label kept in sync. */
export function bindSlider(
	container: HTMLElement,
	id: string,
	label: string,
	range: { value: number; min: number; max: number; step: number },
	onInput: (value: number) => void,
	format: (value: number) => string = formatNumber
): SliderElements {
	const slider = createSlider(container, { id, label, ...range });
	slider.value.setText(format(range.value));
	slider.input.addEventListener("input", () => {
		const value = Number(slider.input.value);
		slider.value.setText(format(value));
		onInput(value);
	});
	return slider;
}

const VIRIDIS: Array<[number, number, number]> = [[68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142], [31, 158, 137], [53, 183, 121], [109, 205, 89], [180, 222, 44], [253, 231, 37]];
const COOLWARM: Array<[number, number, number]> = [[59, 76, 192], [98, 130, 234], [141, 176, 254], [184, 208, 249], [221, 221, 221], [245, 196, 173], [244, 154, 123], [222, 96, 77], [180, 4, 38]];

function lookup(stops: Array<[number, number, number]>, t: number): [number, number, number] {
	const x = clamp(Number.isFinite(t) ? t : 0, 0, 1) * (stops.length - 1), i = Math.min(Math.floor(x), stops.length - 2), f = x - i;
	const a = stops[i], b = stops[i + 1];
	return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** Sequential colour for t in [0, 1]. */
export function sequentialColor(t: number): [number, number, number] { return lookup(VIRIDIS, t); }
/** Diverging colour for t in [-1, 1], white at zero. */
export function divergingColor(t: number): [number, number, number] { return lookup(COOLWARM, (t + 1) / 2); }
export function rgb([r, g, b]: [number, number, number], alpha = 1): string { return `rgba(${r | 0},${g | 0},${b | 0},${alpha})`; }

/** Canvas sized to its container width (CSS px) and the device pixel ratio; returns the drawing context in CSS px. */
export function fitCanvas(canvas: HTMLCanvasElement, cssHeight: number): { ctx: CanvasRenderingContext2D; width: number; height: number } {
	const width = Math.max(240, canvas.parentElement?.clientWidth || 600), ratio = window.devicePixelRatio || 1;
	if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(cssHeight * ratio)) {
		canvas.width = Math.round(width * ratio);
		canvas.height = Math.round(cssHeight * ratio);
		canvas.style.height = `${cssHeight}px`;
	}
	const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
	ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
	return { ctx, width, height: cssHeight };
}

/**
 * requestAnimationFrame loop that only runs while `playing()` is true and the card is on screen,
 * and stops for good once the card leaves the document (note re-rendered or closed).
 */
export function animationLoop(card: HTMLElement, frame: (elapsedMs: number) => void, playing: () => boolean): { wake: () => void } {
	let visible = true, handle = 0, last = 0;
	const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
		visible = entries.some(entry => entry.isIntersecting);
		if (visible) wake();
	});
	observer?.observe(card);
	const tick = (now: number) => {
		handle = 0;
		if (!card.isConnected) { observer?.disconnect(); return; }
		if (!playing() || !visible) return;
		frame(last ? Math.min(now - last, 100) : 16);
		last = now;
		handle = requestAnimationFrame(tick);
	};
	const wake = () => { if (!handle) { last = 0; handle = requestAnimationFrame(tick); } };
	return { wake };
}

export function renderError(el: HTMLElement, message: string): void {
	el.empty();
	const card = el.createDiv({ cls: "formulalab-card formulalab-error-card" });
	card.createEl("strong", { text: "FormulaLab error" });
	card.createEl("pre", { text: message });
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

export function formatNumber(value: number): string {
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

export function getThemeColor(variableName: string): string {
	return getComputedStyle(document.body).getPropertyValue(variableName).trim() || "rgba(127,127,127,0.25)";
}

export function toNumber(value: unknown): number {
	if (typeof value === "number") {
		return value;
	}

	if (typeof value === "string" && value.trim() !== "") {
		return Number(value);
	}

	return Number.NaN;
}

export function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function finiteOrDefault(value: unknown, defaultValue: number): number {
	const number = toNumber(value);
	return Number.isFinite(number) ? number : defaultValue;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
