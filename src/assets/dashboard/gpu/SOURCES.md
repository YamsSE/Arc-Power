# Dashboard GPU portrait sources

All raster portraits in this directory are real product, reference-card, or
processor-package imagery. The dashboard only performs deterministic
transparent-margin trimming; it does not generate or stylize the hardware.

The shared dashboard slot is `300px × 180px` with `object-fit: contain`. This
keeps every portrait in the same layout box while preserving the real aspect
ratio of each model instead of stretching a card to fit.

## Intel Arc

- `intel-arc-a750.png` — Intel Arc A750 Limited Edition reference supplied in
  the user's design reference; transparent background and empty margins were
  normalized only.
- `intel-arc-a770.png` — Intel Arc A770 Limited Edition reference used by the
  dashboard concept; model identity is corroborated by Intel's Arc A-series
  product family: <https://www.intel.com/content/www/us/en/products/details/discrete-gpus/arc/desktop/a-series.html>.
- `intel-arc-b580.png` — Intel Arc B580 Limited Edition reference; model
  identity and reference-card dimensions are documented by Intel:
  <https://www.intel.com/content/www/us/en/products/sku/241598/intel-arc-b580-graphics/specifications.html>.
- `intel-arc-a310-a380-reference.png` — compact Arc A310/A380 reference-style
  card supplied in the user's design reference; the family is documented by
  Intel: <https://www.intel.com/content/www/us/en/products/details/discrete-gpus/arc/desktop/a-series.html>.
- `intel-arc-pro-reference.png` — Intel Arc Pro A60 single-slot product
  photograph; product family: <https://www.intel.com/content/www/us/en/products/details/discrete-gpus/arc/workstations/a-series.html>.
  Image source: <https://cdn.blueally.com/cpguard/images/workstation/a60/arc-pro-a60-top.png>.
- `intel-igpu-chip.png` — Intel processor-package portrait used for integrated
  graphics; it is intentionally not a discrete Arc retail card.

Known B570 AIBs use real vendor product imagery and are selected from the
subsystem vendor in the dashboard-only mapper:

- `intel-arc-b570-acer.png` — Acer Nitro Intel Arc B570 OC product identity:
  <https://www.acer.com/us-en/desktops-and-all-in-ones/components/nitro-intel-arc-b570-oc-10gb/pdp/DP.Z4CWW.P01>.
  Image gallery source:
  <https://www.overclockers.co.uk/dw/image/v2/BLRM_PRD/on/demandware.static/-/Sites-master-catalog-ocuk/default/dwbfaa4e5e/images/data/product/47/580174/f6412f5daa282749bcffd1fa8916a2a55040eba7.png?sw=672>.
- `intel-arc-b570-asrock.png` — ASRock Intel Arc B570 Challenger 10GB OC:
  <https://www.asrock.com/Graphics-Card/Intel/Intel%20Arc%20B570%20Challenger%2010GB%20OC/index.us.asp>.
  Image source:
  <https://www.asrock.com/Graphics-Card/photo/Intel%20Arc%20B570%20Challenger%2010GB%20OC%28L2%29.png>.
- `intel-arc-b570-sparkle.png` — SPARKLE Intel Arc B570 Guardian OC:
  <https://www.sparkle.com.tw/en/B570-GUARDIAN>.
  Image source:
  <https://www.sparkle.com.tw/files/20241203220844126.png>.

## AMD Radeon

The generic AMD family portraits use real review/product images from the
TechPowerUp GPU database review galleries (the card itself is transparent;
the dashboard does not use the surrounding review page):

- `amd-radeon-r9-200-300-reference.png` — Radeon R9 290 reference design:
  <https://www.pngkit.com/bigpic/u2w7e6y3y3a9t4w7/>. Image source:
  <https://www.pngkit.com/png/full/218-2189057_graphics-card-png-file-amd-r9-290.png>.
- `amd-radeon-rx-480-580-reference.png` — Radeon RX 480 reference:
  <https://www.techpowerup.com/review/amd-rx-480/>.
- `amd-radeon-rx-5000-6000-reference.png` — Radeon RX 6800 XT reference:
  <https://www.techpowerup.com/review/amd-radeon-rx-6800-xt/>.
- `amd-radeon-rx-7000-9000-reference.png` — Radeon RX 9070 XT partner-board
  product image, used as the current RDNA4 representative:
  <https://www.techpowerup.com/review/sapphire-radeon-rx-9070-xt-pulse/>.
- `amd-radeon-vega-reference.png` — Radeon RX Vega 64 reference:
  <https://www.techpowerup.com/review/amd-radeon-rx-vega-64/>.
- `amd-radeon-igpu-chip.png` — AMD iGPU chip portrait supplied in the user's
  design reference.
- `amd-radeon-mobile-module.png` — real AMD Ryzen 5 7535HS mobile/APU package
  photograph; it is kept distinct from the desktop-style AMD iGPU chip
  portrait. Image source: <https://images.fusionww.com/Prod/Images/ProductCatalogImages/3813.png>.

## NVIDIA GeForce

The NVIDIA portraits use the real Founders Edition product images from the
corresponding TechPowerUp review galleries:

- `nvidia-gtx-reference.png` — GeForce GTX 1080:
  <https://www.techpowerup.com/review/nvidia-geforce-gtx-1080/>.
- `nvidia-rtx-reference.png` — GeForce RTX 2080 Founders Edition:
  <https://www.techpowerup.com/review/nvidia-geforce-rtx-2080-founders-edition/>.
- `nvidia-rtx-2070-reference.png` / `nvidia-rtx-2080-reference.png` — RTX
  2070/2080 Founders Edition:
  <https://www.techpowerup.com/review/nvidia-geforce-rtx-2070-founders-edition/>,
  <https://www.techpowerup.com/review/nvidia-geforce-rtx-2080-founders-edition/>.
- `nvidia-rtx-3070-reference.png` / `nvidia-rtx-3080-reference.png` — RTX
  3070/3080 Founders Edition:
  <https://www.techpowerup.com/review/nvidia-geforce-rtx-3070-founders-edition/>,
  <https://www.techpowerup.com/review/nvidia-geforce-rtx-3080-founders-edition/>.
- `nvidia-rtx-4070-reference.png` / `nvidia-rtx-4080-reference.png` — RTX
  4070/4080 Founders Edition:
  <https://www.techpowerup.com/review/nvidia-geforce-rtx-4070-founders-edition/>,
  <https://www.techpowerup.com/review/nvidia-geforce-rtx-4080-founders-edition/>.
- `nvidia-rtx-5070-reference.png` / `nvidia-rtx-5080-reference.png` — RTX
  5070/5080 Founders Edition:
  <https://www.techpowerup.com/review/nvidia-geforce-rtx-5070-founders-edition/>,
  <https://www.techpowerup.com/review/nvidia-geforce-rtx-5080-founders-edition/>.
