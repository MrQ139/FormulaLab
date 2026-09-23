import { strict as assert } from "node:assert";
import { advectStep, Diffusion2D, exactConvectionDiffusion, pulse, solveConvectionDiffusion } from "../src/solvers/fvm";
import { GHIA_CAVITY_U, Ns2D } from "../src/solvers/ns2d";

const results: string[] = [];
function test(name: string, body: () => void): void {
	const start = Date.now();
	body();
	results.push(`ok  ${name} (${Date.now() - start} ms)`);
}

test("central scheme reproduces Versteeg & Malalasekera Example 5.1 (u = 0.1, 5 cells)", () => {
	const r = solveConvectionDiffusion({ n: 5, length: 1, rho: 1, u: 0.1, gamma: 0.1, phiA: 1, phiB: 0, scheme: "central" });
	const expected = [0.9421, 0.8006, 0.6276, 0.4163, 0.1579];
	r.cells.forEach((cell, i) => assert.ok(Math.abs(cell.phi - expected[i]) < 5e-4, `cell ${i}: ${cell.phi}`));
	assert.equal(r.cells[0].aP.toFixed(2), "1.55");
	assert.equal(r.cells[4].aP.toFixed(2), "1.45");
});

test("central scheme wiggles and gets a negative coefficient when the cell Péclet number exceeds 2", () => {
	const r = solveConvectionDiffusion({ n: 5, length: 1, rho: 1, u: 2.5, gamma: 0.1, phiA: 1, phiB: 0, scheme: "central" });
	assert.ok(r.cellPeclet > 2 && r.hasNegativeCoefficient);
	assert.ok(r.cells.some(c => c.phi > 1.01 || c.phi < -0.01), "expected unbounded values");
	const upwind = solveConvectionDiffusion({ n: 5, length: 1, rho: 1, u: 2.5, gamma: 0.1, phiA: 1, phiB: 0, scheme: "upwind" });
	assert.ok(upwind.cells.every(c => c.phi <= 1 && c.phi >= 0), "upwind stays bounded");
});

test("every scheme converges to the exact solution on a fine grid", () => {
	for (const scheme of ["central", "upwind", "hybrid", "power-law"] as const) {
		const coarse = solveConvectionDiffusion({ n: 20, length: 1, rho: 1, u: 1, gamma: 0.1, phiA: 1, phiB: 0, scheme });
		const fine = solveConvectionDiffusion({ n: 320, length: 1, rho: 1, u: 1, gamma: 0.1, phiA: 1, phiB: 0, scheme });
		assert.ok(fine.maxError < coarse.maxError && fine.maxError < 0.02, `${scheme}: ${coarse.maxError} -> ${fine.maxError}`);
	}
	const setup = { n: 1, length: 1, rho: 1, u: 1, gamma: 0.1, phiA: 1, phiB: 0, scheme: "central" as const };
	assert.equal(exactConvectionDiffusion(setup, 0), 1);
	assert.ok(Math.abs(exactConvectionDiffusion(setup, 1)) < 1e-12);
	assert.ok(Number.isFinite(exactConvectionDiffusion({ ...setup, gamma: 1e-4 }, 0.5)), "no overflow at huge Péclet");
});

test("advection: upwind at C = 1 is an exact shift, FTCS blows up, Lax–Wendroff conserves mass", () => {
	let phi = pulse(100, "square");
	for (let s = 0; s < 30; s++) phi = advectStep(phi, 1, "upwind");
	const exact = pulse(100, "square", 30);
	phi.forEach((value, i) => assert.ok(Math.abs(value - exact[i]) < 1e-12));
	let ftcs = pulse(100, "square");
	for (let s = 0; s < 300; s++) ftcs = advectStep(ftcs, 0.5, "ftcs");
	assert.ok(Math.max(...ftcs) > 5, "FTCS is unconditionally unstable");
	let lw = pulse(100, "gauss");
	const mass = lw.reduce((a, b) => a + b, 0);
	for (let s = 0; s < 200; s++) lw = advectStep(lw, 0.8, "lax-wendroff");
	assert.ok(Math.abs(lw.reduce((a, b) => a + b, 0) - mass) < 1e-9);
});

test("2D conduction: insulated top/bottom gives the exact linear profile; SOR beats Jacobi", () => {
	const make = (method: "jacobi" | "gauss-seidel" | "sor") => new Diffusion2D({ nx: 12, ny: 12, left: 100, right: 0, top: "insulated", bottom: "insulated", source: 0, method, omega: 1.6 });
	const counts: Record<string, number> = {};
	for (const method of ["jacobi", "gauss-seidel", "sor"] as const) {
		const d = make(method);
		while (d.iterate() > 1e-8 && d.iterations < 20000) { /* iterate */ }
		counts[method] = d.iterations;
		for (let i = 0; i < d.nx; i++) assert.ok(Math.abs(d.T[i * d.ny + 5] - 100 * (1 - (i + 0.5) / d.nx)) < 1e-5, `${method} cell ${i}`);
	}
	assert.ok(counts.sor < counts["gauss-seidel"] && counts["gauss-seidel"] < counts.jacobi, JSON.stringify(counts));
	const eq = make("jacobi").equation(0, 0);
	assert.equal(eq.aW, 0);
	assert.equal(eq.aP, eq.aE + eq.aN + 2);
});

function runToSteady(solver: Ns2D, maxTime: number): void {
	let previous = Number.POSITIVE_INFINITY;
	while (solver.stats.time < maxTime) {
		const before = Float64Array.from(solver.u);
		for (let k = 0; k < 50; k++) solver.step();
		let change = 0;
		for (let k = 0; k < before.length; k++) change = Math.max(change, Math.abs(solver.u[k] - before[k]));
		if (change < 1e-6 && previous < 1e-6) return;
		previous = change;
	}
}

test("lid-driven cavity at Re = 100 matches Ghia et al. (1982) and stays divergence-free", () => {
	const s = new Ns2D({ flowCase: "cavity", n: 48, re: 100, convection: "hybrid" });
	runToSteady(s, 25);
	let worst = 0;
	for (const [y, uRef] of GHIA_CAVITY_U[100]) worst = Math.max(worst, Math.abs(s.velocityAt(0.5, y)[0] - uRef));
	const { divergenceBefore, divergenceAfter } = s.stats;
	results.push(`    cavity Re=100: t=${s.stats.time.toFixed(2)}, steps=${s.stats.steps}, max |u - Ghia| = ${worst.toFixed(4)}, div ${divergenceBefore.toExponential(2)} -> ${divergenceAfter.toExponential(2)}`);
	assert.ok(worst < 0.03, `max deviation from Ghia ${worst}`);
	// The lid corners are singular, so the predictor divergence stays O(10) there; the projection must still remove >99.99 %.
	assert.ok(divergenceAfter < 1e-4 * divergenceBefore);
});

test("periodic channel reaches the Poiseuille parabola; Couette becomes linear", () => {
	for (const flowCase of ["channel", "couette"] as const) {
		const s = new Ns2D({ flowCase, n: 24, re: 20, convection: "hybrid" });
		runToSteady(s, 40);
		let worst = 0;
		for (let k = 1; k < 10; k++) { const y = k / 10; worst = Math.max(worst, Math.abs(s.velocityAt(1, y)[0] - (s.analyticProfile(y) as number))); }
		results.push(`    ${flowCase}: max |u - exact| = ${worst.toFixed(4)}`);
		assert.ok(worst < 0.01, `${flowCase} deviation ${worst}`);
	}
});

test("flow past an obstacle stays bounded, mass-conserving and divergence-free", () => {
	const s = new Ns2D({ flowCase: "obstacle", n: 24, re: 100, convection: "hybrid" });
	for (let k = 0; k < 400; k++) s.step();
	let inflow = 0, outflow = 0;
	for (let j = 1; j <= s.ny; j++) { inflow += s.u[s.iu(0, j)]; outflow += s.u[s.iu(s.nx, j)]; }
	assert.ok(Math.abs(inflow - outflow) < 1e-9 * s.ny);
	assert.ok(Number.isFinite(s.stats.maxSpeed) && s.stats.maxSpeed < 3);
	assert.ok(s.stats.divergenceAfter < 1e-3 * s.stats.divergenceBefore, `div ${s.stats.divergenceBefore} -> ${s.stats.divergenceAfter}`);
	const field = s.cellField("speed");
	assert.ok(field.some(Number.isNaN), "solid cells are masked");
});

test("phase-by-phase stepping equals a full step and the projection removes divergence", () => {
	const a = new Ns2D({ flowCase: "cavity", n: 16, re: 100, convection: "hybrid" });
	const b = new Ns2D({ flowCase: "cavity", n: 16, re: 100, convection: "hybrid" });
	for (let k = 0; k < 5; k++) a.step();
	for (let k = 0; k < 15; k++) b.advancePhase();
	assert.deepEqual(Array.from(a.u), Array.from(b.u));
	b.advancePhase();
	assert.equal(b.phase, "predicted");
	assert.ok(b.stats.divergenceBefore > 1e-3);
	b.advancePhase(); b.advancePhase();
	assert.ok(b.stats.divergenceAfter < 1e-3 * b.stats.divergenceBefore);
});

console.log(results.join("\n"));
console.log(`\n${results.filter(r => r.startsWith("ok")).length} tests passed`);
