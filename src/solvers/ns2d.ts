// Incompressible 2D Navier–Stokes on a staggered (MAC) grid with Chorin projection.
// Discretization follows Griebel, Dornseifer & Neunhoeffer, "Numerical Simulation in Fluid Dynamics" (SIAM, 1998):
// pressure at cell centres, u on vertical faces, v on horizontal faces, donor-cell/central blended convection.
// Everything is non-dimensional: reference velocity 1, density 1, viscosity nu = U L / Re.

export type NsCase = "cavity" | "channel" | "couette" | "obstacle";
export type Convection = "hybrid" | "upwind" | "central";
export type NsField = "speed" | "vorticity" | "pressure" | "divergence" | "u" | "v";
export type NsPhase = "idle" | "predicted" | "pressure";

export interface NsSetup {
	flowCase: NsCase;
	n: number;
	re: number;
	convection: Convection;
}

export interface NsStats {
	time: number;
	steps: number;
	dt: number;
	cfl: number;
	cellRe: number;
	gamma: number;
	poissonIterations: number;
	poissonResidual: number;
	divergenceBefore: number;
	divergenceAfter: number;
	maxSpeed: number;
}

const TAU = 0.5;
// Relative to the largest Poisson source; 1e-4 keeps |∇·u| several orders below the predictor's divergence.
const SOR_TOLERANCE = 1e-4;
const SOR_MAX_ITERATIONS = 2000;

export class Ns2D {
	readonly flowCase: NsCase;
	readonly convection: Convection;
	readonly re: number;
	readonly nx: number;
	readonly ny: number;
	readonly lx: number;
	readonly ly: number;
	readonly dx: number;
	readonly dy: number;
	readonly nu: number;
	readonly periodic: boolean;
	/** Driving body force in x (channel only), sized so the steady centreline speed is 1. */
	readonly fx: number;
	/** Obstacle (cylinder) centre and radius; zero radius when there is no obstacle. */
	readonly obstacle: { x: number; y: number; r: number };

	readonly u: Float64Array;
	readonly v: Float64Array;
	readonly p: Float64Array;
	readonly f: Float64Array;
	readonly g: Float64Array;
	readonly rhs: Float64Array;
	readonly solid: Uint8Array;

	phase: NsPhase = "idle";
	stats: NsStats = {
		time: 0, steps: 0, dt: 0, cfl: 0, cellRe: 0, gamma: 0,
		poissonIterations: 0, poissonResidual: 0, divergenceBefore: 0, divergenceAfter: 0, maxSpeed: 0,
	};

	private readonly uStride: number;
	private readonly vStride: number;
	private readonly pStride: number;
	private readonly fluidCells: Int32Array;
	private readonly neighbours: Int32Array;
	private readonly coefficients: Float64Array;

	constructor(setup: NsSetup) {
		const n = Math.max(8, Math.round(setup.n));
		this.flowCase = setup.flowCase;
		this.convection = setup.convection;
		this.re = setup.re;
		this.periodic = setup.flowCase === "channel" || setup.flowCase === "couette";
		const aspect = setup.flowCase === "cavity" ? 1 : setup.flowCase === "obstacle" ? 4 : 2;
		this.nx = n * aspect;
		this.ny = n;
		this.lx = aspect;
		this.ly = 1;
		this.dx = this.lx / this.nx;
		this.dy = this.ly / this.ny;
		const diameter = 0.2;
		this.obstacle = setup.flowCase === "obstacle" ? { x: 0.8, y: 0.51, r: diameter / 2 } : { x: 0, y: 0, r: 0 };
		const length = setup.flowCase === "obstacle" ? diameter : 1;
		this.nu = length / setup.re;
		this.fx = setup.flowCase === "channel" ? 8 * this.nu : 0;

		this.uStride = this.ny + 2;
		this.vStride = this.ny + 1;
		this.pStride = this.ny + 2;
		// u carries one extra ghost column on each side so periodic wrap-around needs no special cases.
		this.u = new Float64Array((this.nx + 3) * this.uStride);
		this.f = new Float64Array(this.u.length);
		this.v = new Float64Array((this.nx + 2) * this.vStride);
		this.g = new Float64Array(this.v.length);
		this.p = new Float64Array((this.nx + 2) * this.pStride);
		this.rhs = new Float64Array(this.p.length);
		this.solid = new Uint8Array(this.p.length);

		if (this.obstacle.r > 0) {
			for (let i = 1; i <= this.nx; i++) {
				for (let j = 1; j <= this.ny; j++) {
					const x = (i - 0.5) * this.dx, y = (j - 0.5) * this.dy;
					if ((x - this.obstacle.x) ** 2 + (y - this.obstacle.y) ** 2 <= this.obstacle.r ** 2) this.solid[this.ip(i, j)] = 1;
				}
			}
			for (let i = 0; i <= this.nx; i++) for (let j = 1; j <= this.ny; j++) this.u[this.iu(i, j)] = this.isSolidFace(i, j, "u") ? 0 : 1;
		}

		const fluid: number[] = [];
		for (let i = 1; i <= this.nx; i++) for (let j = 1; j <= this.ny; j++) if (!this.solid[this.ip(i, j)]) fluid.push(this.ip(i, j));
		this.fluidCells = Int32Array.from(fluid);
		this.neighbours = new Int32Array(fluid.length * 4);
		this.coefficients = new Float64Array(fluid.length * 5);
		const ax = 1 / (this.dx * this.dx), ay = 1 / (this.dy * this.dy);
		fluid.forEach((cell, k) => {
			const i = Math.floor(cell / this.pStride), j = cell % this.pStride;
			const east = this.cellIndex(i + 1, j), west = this.cellIndex(i - 1, j), north = this.cellIndex(i, j + 1), south = this.cellIndex(i, j - 1);
			const links = [east, west, north, south];
			const weights = [ax, ax, ay, ay];
			let diagonal = 0;
			for (let m = 0; m < 4; m++) {
				// Walls, the inflow/outflow planes and solid cells are all zero-gradient pressure boundaries.
				const open = links[m] >= 0 && !this.solid[links[m]];
				this.neighbours[k * 4 + m] = open ? links[m] : -1;
				this.coefficients[k * 5 + m] = open ? weights[m] : 0;
				if (open) diagonal += weights[m];
			}
			this.coefficients[k * 5 + 4] = diagonal;
		});

		this.applyBoundaryConditions(this.u, this.v);
	}

	iu(i: number, j: number): number { return (i + 1) * this.uStride + j; }
	iv(i: number, j: number): number { return i * this.vStride + j; }
	ip(i: number, j: number): number { return i * this.pStride + j; }

	/** Interior cell index for pressure coupling, with periodic wrap; -1 outside the domain. */
	private cellIndex(i: number, j: number): number {
		if (j < 1 || j > this.ny) return -1;
		if (i < 1 || i > this.nx) {
			if (!this.periodic) return -1;
			i = ((i - 1 + this.nx) % this.nx) + 1;
		}
		return this.ip(i, j);
	}

	private isSolidFace(i: number, j: number, kind: "u" | "v"): boolean {
		if (this.obstacle.r === 0) return false;
		if (kind === "u") return !!(this.solid[this.ip(i, j)] || this.solid[this.ip(i + 1, j)]);
		return !!(this.solid[this.ip(i, j)] || this.solid[this.ip(i, j + 1)]);
	}

	private applyBoundaryConditions(u: Float64Array, v: Float64Array): void {
		const { nx, ny } = this;
		if (this.periodic) {
			const topSpeed = this.flowCase === "couette" ? 1 : 0;
			for (let j = 0; j <= ny + 1; j++) {
				u[this.iu(-1, j)] = u[this.iu(nx - 1, j)];
				u[this.iu(nx, j)] = u[this.iu(0, j)];
				u[this.iu(nx + 1, j)] = u[this.iu(1, j)];
			}
			for (let i = -1; i <= nx + 1; i++) {
				u[this.iu(i, 0)] = -u[this.iu(i, 1)];
				u[this.iu(i, ny + 1)] = 2 * topSpeed - u[this.iu(i, ny)];
			}
			for (let i = 1; i <= nx; i++) { v[this.iv(i, 0)] = 0; v[this.iv(i, ny)] = 0; }
			for (let j = 0; j <= ny; j++) { v[this.iv(0, j)] = v[this.iv(nx, j)]; v[this.iv(nx + 1, j)] = v[this.iv(1, j)]; }
			return;
		}
		if (this.flowCase === "cavity") {
			for (let j = 0; j <= ny + 1; j++) { u[this.iu(0, j)] = 0; u[this.iu(nx, j)] = 0; }
			for (let i = 0; i <= nx; i++) {
				u[this.iu(i, 0)] = -u[this.iu(i, 1)];
				u[this.iu(i, ny + 1)] = 2 - u[this.iu(i, ny)];
			}
			for (let i = 1; i <= nx; i++) { v[this.iv(i, 0)] = 0; v[this.iv(i, ny)] = 0; }
			for (let j = 0; j <= ny; j++) { v[this.iv(0, j)] = -v[this.iv(1, j)]; v[this.iv(nx + 1, j)] = -v[this.iv(nx, j)]; }
			return;
		}
		// Obstacle: uniform inflow, zero-gradient outflow, free-slip channel walls.
		for (let j = 1; j <= ny; j++) { u[this.iu(0, j)] = 1; u[this.iu(nx, j)] = u[this.iu(nx - 1, j)]; }
		for (let i = 0; i <= nx; i++) { u[this.iu(i, 0)] = u[this.iu(i, 1)]; u[this.iu(i, ny + 1)] = u[this.iu(i, ny)]; }
		for (let i = 1; i <= nx; i++) { v[this.iv(i, 0)] = 0; v[this.iv(i, ny)] = 0; }
		for (let j = 0; j <= ny; j++) { v[this.iv(0, j)] = -v[this.iv(1, j)]; v[this.iv(nx + 1, j)] = v[this.iv(nx, j)]; }
		for (let i = 0; i <= nx; i++) for (let j = 1; j <= ny; j++) if (this.isSolidFace(i, j, "u")) u[this.iu(i, j)] = 0;
		for (let i = 1; i <= nx; i++) for (let j = 1; j < ny; j++) if (this.isSolidFace(i, j, "v")) v[this.iv(i, j)] = 0;
	}

	private uFaceRange(): [number, number] {
		return this.periodic ? [0, this.nx - 1] : [1, this.nx - 1];
	}

	private chooseTimeStep(): void {
		// Ghost values (e.g. 2·U_lid − u) are not physical velocities, so only real faces and the moving wall count.
		let umax = this.flowCase === "cavity" || this.flowCase === "couette" ? 1 : 0, vmax = 0;
		for (let i = 0; i <= this.nx; i++) for (let j = 1; j <= this.ny; j++) umax = Math.max(umax, Math.abs(this.u[this.iu(i, j)]));
		for (let i = 1; i <= this.nx; i++) for (let j = 0; j <= this.ny; j++) vmax = Math.max(vmax, Math.abs(this.v[this.iv(i, j)]));
		umax = Math.max(umax, 1e-9); vmax = Math.max(vmax, 1e-9);
		const diffusive = 1 / (2 * this.nu * (1 / (this.dx * this.dx) + 1 / (this.dy * this.dy)));
		const dt = TAU * Math.min(diffusive, this.dx / umax, this.dy / vmax);
		const courant = Math.max(umax * dt / this.dx, vmax * dt / this.dy);
		const gamma = this.convection === "upwind" ? 1 : this.convection === "central" ? 0 : Math.min(1, 1.2 * courant);
		Object.assign(this.stats, { dt, cfl: courant, gamma, maxSpeed: Math.hypot(umax, vmax), cellRe: Math.max(umax * this.dx, vmax * this.dy) / this.nu });
	}

	/** Step 1: momentum predictor u* = u + dt (nu Δu - (u·∇)u + f), ignoring pressure. */
	predict(): void {
		if (this.phase !== "idle") return;
		this.chooseTimeStep();
		const { u, v, f, g, nx, ny, dx, dy, nu } = this;
		const { dt, gamma } = this.stats;
		f.set(u); g.set(v);
		const [iStart, iEnd] = this.uFaceRange();
		for (let i = iStart; i <= iEnd; i++) {
			for (let j = 1; j <= ny; j++) {
				if (this.isSolidFace(i, j, "u")) continue;
				const c = u[this.iu(i, j)], e = u[this.iu(i + 1, j)], w = u[this.iu(i - 1, j)], nn = u[this.iu(i, j + 1)], s = u[this.iu(i, j - 1)];
				const vn = (v[this.iv(i, j)] + v[this.iv(i + 1, j)]) / 2, vs = (v[this.iv(i, j - 1)] + v[this.iv(i + 1, j - 1)]) / 2;
				const du2dx = (((c + e) / 2) ** 2 - ((w + c) / 2) ** 2 + gamma * (Math.abs(c + e) / 2 * (c - e) / 2 - Math.abs(w + c) / 2 * (w - c) / 2)) / dx;
				const duvdy = (vn * (c + nn) / 2 - vs * (s + c) / 2 + gamma * (Math.abs(vn) * (c - nn) / 2 - Math.abs(vs) * (s - c) / 2)) / dy;
				const laplacian = (e - 2 * c + w) / (dx * dx) + (nn - 2 * c + s) / (dy * dy);
				f[this.iu(i, j)] = c + dt * (nu * laplacian - du2dx - duvdy + this.fx);
			}
		}
		for (let i = 1; i <= nx; i++) {
			for (let j = 1; j < ny; j++) {
				if (this.isSolidFace(i, j, "v")) continue;
				const c = v[this.iv(i, j)], e = v[this.iv(i + 1, j)], w = v[this.iv(i - 1, j)], nn = v[this.iv(i, j + 1)], s = v[this.iv(i, j - 1)];
				const ue = (u[this.iu(i, j)] + u[this.iu(i, j + 1)]) / 2, uw = (u[this.iu(i - 1, j)] + u[this.iu(i - 1, j + 1)]) / 2;
				const duvdx = (ue * (c + e) / 2 - uw * (w + c) / 2 + gamma * (Math.abs(ue) * (c - e) / 2 - Math.abs(uw) * (w - c) / 2)) / dx;
				const dv2dy = (((c + nn) / 2) ** 2 - ((s + c) / 2) ** 2 + gamma * (Math.abs(c + nn) / 2 * (c - nn) / 2 - Math.abs(s + c) / 2 * (s - c) / 2)) / dy;
				const laplacian = (e - 2 * c + w) / (dx * dx) + (nn - 2 * c + s) / (dy * dy);
				g[this.iv(i, j)] = c + dt * (nu * laplacian - duvdx - dv2dy);
			}
		}
		this.applyBoundaryConditions(f, g);
		if (this.flowCase === "obstacle") this.balanceOutflow(f);
		this.stats.divergenceBefore = this.maxDivergence(f, g);
		this.phase = "predicted";
	}

	/** Zero-gradient outflow does not conserve mass on its own; rescale it so the Neumann pressure problem is solvable. */
	private balanceOutflow(f: Float64Array): void {
		let inflow = 0, outflow = 0;
		for (let j = 1; j <= this.ny; j++) { inflow += f[this.iu(0, j)]; outflow += f[this.iu(this.nx, j)]; }
		const correction = (inflow - outflow) / this.ny;
		for (let j = 1; j <= this.ny; j++) f[this.iu(this.nx, j)] += correction;
	}

	/** Step 2: pressure Poisson ∇²p = (∇·u*) / dt, solved with SOR and zero-gradient boundaries. */
	solvePressure(): void {
		if (this.phase !== "predicted") return;
		const { f, g, p, rhs, dx, dy, fluidCells, neighbours, coefficients } = this;
		const dt = this.stats.dt;
		let mean = 0;
		for (let k = 0; k < fluidCells.length; k++) {
			const cell = fluidCells[k], i = Math.floor(cell / this.pStride), j = cell % this.pStride;
			const div = (f[this.iu(i, j)] - f[this.iu(i - 1, j)]) / dx + (g[this.iv(i, j)] - g[this.iv(i, j - 1)]) / dy;
			rhs[cell] = div / dt;
			mean += rhs[cell];
		}
		// A pure-Neumann problem only has a solution when the source integrates to zero.
		mean /= fluidCells.length;
		let scale = 0;
		for (let k = 0; k < fluidCells.length; k++) { rhs[fluidCells[k]] -= mean; scale = Math.max(scale, Math.abs(rhs[fluidCells[k]])); }
		const omega = 2 / (1 + Math.sin(Math.PI / Math.max(this.nx, this.ny)));
		let iterations = 0, residual = 0;
		if (scale > 0) {
			for (; iterations < SOR_MAX_ITERATIONS; iterations++) {
				residual = 0;
				for (let k = 0; k < fluidCells.length; k++) {
					const cell = fluidCells[k];
					let sum = 0;
					for (let m = 0; m < 4; m++) { const nb = neighbours[k * 4 + m]; if (nb >= 0) sum += coefficients[k * 5 + m] * p[nb]; }
					const diagonal = coefficients[k * 5 + 4];
					const r = sum - diagonal * p[cell] - rhs[cell];
					p[cell] += omega * r / diagonal;
					residual = Math.max(residual, Math.abs(r));
				}
				if (residual <= SOR_TOLERANCE * Math.max(1, scale)) { iterations++; break; }
			}
			let pMean = 0;
			for (let k = 0; k < fluidCells.length; k++) pMean += p[fluidCells[k]];
			pMean /= fluidCells.length;
			for (let k = 0; k < fluidCells.length; k++) p[fluidCells[k]] -= pMean;
		}
		this.syncPressureGhosts();
		this.stats.poissonIterations = iterations;
		this.stats.poissonResidual = residual;
		this.phase = "pressure";
	}

	private syncPressureGhosts(): void {
		const { p, nx, ny } = this;
		for (let j = 1; j <= ny; j++) {
			p[this.ip(0, j)] = this.periodic ? p[this.ip(nx, j)] : p[this.ip(1, j)];
			p[this.ip(nx + 1, j)] = this.periodic ? p[this.ip(1, j)] : p[this.ip(nx, j)];
		}
		for (let i = 0; i <= nx + 1; i++) { p[this.ip(i, 0)] = p[this.ip(i, 1)]; p[this.ip(i, ny + 1)] = p[this.ip(i, ny)]; }
	}

	/** Step 3: projection u = u* - dt ∇p, which removes the divergence the predictor created. */
	correct(): void {
		if (this.phase !== "pressure") return;
		const { u, v, f, g, p, nx, ny, dx, dy } = this;
		const dt = this.stats.dt;
		u.set(f); v.set(g);
		const [iStart, iEnd] = this.uFaceRange();
		for (let i = iStart; i <= iEnd; i++) {
			for (let j = 1; j <= ny; j++) {
				if (this.isSolidFace(i, j, "u")) continue;
				const east = this.cellIndex(i + 1, j), west = this.cellIndex(i, j);
				if (east < 0 || west < 0) continue;
				u[this.iu(i, j)] -= dt * (p[east] - p[west]) / dx;
			}
		}
		for (let i = 1; i <= nx; i++) {
			for (let j = 1; j < ny; j++) {
				if (this.isSolidFace(i, j, "v")) continue;
				v[this.iv(i, j)] -= dt * (p[this.ip(i, j + 1)] - p[this.ip(i, j)]) / dy;
			}
		}
		this.applyBoundaryConditions(u, v);
		// The pressure solve assumed the balanced predictor outflow, so keep it to stay exactly divergence-free.
		if (this.flowCase === "obstacle") for (let j = 1; j <= ny; j++) u[this.iu(nx, j)] = f[this.iu(nx, j)];
		this.stats.divergenceAfter = this.maxDivergence(u, v);
		this.stats.time += dt;
		this.stats.steps += 1;
		this.phase = "idle";
	}

	step(): void {
		this.predict();
		this.solvePressure();
		this.correct();
	}

	/** Advances whichever sub-step comes next, for the phase-by-phase walkthrough. */
	advancePhase(): NsPhase {
		if (this.phase === "idle") this.predict();
		else if (this.phase === "predicted") this.solvePressure();
		else this.correct();
		return this.phase;
	}

	maxDivergence(u: Float64Array = this.u, v: Float64Array = this.v): number {
		let max = 0;
		for (let k = 0; k < this.fluidCells.length; k++) {
			const cell = this.fluidCells[k], i = Math.floor(cell / this.pStride), j = cell % this.pStride;
			const div = (u[this.iu(i, j)] - u[this.iu(i - 1, j)]) / this.dx + (v[this.iv(i, j)] - v[this.iv(i, j - 1)]) / this.dy;
			max = Math.max(max, Math.abs(div));
		}
		return max;
	}

	isSolidCell(i: number, j: number): boolean {
		return !!this.solid[this.ip(i + 1, j + 1)];
	}

	/** Cell-centred scalar field, row-major with index (i, j) → i * ny + j for 0-based cells. */
	cellField(kind: NsField): Float64Array {
		const { nx, ny, dx, dy } = this;
		const out = new Float64Array(nx * ny);
		const u = this.phase === "idle" ? this.u : this.f;
		const v = this.phase === "idle" ? this.v : this.g;
		const corner = (i: number, j: number) => (v[this.iv(i + 1, j)] - v[this.iv(i, j)]) / dx - (u[this.iu(i, j + 1)] - u[this.iu(i, j)]) / dy;
		for (let i = 1; i <= nx; i++) {
			for (let j = 1; j <= ny; j++) {
				const uc = (u[this.iu(i - 1, j)] + u[this.iu(i, j)]) / 2, vc = (v[this.iv(i, j - 1)] + v[this.iv(i, j)]) / 2;
				let value: number;
				switch (kind) {
					case "u": value = uc; break;
					case "v": value = vc; break;
					case "pressure": value = this.p[this.ip(i, j)]; break;
					case "divergence": value = (u[this.iu(i, j)] - u[this.iu(i - 1, j)]) / dx + (v[this.iv(i, j)] - v[this.iv(i, j - 1)]) / dy; break;
					case "vorticity": value = (corner(i - 1, j - 1) + corner(i, j - 1) + corner(i - 1, j) + corner(i, j)) / 4; break;
					default: value = Math.hypot(uc, vc);
				}
				out[(i - 1) * ny + (j - 1)] = this.solid[this.ip(i, j)] ? Number.NaN : value;
			}
		}
		return out;
	}

	/** Bilinear velocity at a physical point, used for tracer particles and profiles. */
	velocityAt(x: number, y: number): [number, number] {
		const { dx, dy, nx, ny } = this;
		const sample = (arr: Float64Array, fx: number, fy: number, iMin: number, iMax: number, jMin: number, jMax: number, index: (i: number, j: number) => number) => {
			const i0 = Math.min(Math.max(Math.floor(fx), iMin), iMax - 1), j0 = Math.min(Math.max(Math.floor(fy), jMin), jMax - 1);
			const tx = Math.min(Math.max(fx - i0, 0), 1), ty = Math.min(Math.max(fy - j0, 0), 1);
			return (1 - tx) * (1 - ty) * arr[index(i0, j0)] + tx * (1 - ty) * arr[index(i0 + 1, j0)] + (1 - tx) * ty * arr[index(i0, j0 + 1)] + tx * ty * arr[index(i0 + 1, j0 + 1)];
		};
		const u = sample(this.u, x / dx, y / dy + 0.5, 0, nx, 0, ny + 1, (i, j) => this.iu(i, j));
		const v = sample(this.v, x / dx + 0.5, y / dy, 0, nx + 1, 0, ny, (i, j) => this.iv(i, j));
		return [u, v];
	}

	/** u along the vertical line x = xFrac * lx, including the wall values. */
	verticalProfile(xFrac: number, points = 41): { y: number[]; u: number[] } {
		const x = xFrac * this.lx, y: number[] = [], u: number[] = [];
		for (let k = 0; k < points; k++) {
			const yy = (k / (points - 1)) * this.ly;
			y.push(yy);
			u.push(this.velocityAt(x, yy)[0]);
		}
		if (this.flowCase === "cavity") u[u.length - 1] = 1;
		return { y, u };
	}

	/** Exact steady profile for the channel and Couette cases (non-dimensional, centreline/wall speed 1). */
	analyticProfile(y: number): number | null {
		if (this.flowCase === "channel") return 4 * y * (1 - y);
		if (this.flowCase === "couette") return y;
		return null;
	}
}

/** Ghia, Ghia & Shin (1982), J. Comput. Phys. 48, 387–411: u on the vertical centreline of the lid-driven cavity. */
export const GHIA_CAVITY_U: Record<number, Array<[number, number]>> = {
	100: [[1, 1], [0.9766, 0.84123], [0.9688, 0.78871], [0.9609, 0.73722], [0.9531, 0.68717], [0.8516, 0.23151], [0.7344, 0.00332], [0.6172, -0.13641], [0.5, -0.20581], [0.4531, -0.2109], [0.2813, -0.15662], [0.1719, -0.1015], [0.1016, -0.06434], [0.0703, -0.04775], [0.0625, -0.04192], [0.0547, -0.03717], [0, 0]],
	400: [[1, 1], [0.9766, 0.75837], [0.9688, 0.68439], [0.9609, 0.61756], [0.9531, 0.55892], [0.8516, 0.29093], [0.7344, 0.16256], [0.6172, 0.02135], [0.5, -0.11477], [0.4531, -0.17119], [0.2813, -0.32726], [0.1719, -0.24299], [0.1016, -0.14612], [0.0703, -0.10338], [0.0625, -0.09266], [0.0547, -0.08186], [0, 0]],
	1000: [[1, 1], [0.9766, 0.65928], [0.9688, 0.57492], [0.9609, 0.51117], [0.9531, 0.46604], [0.8516, 0.33304], [0.7344, 0.18719], [0.6172, 0.05702], [0.5, -0.0608], [0.4531, -0.10648], [0.2813, -0.27805], [0.1719, -0.38289], [0.1016, -0.2973], [0.0703, -0.2222], [0.0625, -0.20196], [0.0547, -0.18109], [0, 0]],
};
