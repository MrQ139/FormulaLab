import "./obsidian-shim";
import { parseCfdCellsConfig, renderCfdCells } from "../src/views/cfdCells";
import { parseNs2DConfig, renderNs2D } from "../src/views/ns2dView";
import { renderError, getErrorMessage } from "../src/ui";

// Renders every <pre data-block="..."> on the page the way Obsidian would render the code block.
for (const pre of Array.from(document.querySelectorAll<HTMLPreElement>("pre[data-block]"))) {
	const host = document.createElement("div");
	pre.after(host);
	try {
		if (pre.dataset.block === "cfd-cells") renderCfdCells(host, parseCfdCellsConfig(pre.textContent ?? ""));
		else if (pre.dataset.block === "ns2d") renderNs2D(host, parseNs2DConfig(pre.textContent ?? ""));
	} catch (error) {
		renderError(host, getErrorMessage(error));
	}
}
