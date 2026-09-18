import random, re

random.seed(7)

SVG_PATH = "og-image.svg"
OUT_PATH = "og-image-final.svg"

x_start = 80
x_end = 1200
baseline = 500
max_h = 90
bar_w = 6
gap = 4
step = bar_w + gap

n = (x_end - x_start) // step

# silence window (fraction of bars) that gets visually "cut"
cut_start_frac = 0.40
cut_end_frac = 0.58
cut_start_i = int(n * cut_start_frac)
cut_end_i = int(n * cut_end_frac)

bars = []
active_color = "url(#barActive)"
cut_color = "#2a333d"

for i in range(n):
    x = x_start + i * step
    in_cut = cut_start_i <= i <= cut_end_i
    if in_cut:
        h = 4
        color = cut_color
    else:
        # layered sine + noise for an organic waveform look
        t = i / n
        env = 0.35 + 0.65 * abs(
            0.6 * random.random()
            + 0.4 * abs(__import__("math").sin(t * 14))
        )
        h = max(6, min(max_h, env * max_h))
        color = active_color
    y = baseline - h / 2
    bars.append(
        f'<rect x="{x:.1f}" y="{y:.1f}" width="{bar_w}" height="{h:.1f}" rx="2" fill="{color}"/>'
    )

waveform_svg = "\n    ".join(bars)

# cut bracket markers around the silent window
cx_start = x_start + cut_start_i * step - 6
cx_end = x_start + cut_end_i * step + bar_w + 6
bracket_top = baseline - 70
bracket_bot = baseline + 70

markers = f'''
    <path d="M {cx_start} {bracket_top} h -14 v {bracket_bot - bracket_top} h 14" stroke="#f97066" stroke-width="3" fill="none" stroke-linecap="round"/>
    <path d="M {cx_end} {bracket_top} h 14 v {bracket_bot - bracket_top} h -14" stroke="#f97066" stroke-width="3" fill="none" stroke-linecap="round"/>
    <text x="{(cx_start + cx_end) / 2}" y="{bracket_top - 14}" font-family="Consolas, monospace" font-size="15" fill="#f97066" text-anchor="middle" letter-spacing="1">SILENCE</text>
'''

with open(SVG_PATH, "r", encoding="utf-8") as f:
    content = f.read()

content = content.replace('<g id="waveform"></g>', f'<g id="waveform">\n    {waveform_svg}\n  </g>')
content = content.replace('<g id="cutmarkers"></g>', f'<g id="cutmarkers">{markers}</g>')

with open(OUT_PATH, "w", encoding="utf-8") as f:
    f.write(content)

print("wrote", OUT_PATH, "with", n, "bars")
