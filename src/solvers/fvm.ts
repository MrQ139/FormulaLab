// Finite-volume teaching problems (Patankar 1980; Versteeg & Malalasekera, 2nd ed., ch. 4–5).

export type FvmScheme = "central" | "upwind" | "hybrid" | "power-law";
export type AdvectionScheme = "upwind" | "lax-wendroff" | "lax-friedrichs" | "ftcs";
export type IterativeMethod = "jacobi" | "gauss-seidel" | "sor";

export interface CellEquation {
	index: number;
	x: number;
	aW: number;
	aE: number;
	aP: number;
	su: number;
	phi: number;
	/** Neighbour coefficients that came from a Dirichlet boundary instead of a neighbouring cell. */
	boundaryWest: number;
	boundaryEast: number;
}

export interface ConvectionDiffusionSetup {
	n: number;
	length: number;
	rho: number;
	u: number;
	gamma: number;
	phiA: number;
	phiB: number;
	scheme: FvmScheme;
}

export interface ConvectionDiffusionResult {
	cells: CellEquation[];
	flux: number;
	conductance: number;
	cellPeclet: number;
	globalPeclet: number;
	maxError: number;
	hasNegativeCoefficient: boolean;
}

/** Patankar's A(|P|): how much of the diffusion conductance each scheme keeps at cell Péclet number P. */
export function schemeWeight(scheme: FvmScheme, peclet: number): number {
	const a = Math.abs(peclet);
	switch (scheme) {
		case "central": return 1 - 0.5 * a;
		case "upwind": return 1;
		case "hybrid": return Math.max(0, 1 - 0.5 * a);
		case "power-law": return Math.max(0, (1 - 0.1 * a) ** 5);
	}
}

export function exactConvectionDiffusion(setup: ConvectionDiffusionSetup, x: number): number {
	const pe = setup.rho * setup.u * setup.length / setup.gamma, s = x / setup.length;
	if (Math.abs(pe) < 1e-9) return setup.phiA + (setup.phiB - setup.phiA) * s;
	// Written so large Péclet numbers do not overflow exp().
	const ratio = pe > 0 ? (Math.exp(pe * (s - 1)) - Math.exp(-pe)) / (1 - Math.exp(-pe)) : (Math.exp(pe * s) - 1) / (Math.exp(pe) - 1);
	return setup.phiA + (setup.phiB - setup.phiA) * ratio;
}

export function solveConvectionDiffusion(setup: ConvectionDiffusionSetup): ConvectionDiffusionResult {
	const n = Math.max(2, Math.round(setup.n)), dx = setup.length / n;
	const F = setup.rho * setup.u, D = setup.gamma / dx, Db = 2 * setup.gamma / dx;
	const interiorWeight = schemeWeight(setup.scheme, F / D);
	// A Dirichlet face half a cell away: central uses the boundary value as the face value;
	// upwind-type schemes use it only for inflow and carry the cell value out through an outflow face.
	const boundaryFace = (outwardFlux: number): { toP: number; toBoundary: number } => {
		if (setup.scheme === "central" || outwardFlux < 0) return { toP: Db, toBoundary: Db - outwardFlux };
		return { toP: Db + outwardFlux, toBoundary: Db };
	};
	const cells: CellEquation[] = [];
	for (let i = 0; i < n; i++) {
		let aW = 0, aE = 0, aP = 0, boundaryWest = 0, boundaryEast = 0;
		if (i === 0) { const b = boundaryFace(-F); aP += b.toP; boundaryWest = b.toBoundary; }
		else { aW = D * interiorWeight + Math.max(F, 0); aP += aW - F; }
		if (i === n - 1) { const b = boundaryFace(F); aP += b.toP; boundaryEast = b.toBoundary; }
		else { aE = D * interiorWeight + Math.max(-F, 0); aP += aE + F; }
		cells.push({
			index: i, x: (i + 0.5) * dx, aW, aE, aP,
			su: boundaryWest * setup.phiA + boundaryEast * setup.phiB,
			phi: 0, boundaryWest, boundaryEast,
		});
	}
	const phi = tdma(cells.map(c => c.aW), cells.map(c => c.aP), cells.map(c => c.aE), cells.map(c => c.su));
	let maxError = 0, hasNegativeCoefficient = false;
	cells.forEach((cell, i) => {
		cell.phi = phi[i];
		maxError = Math.max(maxError, Math.abs(phi[i] - exactConvectionDiffusion(setup, cell.x)));
		if (cell.aW < -1e-12 || cell.aE < -1e-12 || cell.boundaryWest < -1e-12 || cell.boundaryEast < -1e-12) hasNegativeCoefficient = true;
	});
	return { cells, flux: F, conductance: D, cellPeclet: F / D, globalPeclet: F * setup.length / setup.gamma, maxError, hasNegativeCoefficient };
}

/** Thomas algorithm for aP φP = aW φW + aE φE + su. */
export function tdma(aW: number[], aP: number[], aE: number[], su: number[]): number[] {
	const n = aP.length, p = new Array<number>(n), q = new Array<number>(n), phi = new Array<number>(n);
	for (let i = 0; i < n; i++) {
		const denominator = aP[i] - (i > 0 ? aW[i] * p[i - 1] : 0);
		p[i] = aE[i] / denominator;
		q[i] = (su[i] + (i > 0 ? aW[i] * q[i - 1] : 0)) / denominator;
	}
	for (let i = n - 1; i >= 0; i--) phi[i] = p[i] * (i < n - 1 ? phi[i + 1] : 0) + q[i];
	return phi;
}

export type PulseShape = "square" | "gauss";

/** Periodic initial profile sampled at cell centres, shifted right by `shift` cell widths. */
export function pulse(n: number, shape: PulseShape, shift = 0): Float64Array {
	const out = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		const x = ((((i + 0.5 - shift) / n) % 1) + 1) % 1;
		out[i] = shape === "gauss" ? Math.exp(-(((x - 0.2) / 0.06) ** 2)) : x > 0.1 && x < 0.3 ? 1 : 0;
	}
	return out;
}

/** One explicit step of φ_t + c φ_x = 0 on a periodic grid with Courant number C = c Δt / Δx. */
export function advectStep(phi: Float64Array, courant: number, scheme: AdvectionScheme): Float64Array {
	const n = phi.length, next = new Float64Array(n), C = courant;
	for (let i = 0; i < n; i++) {
		const w = phi[(i - 1 + n) % n], c = phi[i], e = phi[(i + 1) % n];
		switch (scheme) {
			case "upwind": next[i] = c - C * (c - w); break;
			case "ftcs": next[i] = c - C / 2 * (e - w); break;
			case "lax-friedrichs": next[i] = (e + w) / 2 - C / 2 * (e - w); break;
			case "lax-wendroff": next[i] = c - C / 2 * (e - w) + C * C / 2 * (e - 2 * c + w); break;
		}
	}
	return next;
}

export type Boundary = number | "insulated";

export interface Diffusion2DSetup {
	nx: number;
	ny: number;
	left: Boundary;
	right: Boundary;
	top: Boundary;
	bottom: Boundary;
	/** Volumetric heat source, in the same units as conductivity × temperature / length². */
	source: number;
	method: IterativeMethod;
	omega: number;
}

export interface Cell2DEquation {
	aW: number; aE: number; aS: number; aN: number; aP: number; su: number;
	T: number; neighbours: { W: number | null; E: number | null; S: number | null; N: number | null };
}

/** Steady conduction ∇·(k∇T) + q = 0 on a unit square of finite volumes, k = 1. */
export class Diffusion2D {
	readonly setup: Diffusion2DSetup;
	readonly nx: number;
	readonly ny: number;
	readonly T: Float64Array;
	iterations = 0;
	readonly residuals: number[] = [];
	private readonly coeff: Float64Array;

	constructor(setup: Diffusion2DSetup) {
		this.setup = setup;
		this.nx = Math.max(2, Math.round(setup.nx));
		this.ny = Math.max(2, Math.round(setup.ny));
		this.T = new Float64Array(this.nx * this.ny);
		// Per cell: aW, aE, aS, aN, aP, su.
		this.coeff = new Float64Array(this.nx * this.ny * 6);
		const dx = 1 / this.nx, dy = 1 / this.ny, ax = dy / dx, ay = dx / dy;
		const boundary = (value: Boundary, a: number): [number, number] => value === "insulated" ? [0, 0] : [2 * a, 2 * a * value];
		for (let i = 0; i < this.nx; i++) {
			for (let j = 0; j < this.ny; j++) {
				let aW = i > 0 ? ax : 0, aE = i < this.nx - 1 ? ax : 0, aS = j > 0 ? ay : 0, aN = j < this.ny - 1 ? ay : 0;
				let su = setup.source * dx * dy, sp = 0;
				// Boundary faces sit half a cell away, so their conductance is doubled and moved to the source term.
				const add = ([a, s]: [number, number]) => { sp += a; su += s; };
				if (i === 0) add(boundary(setup.left, ax));
				if (i === this.nx - 1) add(boundary(setup.right, ax));
				if (j === 0) add(boundary(setup.bottom, ay));
				if (j === this.ny - 1) add(boundary(setup.top, ay));
				const k = (i * this.ny + j) * 6;
				this.coeff.set([aW, aE, aS, aN, aW + aE + aS + aN + sp, su], k);
			}
		}
	}

	private neighbourSum(i: number, j: number, T: Float64Array): number {
		const k = (i * this.ny + j) * 6, c = this.coeff;
		return (i > 0 ? c[k] * T[(i - 1) * this.ny + j] : 0) + (i < this.nx - 1 ? c[k + 1] * T[(i + 1) * this.ny + j] : 0)
			+ (j > 0 ? c[k + 2] * T[i * this.ny + j - 1] : 0) + (j < this.ny - 1 ? c[k + 3] * T[i * this.ny + j + 1] : 0);
	}

	residual(): number {
		let max = 0;
		for (let i = 0; i < this.nx; i++) for (let j = 0; j < this.ny; j++) {
			const k = (i * this.ny + j) * 6;
			max = Math.max(max, Math.abs(this.coeff[k + 4] * this.T[i * this.ny + j] - this.neighbourSum(i, j, this.T) - this.coeff[k + 5]));
		}
		return max;
	}

	/** One sweep of the chosen iterative method; returns the residual afterwards. */
	iterate(): number {
		const { method, omega } = this.setup;
		const source = method === "jacobi" ? Float64Array.from(this.T) : this.T;
		const relax = method === "sor" ? omega : 1;
		for (let i = 0; i < this.nx; i++) for (let j = 0; j < this.ny; j++) {
			const k = (i * this.ny + j) * 6, idx = i * this.ny + j;
			const target = (this.neighbourSum(i, j, source) + this.coeff[k + 5]) / this.coeff[k + 4];
			this.T[idx] = source[idx] + relax * (target - source[idx]);
		}
		this.iterations++;
		const r = this.residual();
		this.residuals.push(r);
		return r;
	}

	equation(i: number, j: number): Cell2DEquation {
		const k = (i * this.ny + j) * 6, c = this.coeff, T = this.T;
		return {
			aW: c[k], aE: c[k + 1], aS: c[k + 2], aN: c[k + 3], aP: c[k + 4], su: c[k + 5], T: T[i * this.ny + j],
			neighbours: {
				W: i > 0 ? T[(i - 1) * this.ny + j] : null, E: i < this.nx - 1 ? T[(i + 1) * this.ny + j] : null,
				S: j > 0 ? T[i * this.ny + j - 1] : null, N: j < this.ny - 1 ? T[i * this.ny + j + 1] : null,
			},
		};
	}
}
