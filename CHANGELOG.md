# Changelog

## 0.4.0

### Added

- `cfd-cells` block: finite-volume teaching views
  - `convection-diffusion`: 1D steady problem with central, upwind, hybrid, and power-law schemes; click a cell to see its discrete equation with numbers, negative-coefficient and cell-Péclet warnings, exact-solution overlay
  - `advection`: transient pulse advection with upwind, Lax–Wendroff, Lax–Friedrichs, and FTCS; CFL and mass-conservation readouts, divergence stop
  - `diffusion-2d`: steady 2D conduction with Jacobi, Gauss–Seidel, and SOR; per-cell equation and residual history
- `ns2d` block: 2D incompressible Navier–Stokes (staggered MAC grid, projection, SOR pressure Poisson)
  - cases `cavity`, `channel`, `couette`, `obstacle`; hybrid/upwind/central convection
  - phase-by-phase stepping (predictor → pressure Poisson → correction) with the matching field shown after each phase
  - speed, vorticity, pressure, divergence, u, v fields; tracer particles and velocity arrows
  - live validation plots: Ghia et al. (1982) cavity data, analytic Poiseuille/Couette profiles, wake probe with Strouhal estimate
- Solver validation tests (`npm test`) and a browser harness (`npm run harness`)

### Changed

- Shared UI helpers moved to `src/ui.ts`; animations pause when a block is off screen or its note is closed

## 0.3.8

### Changed

- Reworked Bernoulli head bars as stacked total-head columns so z changes visibly trade against pressure head
- Clarified in-canvas guidance that velocity head changes with flow rate or area, not elevation alone

## 0.3.7

### Changed

- Made Bernoulli `zRise` visibly tilt the streamtube and update the elevation head bars/readout
- Added a datum cue and z rise/drop marker so elevation change is no longer hidden at the nozzle throat

## 0.3.6

### Changed

- Updated the Bernoulli streamtube scene to display pressure head, velocity head, elevation head, and total head together
- Reworked Bernoulli readouts so elevation change `z` is included in the head budget instead of only changing the tube shape

## 0.3.5

### Changed

- Added Eulerian/Lagrangian view modes to the material derivative scene
- Reworked the material derivative canvas around a fixed-point observation versus following the same particle over a small `dt`
- Updated the material derivative formula panel and term cards so `∂φ/∂t`, `V · ∇φ`, and `Dφ/Dt` map directly to the selected view

## 0.3.4

### Changed

- Added a scene-level equation panel to `flow-scene` so the governing physical relation is visible before the canvas
- Added dynamic term cards for local values, physical meanings, and probe-dependent quantities
- Renamed default slider labels so parameters map directly to equation terms such as `∂φ/∂t`, `∂φ/∂x`, and `Σṁ`
- Improved Obsidian-theme-native contrast and typography for formulas and term readouts

## 0.3.3

### Changed

- Removed stale `flow-scene` toolbar button styling so old play/pause/reset controls cannot show in notes
- Reworked the `material-derivative` scene to show local, convective, and material change directly on the canvas

## 0.3.2

### Changed

- Reframed `flow-scene` as a real-time interactive simulator instead of an animation widget
- Added draggable canvas probe points with local physical readouts
- Removed default play/pause style behavior from `flow-scene`

## 0.3.0

### Added

- `flow-scene` Markdown code block for lightweight Canvas-based fluid mechanics schematics
- Built-in scenes for pipe Poiseuille flow, material derivative, control-volume flux, streamline/pathline comparison, and Bernoulli streamtube interpretation
- Slider-controlled physical parameters and responsive canvas rendering, with optional animation through `animate: true`

## 0.2.0

### Added

- Interactive formula visualization from `formulalab` Markdown code blocks
- Plotly.js based 2D graph rendering
- mathjs based scalar formula evaluation
- Slider-controlled parameter inputs
- Current x marker and numeric result display
- Built-in Pitot velocity calculator block for high-pressure N2 crossflow notes
- Optional jet momentum input support for Pitot-related workflows

### Notes

This version is focused on reliable engineering-note workflows rather than broad numerical simulation. Advanced features such as symbolic manipulation, 3D plots, data overlays, and regime maps are intentionally left for later versions.
