# FormulaLab

FormulaLab is a local Obsidian plugin for rendering interactive engineering equations directly inside Markdown notes.

It is designed for aerospace engineering notes, propulsion calculations, experimental logs, and lightweight scientific modeling workflows where equations need to be explored visually rather than stored as static text.

## Project Position

FormulaLab is intended to sit between three tools:

- **Obsidian** for research notes and knowledge management
- **mathjs** for safe scalar equation evaluation
- **Plotly.js** for interactive curve visualization

It also ships two teaching-scale CFD blocks: `cfd-cells`, which explains finite-volume discretization cell by cell, and `ns2d`, a validated 2D incompressible Navier–Stokes solver that runs in the note. They are built for understanding, not for production engineering analysis; FormulaLab is not a symbolic algebra system or a general-purpose CFD code.

## Features

- Formula-driven 2D plots
- Lightweight interactive fluid mechanics simulators with `flow-scene`
- `cfd-cells`: finite-volume cells you can click to see each cell's discrete equation, scheme behaviour (central/upwind/hybrid/power-law), CFL stability, and iterative solver convergence
- `ns2d`: 2D incompressible Navier–Stokes on a staggered MAC grid with projection, stepped phase by phase (predictor → pressure Poisson → correction), with lid-driven cavity, channel, Couette, and cylinder-wake cases validated against benchmark and analytic solutions
- Pitot differential pressure velocity calculator for high-pressure N2 crossflow notes
- One independent variable
- Multiple slider-controlled parameters
- Plotly.js interactive graph
- Canvas-based particle sketches, draggable probe points, and physical readouts
- Current x marker on the curve
- Numeric result display
- YAML-based code block configuration
- Local bundling with no CDN dependency
- Safe expression evaluation with mathjs, no `eval()`

## Project Structure

```text
FormulaLab/
  main.ts              Plugin entry, formulalab / flow-scene / pitot blocks
  src/solvers/         Pure numerical solvers (fvm.ts, ns2d.ts), no DOM access
  src/views/           cfd-cells and ns2d renderers
  src/ui.ts            Shared controls, colour maps, animation loop
  tests/               Solver validation tests (npm test)
  dev/                 Browser harness for visual checks (npm run harness)
  main.js              Built plugin bundle
  manifest.json        Obsidian plugin manifest
  styles.css           Obsidian-themed UI styles
  package.json         Dependencies and scripts
  tsconfig.json        TypeScript config
  esbuild.config.mjs   Build config
  README.md            Usage notes
  CHANGELOG.md         Version history
  docs/                Extended documentation
```

## Installation

### Install from GitHub

Clone this repository directly into your Obsidian vault plugin folder:

```powershell
cd path\to\Vault\.obsidian\plugins
git clone https://github.com/MrQ139/FormulaLab.git formulalab
```

Then reload Obsidian and enable **FormulaLab** from Community plugins.

### Install from release zip

Download `formulalab-x.y.z.zip` from GitHub Releases and extract it to:

```text
path/to/Vault/.obsidian/plugins/formulalab/
```

The extracted folder must contain:

```text
manifest.json
main.js
styles.css
```

### Development build

```powershell
npm install
npm run build
npm test          # solver validation (cavity benchmark, analytic profiles, FVM textbook cases)
npm run harness   # visual harness at http://localhost:5178/dev/index.html
npm run check-note -- note.md   # parse every FormulaLab block in a note
```

On Windows, paths with spaces or parentheses are mangled by npm; run `node dist/validate-note.cjs "path to note.md"` after one `npm run check-note` build instead.

If `npm install` is very slow inside a synced Google Drive folder, copy the plugin folder to a local temporary folder, run `npm install` and `npm run build` there, then copy the generated `main.js` back into `.obsidian/plugins/formulalab/`.

## Usage

Create a markdown code block with the `formulalab` language:

````markdown
```formulalab
title: Quadratic Function
mode: function
formula: a*x^2 + b*x + c
x: x
x_min: -10
x_max: 10
x_init: 2

params:
  a:
    value: 1
    min: -5
    max: 5
    step: 0.1
  b:
    value: 0
    min: -10
    max: 10
    step: 0.1
  c:
    value: 0
    min: -10
    max: 10
    step: 0.1
```
````

For the built-in Pitot velocity calculator, use `pitot-velocity` or `pitot-n2`:

````markdown
```pitot-velocity
p0: 20.010
pstatic: 20.000
unit: MPa
rho: 220
```
````

For lightweight interactive fluid mechanics simulators, use `flow-scene`:

````markdown
```flow-scene
title: Pipe Poiseuille Flow
type: pipe-poiseuille
particles: 36
show_profile: true

params:
  umax:
    value: 2
    min: 0.2
    max: 5
    step: 0.05
  R:
    value: 1
    min: 0.2
    max: 2
    step: 0.05
```
````

Supported `flow-scene` types:

| Type | Use |
| --- | --- |
| `pipe-poiseuille` | Parabolic velocity profile, no-slip wall cue, particle speed variation |
| `material-derivative` | Local plus convective change along a moving particle |
| `control-volume-flux` | Storage and surface flux interpretation of Reynolds transport theorem |
| `streamline-pathline-streakline` | Difference between instantaneous streamlines and particle paths in unsteady flow |
| `bernoulli-streamtube` | Pressure head and velocity head exchange through a streamtube |

`flow-scene` is interaction-driven: sliders update the physical sketch directly, and the probe point on the canvas can be dragged to inspect the local physical interpretation.

Each scene renders three study layers:

- A governing-equation panel so the physical relation is visible before the canvas
- Term cards that show the current value and meaning of each major term
- A draggable probe that binds the canvas position to the term readout

The goal is not to show generic 2D function plots. Use `flow-scene` when the learner needs to connect a formula to a physical region, flux, particle, streamline, or head exchange.

### Finite volumes cell by cell: `cfd-cells`

````markdown
```cfd-cells
type: convection-diffusion
scheme: central        # central | upwind | hybrid | power-law
cells: 5
velocity: 0.1
diffusivity: 0.1
phi_left: 1
phi_right: 0
```
````

| Type | What it teaches | Main fields |
| --- | --- | --- |
| `convection-diffusion` | Steady 1D convection–diffusion (Patankar; Versteeg & Malalasekera ch. 5). Click a cell to see `a_P φ_P = a_W φ_W + a_E φ_E + S_u` with numbers; negative coefficients and cell Péclet > 2 are flagged; exact solution overlay | `scheme`, `cells`, `velocity`, `diffusivity`, `phi_left`, `phi_right` |
| `advection` | Transient linear advection; numerical diffusion vs. dispersion, CFL stability, FTCS instability | `scheme` (`upwind`, `lax-wendroff`, `lax-friedrichs`, `ftcs`), `courant`, `cells`, `shape` (`square`, `gauss`) |
| `diffusion-2d` | Steady 2D conduction on a grid of cells; Jacobi vs. Gauss–Seidel vs. SOR convergence with residual history; click a cell for its equation | `cells`, `left`/`right`/`top`/`bottom` (number or `insulated`), `source`, `method`, `omega` |

### 2D Navier–Stokes: `ns2d`

````markdown
```ns2d
case: cavity           # cavity | channel | couette | obstacle
re: 100
grid: 32
scheme: hybrid         # hybrid | upwind | central
field: speed           # speed | vorticity | pressure | divergence | u | v
tracers: true
arrows: false
autoplay: false
```
````

Each time step is shown as the three projection-method phases. **단계별 ▷** runs one phase at a time and switches the view to what that phase produced: the divergence of the predicted velocity u*, the pressure field, then the divergence-free result. Validation plots update live: centreline u against Ghia et al. (1982) for the cavity at Re = 100/400/1000, the analytic Poiseuille and Couette profiles, and a wake probe with a Strouhal-number estimate for the cylinder.

The solver uses the MAC discretization of Griebel, Dornseifer & Neunhoeffer (donor-cell/central blended convection, SOR pressure Poisson). All quantities are non-dimensional (U = 1, ρ = 1, ν = UL/Re; the cylinder case uses its diameter D = 0.2 as L).

## Validation

`npm test` runs the solver checks in Node:

| Check | Result |
| --- | --- |
| Versteeg & Malalasekera Example 5.1, central scheme, 5 cells | all cell values within 5×10⁻⁴ of the textbook |
| Central scheme at cell Pe > 2 | negative coefficient and unbounded wiggles detected; upwind stays bounded |
| Lid-driven cavity, Re = 100, 48×48 | max \|u − Ghia\| on the vertical centreline ≈ 0.005 |
| Poiseuille channel / Couette flow | max error vs. analytic profile 0.0011 / < 10⁻⁴ |
| Cylinder wake | bounded, mass-conserving; Strouhal ≈ 0.16 at Re = 120 in the browser |
| Projection | removes > 99.99 % of the predictor divergence each step |

## References

- U. Ghia, K. N. Ghia, C. T. Shin, "High-Re solutions for incompressible flow using the Navier–Stokes equations and a multigrid method," *J. Comput. Phys.* 48 (1982) 387–411 (cavity benchmark data).
- M. Griebel, T. Dornseifer, T. Neunhoeffer, *Numerical Simulation in Fluid Dynamics: A Practical Introduction*, SIAM, 1998 (MAC grid and projection scheme).
- S. V. Patankar, *Numerical Heat Transfer and Fluid Flow*, 1980; H. K. Versteeg, W. Malalasekera, *An Introduction to Computational Fluid Dynamics*, 2nd ed., 2007 (finite-volume schemes).
- L. A. Barba, G. F. Forsyth, "CFD Python: the 12 steps to Navier–Stokes equations," *JOSE* 1(9), 21 (2018) — the step-by-step teaching sequence these blocks follow (no code is copied).

Optional jet momentum inputs can be included:

````markdown
```pitot-velocity
p0: 20.010
pstatic: 20.000
unit: MPa
rho: 220
mdotJet: 1.2
diameterJet: 1.0
rhoJet: 220
```
````

## Engineering Examples

### Weber Number

````markdown
```formulalab
title: Weber Number
mode: engineering
formula: rho_g*Ug^2*d_l/sigma
x: Ug
x_label: Gas velocity Ug [m/s]
y_label: Weber number [-]
x_min: 1
x_max: 150
x_init: 40

params:
  rho_g:
    label: Gas density rho_g [kg/m^3]
    value: 1.2
    min: 0.5
    max: 10
    step: 0.1
  d_l:
    label: Liquid diameter d_l [m]
    value: 0.001
    min: 0.0001
    max: 0.005
    step: 0.0001
  sigma:
    label: Surface tension sigma [N/m]
    value: 0.072
    min: 0.02
    max: 0.09
    step: 0.001
```
````

### Reynolds Number

````markdown
```formulalab
title: Reynolds Number
mode: engineering
formula: rho*U*D/mu
x: U
x_label: Velocity U [m/s]
y_label: Reynolds number [-]
x_min: 0.01
x_max: 20
x_init: 1

params:
  rho:
    label: Density rho [kg/m^3]
    value: 1000
    min: 1
    max: 1200
    step: 1
  D:
    label: Diameter D [m]
    value: 0.05
    min: 0.001
    max: 0.5
    step: 0.001
  mu:
    label: Dynamic viscosity mu [Pa*s]
    value: 0.001
    min: 0.0001
    max: 0.01
    step: 0.0001
```
````

## Supported Config Fields

| Field | Required | Description |
| --- | --- | --- |
| `title` | No | Card title |
| `mode` | No | Display badge such as `function` or `engineering` |
| `formula` | Yes | mathjs-compatible formula |
| `latex` | No | LaTeX shown above the plot; without it the formula is converted by mathjs `toTex()` and typeset with Obsidian's MathJax |
| `x` | Yes | Independent variable name |
| `x_label` | No | Plot and slider label for x |
| `y_label` | No | Plot and result label for y |
| `x_min` | Yes | Minimum x value |
| `x_max` | Yes | Maximum x value |
| `x_init` | Yes | Initial x value |
| `params` | Yes | Parameter slider definitions |

Each parameter requires `value`, `min`, `max`, and `step`. It may also include `label`.

## Current Limitations

The first stable direction is deliberately narrow:

- Scalar numeric formulas only in `formulalab` blocks
- One independent variable per `formulalab` block
- `ns2d` is 2D, uniform-grid, laminar and first/second-order; the cylinder is a staircase approximation
- No matrix expressions
- No symbolic simplification
- No contour plots or 3D plots
- No external data overlay yet
- No built-in regime map generator yet

These limits keep the plugin useful for engineering notes without turning it into a large simulation platform.

## Roadmap

See [`docs/roadmap.md`](docs/roadmap.md).

## Plotly Bundling Notes

This plugin uses `plotly.js-basic-dist-min` (scatter, bar, and pie only, about 1 MB). Plotly and mathjs are loaded with dynamic `import()` the first time a block needs them, so enabling the plugin does not slow Obsidian's startup; in a browser measurement the plugin load went from about 1.4 s (0.4.0, full Plotly evaluated at load) to about 0.06 s.

If you see build errors involving Node built-ins, confirm that `obsidian`, `electron`, and Node built-in modules are listed as external in `esbuild.config.mjs`.

## mathjs Notes

FormulaLab uses mathjs syntax. Common functions such as `sin`, `cos`, `tan`, `exp`, `log`, `sqrt`, and `abs` work. Use `^` for powers.
