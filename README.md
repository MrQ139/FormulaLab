# FormulaLab

FormulaLab is a local Obsidian plugin that renders interactive equation visualizations from `formulalab` markdown code blocks.

It is designed for math notes, engineering study notes, and lightweight scientific modeling notes.

## Features

- Formula-driven 2D plots
- Pitot differential pressure velocity calculator for high-pressure N2 crossflow notes
- One independent variable
- Multiple slider-controlled parameters
- Plotly.js interactive graph
- Current x marker on the curve
- Numeric result display
- YAML-based code block configuration
- Local bundling with no CDN dependency
- Safe expression evaluation with mathjs, no `eval()`

## Project Structure

```text
.obsidian/plugins/formulalab/
  main.ts              Plugin source code
  main.js              Built plugin bundle
  manifest.json        Obsidian plugin manifest
  styles.css           Obsidian-themed UI styles
  package.json         Dependencies and scripts
  tsconfig.json        TypeScript config
  esbuild.config.mjs   Build config
  README.md            Usage notes
```

## Installation

From this folder:

```bash
cd .obsidian/plugins/formulalab
npm install
npm run build
```

Then reload Obsidian and enable **FormulaLab** from Community plugins.

This repository already includes a built `main.js`. If `npm install` is very slow inside a synced Google Drive folder, copy the plugin folder to a local temporary folder, run `npm install` and `npm run build` there, then copy the generated `main.js` back into `.obsidian/plugins/formulalab/`.

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

## Examples

### Sine Function

````markdown
```formulalab
title: Sine Function
mode: function
formula: A*sin(k*x + phi)
x: x
x_min: -6.28
x_max: 6.28
x_init: 0

params:
  A:
    value: 1
    min: -5
    max: 5
    step: 0.1
  k:
    value: 1
    min: 0.1
    max: 10
    step: 0.1
  phi:
    value: 0
    min: -3.14
    max: 3.14
    step: 0.01
```
````

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
| `x` | Yes | Independent variable name |
| `x_label` | No | Plot and slider label for x |
| `y_label` | No | Plot and result label for y |
| `x_min` | Yes | Minimum x value |
| `x_max` | Yes | Maximum x value |
| `x_init` | Yes | Initial x value |
| `params` | Yes | Parameter slider definitions |

Each parameter requires `value`, `min`, `max`, and `step`. It may also include `label`.

## Plotly Bundling Notes

This plugin uses `plotly.js-dist-min`, which is convenient but large. If Obsidian startup or bundle size becomes an issue, replace it with a smaller Plotly partial bundle that includes only scatter plots.

If you see build errors involving Node built-ins, confirm that `obsidian`, `electron`, and Node built-in modules are listed as external in `esbuild.config.mjs`.

## mathjs Notes

FormulaLab uses mathjs syntax. Common functions such as `sin`, `cos`, `tan`, `exp`, `log`, `sqrt`, and `abs` work. Use `^` for powers.

The first version supports scalar numeric formulas only. Matrix expressions, units, symbolic simplification, contour plots, 3D plots, data overlays, and regime maps are intentionally left for future versions.
