# FormulaLab

FormulaLab is a local Obsidian plugin for rendering interactive engineering equations directly inside Markdown notes.

It is designed for aerospace engineering notes, propulsion calculations, experimental logs, and lightweight scientific modeling workflows where equations need to be explored visually rather than stored as static text.

## Project Position

FormulaLab is intended to sit between three tools:

- **Obsidian** for research notes and knowledge management
- **mathjs** for safe scalar equation evaluation
- **Plotly.js** for interactive curve visualization

The current version focuses on simple but reliable scalar formulas. It is not a full symbolic algebra system, CFD tool, or numerical simulation framework.

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
FormulaLab/
  main.ts              Plugin source code
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
```

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

- Scalar numeric formulas only
- One independent variable per block
- No matrix expressions
- No symbolic simplification
- No contour plots or 3D plots
- No external data overlay yet
- No built-in regime map generator yet

These limits keep the plugin useful for engineering notes without turning it into a large simulation platform.

## Roadmap

See [`docs/roadmap.md`](docs/roadmap.md).

## Plotly Bundling Notes

This plugin uses `plotly.js-dist-min`, which is convenient but large. If Obsidian startup or bundle size becomes an issue, replace it with a smaller Plotly partial bundle that includes only scatter plots.

If you see build errors involving Node built-ins, confirm that `obsidian`, `electron`, and Node built-in modules are listed as external in `esbuild.config.mjs`.

## mathjs Notes

FormulaLab uses mathjs syntax. Common functions such as `sin`, `cos`, `tan`, `exp`, `log`, `sqrt`, and `abs` work. Use `^` for powers.
