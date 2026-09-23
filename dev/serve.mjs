// Static server for the visual harness: `npm run harness`, then open http://localhost:5178/dev/index.html
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

// POST /snap?name=x with a PNG data URL saves the canvas to <tmp>/formulalab-snaps/x.png for visual review.
const snapDir = join(tmpdir(), "formulalab-snaps");

const root = fileURLToPath(new URL("..", import.meta.url));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const port = Number(process.env.PORT || 5178);

createServer(async (req, res) => {
	const url = new URL(req.url, "http://localhost");
	if (req.method === "POST" && url.pathname === "/snap") {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const name = (url.searchParams.get("name") || "snap").replace(/[^a-z0-9_-]/gi, "_");
		await mkdir(snapDir, { recursive: true });
		await writeFile(join(snapDir, `${name}.png`), Buffer.from(Buffer.concat(chunks).toString().replace(/^data:image\/png;base64,/, ""), "base64"));
		res.writeHead(204).end();
		return;
	}
	const path =normalize(decodeURIComponent(new URL(req.url, "http://localhost").pathname)).replace(/^([/\\])+/, "");
	if (path.startsWith("..")) { res.writeHead(403).end(); return; }
	try {
		const body = await readFile(join(root, path || "dev/index.html"));
		res.writeHead(200, { "Content-Type": types[extname(path)] || "application/octet-stream", "Cache-Control": "no-store" }).end(body);
	} catch {
		res.writeHead(404).end("not found");
	}
}).listen(port, () => console.log(`harness on http://localhost:${port}/dev/index.html`));
