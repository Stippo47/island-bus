"""One flat projection shared by the map, bus routes and stops, so they all line up.

x grows east, y grows south; one unit is about 20 metres.
"""
import math

LON0, LAT0 = -123.67, 48.95      # top-left corner of the map
LON1, LAT1 = -123.33, 48.665     # bottom-right corner
UNIT_M = 20.0
_K = 111320.0 / UNIT_M
_COS = math.cos(math.radians((LAT0 + LAT1) / 2))

WIDTH = round((LON1 - LON0) * _COS * _K)
HEIGHT = round((LAT0 - LAT1) * _K)


def project(lat, lon):
    return ((lon - LON0) * _COS * _K, (LAT0 - lat) * _K)


def simplify(points, tol):
    """Douglas-Peucker on [(x, y, ...)] keeping the first two values as the position."""
    if len(points) < 3:
        return list(points)
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = points[a][0], points[a][1]
        bx, by = points[b][0], points[b][1]
        dx, dy = bx - ax, by - ay
        ll = dx * dx + dy * dy
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            px, py = points[i][0], points[i][1]
            if ll == 0:
                d = math.hypot(px - ax, py - ay)
            else:
                d = abs(dy * px - dx * py + bx * ay - by * ax) / math.sqrt(ll)
            if d > best:
                best, bi = d, i
        if best > tol and bi > 0:
            keep[bi] = True
            stack.append((a, bi))
            stack.append((bi, b))
    return [p for p, k in zip(points, keep) if k]


def path_d(points, closed=False):
    out = []
    for i, p in enumerate(points):
        out.append(('M' if i == 0 else 'L') + f'{p[0]:.0f} {p[1]:.0f}')
    return ''.join(out) + ('Z' if closed else '')
