#!/usr/bin/env python3
"""Convert the Haunt scene illustrations (assets/art/*.svg, copied from
apps/tv/public/art) into APL vector graphics (AVG).

APL can't draw SVG files, so each illustration becomes an AVG graphic that the
APL documents embed. Output: lambda/src/art/art.json  ({ "<name>": <AVG> }).

What gets translated:
  rect / circle / ellipse / polygon / polyline / line / path  -> AVG path
  <g> fill/stroke/opacity inheritance, transform, clip-path     -> AVG group
  <use href>                                                    -> inlined copy
  linear/radial gradients (incl. userSpaceOnUse)                -> AVG gradients in boundingBox units
  feGaussianBlur filters (no AVG equivalent)                    -> circles/ellipses become soft
                                                                   radial fades; other shapes fade a little

Run:  python3 scripts/convert_art.py
"""
import json
import math
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'assets' / 'art'
OUT = ROOT / 'lambda' / 'src' / 'art' / 'art.json'
NS = '{http://www.w3.org/2000/svg}'
INHERITED = ('fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill-opacity', 'stroke-opacity')


def tag(el):
    return el.tag.replace(NS, '')


def num(v, default=0.0):
    if v is None:
        return default
    v = str(v).strip()
    if v.endswith('%'):
        return float(v[:-1]) / 100
    return float(v)


def fmt(n):
    s = f'{n:.2f}'.rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s


def hex_color(color, alpha=1.0):
    color = color.strip()
    if color in ('none', 'transparent'):
        return None
    if color.startswith('#') and len(color) == 4:
        color = '#' + ''.join(c * 2 for c in color[1:])
    named = {'black': '#000000', 'white': '#ffffff'}
    color = named.get(color, color)
    if not re.fullmatch(r'#[0-9a-fA-F]{6}', color):
        raise ValueError(f'unsupported color {color!r}')
    a = max(0.0, min(1.0, alpha))
    return color if a >= 0.999 else color + f'{round(a * 255):02X}'


# ---------- geometry ----------

def shape_path(el):
    """Path data and bounding box (x, y, w, h) for a basic shape."""
    t = tag(el)
    if t == 'rect':
        x, y = num(el.get('x')), num(el.get('y'))
        w, h = num(el.get('width')), num(el.get('height'))
        rx = num(el.get('rx'), num(el.get('ry'), 0))
        if rx > 0:
            rx = min(rx, w / 2, h / 2)
            d = (f'M{fmt(x + rx)},{fmt(y)}h{fmt(w - 2 * rx)}a{fmt(rx)},{fmt(rx)} 0 0 1 {fmt(rx)},{fmt(rx)}'
                 f'v{fmt(h - 2 * rx)}a{fmt(rx)},{fmt(rx)} 0 0 1 -{fmt(rx)},{fmt(rx)}h-{fmt(w - 2 * rx)}'
                 f'a{fmt(rx)},{fmt(rx)} 0 0 1 -{fmt(rx)},-{fmt(rx)}v-{fmt(h - 2 * rx)}a{fmt(rx)},{fmt(rx)} 0 0 1 {fmt(rx)},-{fmt(rx)}z')
        else:
            d = f'M{fmt(x)},{fmt(y)}h{fmt(w)}v{fmt(h)}h-{fmt(w)}z'
        return d, (x, y, w, h)
    if t in ('circle', 'ellipse'):
        cx, cy = num(el.get('cx')), num(el.get('cy'))
        rx = num(el.get('r')) if t == 'circle' else num(el.get('rx'))
        ry = num(el.get('r')) if t == 'circle' else num(el.get('ry'))
        return ellipse_path(cx, cy, rx, ry), (cx - rx, cy - ry, 2 * rx, 2 * ry)
    if t in ('polygon', 'polyline'):
        pts = [float(p) for p in re.split(r'[\s,]+', el.get('points').strip())]
        xs, ys = pts[0::2], pts[1::2]
        d = 'M' + ' L'.join(f'{fmt(x)},{fmt(y)}' for x, y in zip(xs, ys)) + ('z' if t == 'polygon' else '')
        return d, (min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys))
    if t == 'line':
        x1, y1, x2, y2 = (num(el.get(k)) for k in ('x1', 'y1', 'x2', 'y2'))
        return f'M{fmt(x1)},{fmt(y1)} L{fmt(x2)},{fmt(y2)}', (min(x1, x2), min(y1, y2), abs(x2 - x1), abs(y2 - y1))
    if t == 'path':
        d = el.get('d')
        return d, path_bbox(d)
    return None, None


def ellipse_path(cx, cy, rx, ry):
    return (f'M{fmt(cx - rx)},{fmt(cy)} a{fmt(rx)},{fmt(ry)} 0 1,0 {fmt(2 * rx)},0 '
            f'a{fmt(rx)},{fmt(ry)} 0 1,0 -{fmt(2 * rx)},0z')


def path_bbox(d):
    """Rough bounding box from the absolute coordinates in a path (good enough for gradients)."""
    xs, ys = [], []
    x = y = 0.0
    for cmd, args in re.findall(r'([MLHVCSQTAZmlhvcsqtaz])([^MLHVCSQTAZmlhvcsqtaz]*)', d):
        vals = [float(v) for v in re.findall(r'-?\d*\.?\d+(?:e-?\d+)?', args)]
        if cmd in 'MLT':
            for i in range(0, len(vals) - 1, 2):
                x, y = vals[i], vals[i + 1]; xs.append(x); ys.append(y)
        elif cmd in 'CSQ':
            for i in range(0, len(vals) - 1, 2):
                xs.append(vals[i]); ys.append(vals[i + 1])
            if len(vals) >= 2:
                x, y = vals[-2], vals[-1]
        elif cmd == 'H':
            for v in vals:
                x = v; xs.append(x); ys.append(y)
        elif cmd == 'V':
            for v in vals:
                y = v; xs.append(x); ys.append(y)
        elif cmd in 'mlt':
            for i in range(0, len(vals) - 1, 2):
                x += vals[i]; y += vals[i + 1]; xs.append(x); ys.append(y)
        elif cmd in 'cs':
            step = 6 if cmd == 'c' else 4
            for i in range(0, len(vals) - step + 1, step):
                x += vals[i + step - 2]; y += vals[i + step - 1]; xs.append(x); ys.append(y)
        elif cmd == 'h':
            for v in vals:
                x += v; xs.append(x); ys.append(y)
        elif cmd == 'v':
            for v in vals:
                y += v; xs.append(x); ys.append(y)
        elif cmd in 'Aa':
            for i in range(0, len(vals) - 6, 7):
                if cmd == 'A':
                    x, y = vals[i + 5], vals[i + 6]
                else:
                    x += vals[i + 5]; y += vals[i + 6]
                xs.append(x); ys.append(y)
    if not xs:
        return (0, 0, 1, 1)
    return (min(xs), min(ys), max(max(xs) - min(xs), 1), max(max(ys) - min(ys), 1))


# ---------- gradients ----------

def parse_gradients(root):
    grads = {}
    for el in root.iter():
        t = tag(el)
        if t not in ('linearGradient', 'radialGradient'):
            continue
        stops = []
        for s in el:
            if tag(s) != 'stop':
                continue
            stops.append((num(s.get('offset')), s.get('stop-color', '#000'), num(s.get('stop-opacity'), 1.0)))
        grads[el.get('id')] = {'kind': t, 'attrs': dict(el.attrib), 'stops': stops}
    return grads


def gradient_fill(g, bbox, opacity):
    """AVG gradient in boundingBox units (userSpaceOnUse coordinates are mapped onto the shape's box)."""
    a = g['attrs']
    user = a.get('gradientUnits') == 'userSpaceOnUse'
    bx, by, bw, bh = bbox
    bw, bh = bw or 1, bh or 1
    colors = [hex_color(c, o * opacity) or '#00000000' for _, c, o in g['stops']]
    inputs = [round(off, 4) for off, _, _ in g['stops']]

    if g['kind'] == 'linearGradient':
        x1, y1 = num(a.get('x1'), 0), num(a.get('y1'), 0)
        x2, y2 = num(a.get('x2'), 1), num(a.get('y2'), 0)
        if user:
            x1, x2 = (x1 - bx) / bw, (x2 - bx) / bw
            y1, y2 = (y1 - by) / bh, (y2 - by) / bh
        return {'type': 'linear', 'colorRange': colors, 'inputRange': inputs,
                'x1': round(x1, 4), 'y1': round(y1, 4), 'x2': round(x2, 4), 'y2': round(y2, 4)}

    cx, cy, r = num(a.get('cx'), 0.5), num(a.get('cy'), 0.5), num(a.get('r'), 0.5)
    if user:
        cx, cy = (cx - bx) / bw, (cy - by) / bh
        r = r / max(bw, bh)
    return {'type': 'radial', 'colorRange': colors, 'inputRange': inputs,
            'centerX': round(cx, 4), 'centerY': round(cy, 4), 'radius': round(r, 4)}


def soft_fill(color, alpha, spread_inner=0.0):
    """Radial fade used in place of a Gaussian blur on round shapes."""
    c = hex_color(color, alpha)
    if c is None:
        return None
    return {'type': 'radial', 'colorRange': [c, hex_color(color, 0) or '#00000000'],
            'inputRange': [round(spread_inner, 3), 1], 'centerX': 0.5, 'centerY': 0.5, 'radius': 0.5}


# ---------- conversion ----------

class Converter:
    def __init__(self, root):
        self.root = root
        self.grads = parse_gradients(root)
        self.ids = {el.get('id'): el for el in root.iter() if el.get('id')}
        self.blurs = {}
        for el in root.iter():
            if tag(el) == 'filter':
                blur = next((c for c in el if tag(c) == 'feGaussianBlur'), None)
                if blur is not None:
                    self.blurs[el.get('id')] = num(blur.get('stdDeviation'), 0)

    def ref(self, value):
        m = re.match(r'url\(#([^)]+)\)', value or '')
        return m.group(1) if m else None

    def convert(self):
        items = []
        for child in self.root:
            items.extend(self.node(child, {}, 1.0, 0.0))
        return items

    def node(self, el, style, opacity, blur):
        t = tag(el)
        if t in ('defs', 'filter', 'linearGradient', 'radialGradient', 'clipPath', 'title', 'desc', 'stop'):
            return []
        style = dict(style)
        for k in INHERITED:
            if el.get(k) is not None:
                style[k] = el.get(k)
        own_opacity = num(el.get('opacity'), 1.0)
        f = self.ref(el.get('filter'))
        if f in self.blurs:
            blur = max(blur, self.blurs[f])

        if t == 'use':
            target = self.ids.get((el.get('href') or el.get('{http://www.w3.org/1999/xlink}href', '')).lstrip('#'))
            if target is None:
                return []
            inner = self.node(target, style, 1.0, blur)
            group = {'type': 'group', 'items': inner}
            transform = el.get('transform', '')
            if el.get('x') or el.get('y'):
                transform = f'translate({num(el.get("x"))} {num(el.get("y"))}) ' + transform
            if transform.strip():
                group['transform'] = transform.strip()
            if own_opacity < 1:
                group['opacity'] = own_opacity
            return [group]

        if t in ('g', 'svg', 'symbol'):
            children = []
            for c in el:
                children.extend(self.node(c, style, 1.0, blur))
            group = {'type': 'group', 'items': children}
            if el.get('transform'):
                group['transform'] = el.get('transform')
            if own_opacity < 1:
                group['opacity'] = round(own_opacity, 3)
            clip = self.ref(el.get('clip-path'))
            if clip and clip in self.ids:
                shapes = [shape_path(c)[0] for c in self.ids[clip] if shape_path(c)[0]]
                group['clipPath'] = ' '.join(shapes)
            if len(group) == 2 and t != 'svg':
                return children  # plain wrapper: flatten
            return [group]

        d, bbox = shape_path(el)
        if d is None:
            return []
        return [self.path(el, t, d, bbox, style, own_opacity * opacity, blur)]

    def path(self, el, t, d, bbox, style, opacity, blur):
        item = {'type': 'path', 'pathData': d}
        fill = style.get('fill', '#000000')
        fill_opacity = num(style.get('fill-opacity'), 1.0) * opacity
        stroke = style.get('stroke')

        if blur > 0 and t in ('circle', 'ellipse') and not self.ref(fill):
            # Grow the shape by the blur radius and fade it out from the centre.
            cx, cy = bbox[0] + bbox[2] / 2, bbox[1] + bbox[3] / 2
            rx, ry = bbox[2] / 2 + blur * 2, bbox[3] / 2 + blur * 2
            item['pathData'] = ellipse_path(cx, cy, rx, ry)
            inner = max(0.0, 1 - (blur * 2.5) / max(rx, ry))
            item['fill'] = soft_fill(fill, fill_opacity, inner * 0.6)
            if item['fill'] is None:
                item['fill'] = 'transparent'
            return item
        if blur > 0:
            fill_opacity *= 0.7

        gid = self.ref(fill)
        grad = self.grads.get(gid) if gid else None
        if grad and grad['kind'] == 'radialGradient' and grad['attrs'].get('gradientUnits') == 'userSpaceOnUse' \
                and abs(bbox[2] - bbox[3]) > 1 and not stroke:
            # AVG radial gradients use the shape's box, so on a wide shape a circular glow would
            # stretch into an oval. Paint the outer colour, then the glow as a true circle, clipped.
            a = grad['attrs']
            cx, cy, r = num(a.get('cx'), 0.5), num(a.get('cy'), 0.5), num(a.get('r'), 0.5)
            _, last_color, last_alpha = grad['stops'][-1]
            outer = hex_color(last_color, last_alpha * fill_opacity)
            circle = {'type': 'path', 'pathData': ellipse_path(cx, cy, r, r),
                      'fill': gradient_fill(grad, (cx - r, cy - r, 2 * r, 2 * r), fill_opacity)}
            parts = ([{'type': 'path', 'pathData': d, 'fill': outer}] if outer else []) + [circle]
            return {'type': 'group', 'clipPath': d, 'items': parts}
        if grad:
            item['fill'] = gradient_fill(grad, bbox, fill_opacity)
        else:
            c = hex_color(fill) if fill not in ('none', 'transparent') else None
            item['fill'] = c or 'transparent'
            if c and fill_opacity < 0.999:
                item['fillOpacity'] = round(fill_opacity, 3)

        if stroke and stroke != 'none':
            sid = self.ref(stroke)
            if sid and sid in self.grads:
                item['stroke'] = gradient_fill(self.grads[sid], bbox, opacity)
            else:
                item['stroke'] = hex_color(stroke)
                so = num(style.get('stroke-opacity'), 1.0) * opacity
                if so < 0.999:
                    item['strokeOpacity'] = round(so, 3)
            item['strokeWidth'] = num(style.get('stroke-width'), 1)
            if style.get('stroke-linecap'):
                item['strokeLineCap'] = style['stroke-linecap']
            if style.get('stroke-linejoin'):
                item['strokeLineJoin'] = style['stroke-linejoin']
        return item


def convert_file(path):
    root = ET.parse(path).getroot()
    _, _, w, h = (float(v) for v in root.get('viewBox').split())
    items = Converter(root).convert()
    return {'type': 'AVG', 'version': '1.2', 'width': w, 'height': h, 'items': items}


def main():
    art = {}
    for svg in sorted(SRC.glob('*.svg')):
        art[svg.stem] = convert_file(svg)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(art, separators=(',', ':'))
    OUT.write_text(text + '\n')
    sizes = {k: len(json.dumps(v, separators=(',', ':'))) for k, v in art.items()}
    print(f'wrote {OUT.relative_to(ROOT)} ({len(text) / 1024:.1f} KB)')
    for k, v in sizes.items():
        print(f'  {k:15} {v / 1024:5.1f} KB')


if __name__ == '__main__':
    sys.exit(main())
