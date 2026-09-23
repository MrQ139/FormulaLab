// Minimal stand-ins for the DOM helpers Obsidian adds to HTMLElement, so views can run in a plain browser page.
type ElOptions = { cls?: string; text?: string; attr?: Record<string, string>; type?: string; value?: string } | string;

declare global {
	interface HTMLElement {
		createEl<K extends keyof HTMLElementTagNameMap>(tag: K, options?: ElOptions): HTMLElementTagNameMap[K];
		createDiv(options?: ElOptions): HTMLDivElement;
		createSpan(options?: ElOptions): HTMLSpanElement;
		empty(): void;
		setText(text: string): void;
		toggleClass(cls: string, value: boolean): void;
	}
}

const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
proto.createEl = function (this: HTMLElement, tag: string, options?: ElOptions) {
	const el = document.createElement(tag);
	const o = typeof options === "string" ? { cls: options } : options ?? {};
	if (o.cls) el.className = o.cls;
	if (o.text !== undefined) el.textContent = o.text;
	if (o.type) el.setAttribute("type", o.type);
	if (o.value !== undefined) (el as HTMLInputElement).value = o.value;
	for (const [k, v] of Object.entries(o.attr ?? {})) el.setAttribute(k, v);
	this.appendChild(el);
	return el;
};
proto.createDiv = function (this: HTMLElement, options?: ElOptions) { return this.createEl("div", options); };
proto.createSpan = function (this: HTMLElement, options?: ElOptions) { return this.createEl("span", options); };
proto.empty = function (this: HTMLElement) { while (this.firstChild) this.removeChild(this.firstChild); };
proto.setText = function (this: HTMLElement, text: string) { this.textContent = text; };
proto.toggleClass = function (this: HTMLElement, cls: string, value: boolean) { this.classList.toggle(cls, value); };

export {};
