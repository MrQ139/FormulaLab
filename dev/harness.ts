import "./obsidian-shim";
import { parseCfdCellsConfig, renderCfdCells } from "../src/views/cfdCells";
import { parseFlowSceneConfig, renderFlowScene } from "../src/views/flowScene";
import { parseFormulaLabConfig, renderFormulaLab, validateConfig } from "../src/views/formulaLab";
import { parseNs2DConfig, renderNs2D } from "../src/views/ns2dView";
import { renderError, getErrorMessage, setMathRenderer } from "../src/ui";

// Obsidian typesets with MathJax 3; index.html loads the same library from a CDN.
type MathJaxApi = { tex2svg?: (tex: string, options: { display: boolean }) => HTMLElement };
setMathRenderer((tex, display) => {
	const mathJax = (window as unknown as { MathJax?: MathJaxApi }).MathJax;
	if (!mathJax?.tex2svg) throw new Error("MathJax not loaded");
	return mathJax.tex2svg(tex, { display });
});

// Renders every <pre data-block="..."> on the page the way Obsidian would render the code block.
// ?only=<index> renders just one block, which keeps screenshots small; ?dark=1 switches the theme variables.
const query = new URLSearchParams(location.search);
const only = query.get("only");
if (query.get("dark")) document.body.classList.add("theme-dark");
void (async () => {
	const mathJax = (window as unknown as { MathJax?: { startup?: { promise?: Promise<unknown> }; svgStylesheet?: () => HTMLElement } }).MathJax;
	await mathJax?.startup?.promise?.catch(() => undefined);
	// tex2svg output needs MathJax's stylesheet, or the hidden assistive copy of each formula shows as well.
	if (mathJax?.svgStylesheet) document.head.appendChild(mathJax.svgStylesheet());
	for (const [index, pre] of Array.from(document.querySelectorAll<HTMLPreElement>("pre[data-block]")).entries()) {
		if (only !== null && String(index) !== only) {
			pre.previousElementSibling?.remove();
			continue;
		}
		const host = document.createElement("div");
		pre.after(host);
		const source = pre.textContent ?? "";
		try {
			switch (pre.dataset.block) {
				case "formulalab": {
					const math = await import("mathjs");
					const config = parseFormulaLabConfig(source);
					const errors = validateConfig(config, math);
					if (errors.length) throw new Error(errors.join("\n"));
					renderFormulaLab(host, config, math);
					break;
				}
				case "flow-scene": renderFlowScene(host, parseFlowSceneConfig(source)); break;
				case "cfd-cells": renderCfdCells(host, parseCfdCellsConfig(source)); break;
				case "ns2d": renderNs2D(host, parseNs2DConfig(source)); break;
			}
		} catch (error) {
			renderError(host, getErrorMessage(error));
		}
	}
	(window as unknown as { harnessDone: boolean }).harnessDone = true;
})();
