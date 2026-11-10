#!/usr/bin/env python3
"""
Builds the 2012 Toyota 4Runner SR5 (Magnetic Gray) used by the 4x4 route replay.

How it works
  1. Body shape: a signed-distance field built from three views and blended with rounded edges:
       - the side profile traced from a side-on photo (side_profile.json),
       - a cross-section (half width at each height) from published dimensions,
       - plan rounding of the four corners, plus swelling for the fender flares.
     Mirrors, rear spoiler and running boards are blended into the same field.
     Marching cubes turns the field into a mesh, which is smoothed and simplified.
  2. Paint: every detail (glass, pillars, grille, lights, chrome, panel gaps, badges) is
     described in 3D and baked into one texture atlas through five planar projections
     (left, right, front, rear, top), so the same feature lines up across projections.
  3. Wheels: BFGoodrich KO3 265/70R17 with raised white letters outboard, on the SR5's
     six-spoke 17" alloy.
  4. Output (assets/4runner/): model.bin (all meshes), body.jpg, body_spec.jpg, wheel.jpg.

Run:  python3 scripts/4runner/build.py      (needs numpy scipy scikit-image trimesh
      fast-simplification shapely matplotlib pillow)
Units are metres. Car faces +Z, +X is the driver's (left) side, +Y up, ground at y=0.
"""
import json, math, os, struct
import numpy as np
from scipy import ndimage
from scipy.interpolate import RegularGridInterpolator
from skimage import measure
import trimesh, fast_simplification
from matplotlib.path import Path
from shapely.geometry import Point, Polygon
from shapely import affinity
from PIL import Image, ImageDraw, ImageFont, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "..", "assets", "4runner")
FONT_B = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

# ---------------------------------------------------------------- colours (sRGB 0-255)
PAINT  = (82, 85, 90)   # Magnetic Gray Metallic (1G3), a touch lifted for the map lighting
GLASS  = (22, 27, 32)
BLACK  = (18, 19, 21)      # window frames, seals, mesh
TRIM   = (40, 42, 45)      # textured black plastic
CHROME = (214, 219, 224)
SILVER = (178, 183, 189)
RED    = (176, 18, 26)
AMBER  = (232, 140, 40)
LENS   = (196, 203, 210)

# ---------------------------------------------------------------- reference profile
P = json.load(open(os.path.join(HERE, "side_profile.json")))
def px2z(px): return np.interp(px, P["xmap"]["px"], P["xmap"]["z"])
def py2y(py): return (P["ground_px"] - np.asarray(py, float)) * P["yscale"]
_pz = px2z(np.array(P["x"])); _order = np.argsort(_pz)
PZ = _pz[_order]
PTOP = ndimage.gaussian_filter1d(py2y(np.array(P["top"]))[_order], 1.2)
PBOT = ndimage.gaussian_filter1d(py2y(np.array(P["bottom"]))[_order], 1.2)
# the roof line in the photo carries the roof-rail feet; replace it with a smooth fit
_roof = (PZ > -2.03) & (PZ < 0.40)
PTOP[_roof] = np.polyval(np.polyfit(PZ[_roof], ndimage.median_filter(PTOP, 61)[_roof], 3), PZ[_roof])
def ytop(z): return np.interp(z, PZ, PTOP, left=-1, right=-1)
def ybot(z): return np.interp(z, PZ, PBOT, left=9, right=9)
def poly_px(pts): return [(float(px2z(x)), float(py2y(y))) for x, y in pts]

FA, RA = 1.5165, -1.2775        # axle positions (wheelbase 2.794 m)
TIRE_R, TIRE_W = 0.4015, 0.265  # 265/70R17
TRACK = 1.60
WX = TRACK / 2                  # wheel centre |x|

# ---------------------------------------------------------------- body cross-section
SEC_Y  = np.array([0.28, 0.36, 0.46, 0.62, 0.95, 1.18, 1.27, 1.315, 1.345, 1.42, 1.60, 1.72, 1.775, 1.80])
SEC_HW = np.array([0.835, 0.885, 0.915, 0.928, 0.935, 0.932, 0.922, 0.905, 0.872, 0.852, 0.812, 0.772, 0.725, 0.62])
def hw_section(y): return np.interp(y, SEC_Y, SEC_HW)

def hw(y, z):
    """Half width of the body at height y, station z (before corner rounding)."""
    w = hw_section(y)
    gh = np.clip((y - 1.30) / 0.08, 0, 1)                                     # greenhouse only
    w = w * (1 - gh * (0.05 * np.clip((z - 0.35) / 0.7, 0, 1) + 0.035 * np.clip((-z - 1.75) / 0.3, 0, 1)))
    # fender flares: a raised lip around each wheel opening
    for c, cy in ((FA, 0.40), (RA, 0.40)):
        r = np.hypot(z - c, y - cy)
        lip = np.clip((r - 0.50) / 0.04, 0, 1) * np.clip((0.70 - r) / 0.10, 0, 1)
        w = w + 0.028 * lip * np.clip((1.04 - y) / 0.10, 0, 1)
    return w

# ---------------------------------------------------------------- field helpers
def smax(a, b, k):
    h = np.clip(0.5 + 0.5 * (a - b) / k, 0, 1)
    return b + (a - b) * h + k * h * (1 - h)
def smin(a, b, k):
    h = np.clip(0.5 + 0.5 * (b - a) / k, 0, 1)
    return b + (a - b) * h - k * h * (1 - h)
def sd_box(p, c, half, r=0.0):
    q = np.abs(p - c) - (np.asarray(half) - r)
    return np.linalg.norm(np.maximum(q, 0), axis=-1) + np.minimum(q.max(-1), 0) - r

H = 0.004  # side-mask resolution
def side_sdf(fill_arches=False):
    zs = np.arange(-2.50, 2.50 + H, H); ys = np.arange(0.0, 1.95 + H, H)
    t, b = ytop(zs), ybot(zs)
    if fill_arches:  # inner wheel-well liner: the opening only goes in so far
        for c in (FA, RA):
            near = np.abs(zs - c) < 0.62
            b = np.where(near, np.minimum(b, 0.52), b)
    Y = ys[:, None]
    m = (Y >= b[None, :]) & (Y <= t[None, :])
    d = (ndimage.distance_transform_edt(~m) - ndimage.distance_transform_edt(m)) * H
    return RegularGridInterpolator((ys, zs), d, bounds_error=False, fill_value=1.0), (ys, zs, m)

SIDE_OUT, SIDE_GRID = side_sdf(False)
SIDE_IN, _ = side_sdf(True)

def front_back(y):
    """Front-most / rear-most z of the side silhouette at height y."""
    ys, zs, m = SIDE_GRID
    i = np.clip(np.round(y / H).astype(int), 0, len(ys) - 1)
    rows = m[i]
    has = rows.any(-1)
    zf = np.where(has, zs[len(zs) - 1 - np.argmax(rows[:, ::-1], -1)], 0)
    zr = np.where(has, zs[np.argmax(rows, -1)], 0)
    return zf, zr

def body_field(X, Y, Z):
    """Signed distance (m, negative inside) of the painted body shell."""
    pts = np.stack([Y.ravel(), Z.ravel()], -1)
    ax = np.abs(X)
    inner = np.clip((0.70 - ax) / 0.04, 0, 1).ravel()          # 1 = inside the wheel-well liner
    ds = SIDE_OUT(pts) * (1 - inner) + np.minimum(SIDE_OUT(pts), SIDE_IN(pts)) * inner
    ds = ds.reshape(X.shape)
    w = hw(Y, Z)
    # plan rounding of the corners: shrink width near the nose and tail
    zf, zr = front_back(Y.ravel()); zf = zf.reshape(Y.shape); zr = zr.reshape(Y.shape)
    rf = np.where(Y < 1.25, 0.30, 0.18); rr = 0.17
    df = np.clip(Z - (zf - rf), 0, None); dr = np.clip((zr + rr) - Z, 0, None)
    w = w - (rf - np.sqrt(np.clip(rf**2 - df**2, 0, None))) - (rr - np.sqrt(np.clip(rr**2 - dr**2, 0, None)))
    dw = ax - w
    k = 0.045 + 0.06 * np.clip((Y - 1.55) / 0.2, 0, 1)            # rounder at the roof edge
    return smax(ds, dw, k)

# ---------------------------------------------------------------- add-on parts (in the field)
MIRROR_Z = float(px2z(462)); MIRROR_Y = float(py2y(220))
def parts(p):
    x, y, z = p[..., 0], p[..., 1], p[..., 2]
    q = np.stack([np.abs(x), y, z], -1)
    mirror = sd_box(q, np.array([1.0, MIRROR_Y, MIRROR_Z]), (0.085, 0.075, 0.05), 0.035)
    stalk = sd_box(q, np.array([0.90, MIRROR_Y - 0.04, MIRROR_Z + 0.02]), (0.06, 0.03, 0.03), 0.015)
    mirror = smin(mirror, stalk, 0.03)
    # rear roof spoiler: a thin wing sloping down toward the back
    zs0, zs1 = float(px2z(1238)), float(px2z(1318))
    t = np.clip((z - zs1) / (zs0 - zs1), 0, 1)
    yc = 1.792 - 0.07 * (1 - t)
    spoiler = sd_box(np.stack([x, y - yc, z], -1), np.array([0, 0, (zs0 + zs1) / 2]), (0.66, 0.026, (zs0 - zs1) / 2), 0.022)
    # running boards (SR5 Premium)
    board = sd_box(q, np.array([0.935, 0.315, (FA - 0.56 + RA + 0.56) / 2]), (0.075, 0.02, (FA - RA - 1.12) / 2), 0.012)
    return mirror, spoiler, board

def field(X, Y, Z):
    b = body_field(X, Y, Z)
    p = np.stack([X, Y, Z], -1)
    m, s, r = parts(p)
    f = smin(b, m, 0.025); f = smin(f, s, 0.03); f = np.minimum(f, r)
    return f, b, m, s, r

# ---------------------------------------------------------------- mesh
STEP = 0.011
GX = np.arange(-1.12, 1.12 + STEP, STEP); GY = np.arange(0.22, 1.90 + STEP, STEP); GZ = np.arange(-2.52, 2.52 + STEP, STEP)

def build_field():
    F = np.empty((len(GX), len(GY), len(GZ)), np.float32)
    Yg, Zg = np.meshgrid(GY, GZ, indexing="ij")
    for i, x in enumerate(GX):
        F[i] = field(np.full_like(Yg, x), Yg, Zg)[0]
    return F

def taubin(V, Fc, iters=8, lamb=0.5, mu=-0.53):
    """Taubin smoothing with a uniform Laplacian (keeps volume, removes voxel stair-steps)."""
    from scipy import sparse
    n = len(V); e = np.concatenate([Fc[:, [0, 1]], Fc[:, [1, 2]], Fc[:, [2, 0]]])
    e = np.concatenate([e, e[:, ::-1]])
    A = sparse.coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n)).tocsr()
    A.data[:] = 1.0
    deg = np.asarray(A.sum(1)).ravel(); deg[deg == 0] = 1
    for _ in range(iters):
        for f in (lamb, mu):
            V = V + f * (A @ V / deg[:, None] - V)
    return V

def make_body(F, target_faces=60000):
    F = ndimage.gaussian_filter(F, 0.6)
    v, f, n, _ = measure.marching_cubes(F, 0.0, spacing=(STEP, STEP, STEP))
    v += np.array([GX[0], GY[0], GZ[0]])
    m = trimesh.Trimesh(v, f, process=True)
    V = taubin(m.vertices.copy(), m.faces, 10)
    vs, fs = fast_simplification.simplify(V.astype(np.float32), m.faces.astype(np.int32),
                                          target_reduction=1 - target_faces / len(m.faces), agg=2)
    m = trimesh.Trimesh(vs, fs, process=True)
    m.vertices = taubin(m.vertices.copy(), m.faces, 3, 0.35, -0.37)
    # normals from the (smoothed) field gradient: immune to any folded triangles left by simplification
    g = np.stack(np.gradient(ndimage.gaussian_filter(F, 1.3), STEP), -1)
    gi = RegularGridInterpolator((GX, GY, GZ), g, bounds_error=False, fill_value=None)
    n = gi(m.vertices); n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)
    m.vertex_normals_field = n
    return m

# ---------------------------------------------------------------- 3D feature description (the "paint")
def side_features(fuel_door):
    """Features on the body sides, as polygons in (z, y)."""
    F = {}
    F["frame"] = poly_px([(421, 250), (548, 109), (941, 107), (967, 111), (1039, 229), (752, 238)])
    F["pane_front"] = poly_px([(449, 243), (561, 118), (744, 116), (744, 237)])
    F["pane_rear"] = poly_px([(787, 116), (957, 116), (967, 124), (1027, 226), (787, 233)])
    F["quarter_frame"] = poly_px([(1050, 105), (1249, 105), (1270, 111), (1304, 189), (1306, 207), (1293, 223), (1272, 226), (1138, 226), (1124, 216)])
    F["quarter"] = poly_px([(1055, 109), (1246, 109), (1265, 115), (1299, 190), (1301, 205), (1290, 219), (1272, 222), (1140, 222), (1128, 213)])
    F["tail_red"] = poly_px([(1296, 236), (1372, 236), (1378, 262), (1377, 291), (1318, 291), (1300, 262)])
    F["tail_clear"] = poly_px([(1318, 291), (1377, 291), (1372, 318), (1348, 316)])
    F["head"] = poly_px([(26, 292), (60, 286), (114, 283), (113, 300), (95, 318), (62, 333), (30, 338), (24, 316)])
    F["head_amber"] = poly_px([(66, 291), (112, 286), (110, 302), (92, 318), (68, 322)])
    F["handles"] = [poly_px([(661, 276), (738, 274), (741, 286), (738, 297), (663, 297), (659, 287)]),
                    poly_px([(947, 268), (1023, 266), (1026, 278), (1023, 290), (949, 290), (945, 279)])]
    F["seams"] = [poly_px([(408, 252), (407, 330), (408, 470), (412, 476)]),
                  poly_px([(752, 239), (753, 360), (757, 472)]),
                  poly_px([(1057, 232), (1057, 328), (1020, 338), (985, 352), (958, 388), (946, 430), (944, 472)]),
                  poly_px([(412, 476), (944, 476)]),
                  poly_px([(403, 236), (408, 252)])]
    F["fuel"] = poly_px([(1192, 276), (1244, 275), (1248, 300), (1245, 322), (1194, 323), (1190, 300)]) if fuel_door else None
    F["strip"] = (float(px2z(420)), float(px2z(912)), float(py2y(482)), float(py2y(476)))
    return F

def inpoly(poly, a, b):
    return Path(poly).contains_points(np.stack([a.ravel(), b.ravel()], -1)).reshape(a.shape)

def near_polyline(pl, a, b, w):
    d = np.full(a.shape, 9.0)
    for (a0, b0), (a1, b1) in zip(pl[:-1], pl[1:]):
        ab = np.array([a1 - a0, b1 - b0]); L2 = max(ab @ ab, 1e-12)
        t = np.clip(((a - a0) * ab[0] + (b - b0) * ab[1]) / L2, 0, 1)
        d = np.minimum(d, np.hypot(a - (a0 + t * ab[0]), b - (b0 + t * ab[1])))
    return d < w

HOOD_Y = 1.185

def shade(x, y, z, fuel_door):
    """Colour + specular for 3D points on the body surface. Every projection calls this, so features line up."""
    col = np.zeros(x.shape + (3,), np.float32); col[:] = PAINT
    spec = np.full(x.shape, 0.55, np.float32)
    def put(mask, c, s):
        col[mask] = c; spec[mask] = s
    ax = np.abs(x)
    W = hw(y, z)
    near_side = ax > W - 0.06
    on_mirror = (ax > 0.955) & (np.abs(z - MIRROR_Z) < 0.12) & (np.abs(y - MIRROR_Y) < 0.12)
    sideok = near_side & ~on_mirror

    # ---- windshield, cowl, hood shut lines
    ws = (z < 1.05) & (z > 0.45) & (y > 1.33) & (y < 1.748) & (ax < W - 0.075)
    put(ws, GLASS, 0.95)
    col[ws] += (np.clip(1 - np.abs(y[ws] - 1.55) / 0.15, 0, 1) * 16)[:, None]
    put((z < 1.08) & (z > 0.92) & (y > 1.30) & (y < 1.345) & (ax < 0.80), BLACK, 0.2)
    put((z > 1.1) & (z < 2.12) & (y > 1.15) & (np.abs(ax - 0.80) < 0.003), (52, 54, 58), 0.2)

    # ---- sides: windows, pillars, seams, handles, chrome strip, fuel door
    F = side_features(fuel_door)
    frame = inpoly(F["frame"], z, y) & sideok
    put(frame, BLACK, 0.2)
    for k in ("pane_front", "pane_rear"):
        put(inpoly(F[k], z, y) & sideok, GLASS, 0.95)
    put(near_polyline(poly_px([(966, 128), (962, 229)]), z, y, 0.008) & frame, BLACK, 0.2)
    put(inpoly(F["quarter_frame"], z, y) & sideok, BLACK, 0.2)
    put(inpoly(F["quarter"], z, y) & sideok, GLASS, 0.95)
    gl = sideok & (spec > 0.9)
    col[gl] += (np.clip(1 - np.abs(y[gl] - 1.62) / 0.12, 0, 1) * 18)[:, None]
    for sm in F["seams"]:
        put(near_polyline(sm, z, y, 0.0035) & sideok & ~frame, (52, 54, 58), 0.2)
    if fuel_door:
        put(near_polyline(F["fuel"] + [F["fuel"][0]], z, y, 0.003) & sideok, (58, 60, 64), 0.2)
    for h in F["handles"]:
        m = inpoly(h, z, y) & sideok; put(m, CHROME, 1.0)
        col[m & (y > np.mean([p[1] for p in h]))] += 22
    z0, z1, y0, y1 = F["strip"]
    put((z < z0) & (z > z1) & (y > y0) & (y < y1) & sideok, CHROME, 1.0)
    put(on_mirror & (z < MIRROR_Z - 0.03) & (ax > 0.94), (40, 48, 56), 1.0)   # mirror glass

    # ---- front face
    face = z > 1.95
    head = Path([(0.50, 0.985), (0.505, 1.118), (0.70, 1.140), (0.88, 1.168), (0.96, 1.148), (0.96, 1.08), (0.83, 1.00), (0.64, 0.975)])
    hm = face & (z > 2.02) & head.contains_points(np.stack([ax.ravel(), y.ravel()], -1)).reshape(x.shape)
    put(hm, LENS, 0.8)
    for cx, cy, r in ((0.60, 1.055, 0.048), (0.745, 1.075, 0.055)):
        d = np.hypot(ax - cx, y - cy)
        put(hm & (d < r), (150, 156, 162), 1.0); put(hm & (d < r * 0.55), (238, 242, 245), 1.0)
    put(hm & (ax > 0.86) & (y > 1.05), AMBER, 0.9)
    put(face & (z > 2.02) & near_polyline([(0.50, 1.122), (0.70, 1.144), (0.88, 1.172)], ax, y, 0.006), CHROME, 1.0)
    gt, gb = 1.150, 0.905
    grille = face & (y < gt) & (y > gb) & (ax < 0.40 + 0.09 * (y - gb) / (gt - gb))
    put(grille, BLACK, 0.15)
    put(grille & ((np.sin(ax * 260) * np.sin(y * 260 + ax * 130)) > 0.35), (58, 60, 64), 0.4)
    put(face & (y > 1.065) & (y < 1.105) & (ax < 0.47), CHROME, 1.0)
    intake = face & (y > 0.62) & (y < 0.80) & (ax < 0.43 - 0.06 * (0.80 - y) / 0.18)
    put(intake, BLACK, 0.15)
    put(intake & ((np.sin(ax * 240) * np.sin(y * 240 + ax * 120)) > 0.35), (58, 60, 64), 0.4)
    fog = face & (z > 2.1) & (ax > 0.56) & (ax < 0.82) & (y > 0.64) & (y < 0.765)
    put(fog, TRIM, 0.3)
    put(fog & (np.hypot(ax - 0.765, y - 0.703) < 0.042), LENS, 1.0)
    put(fog & (ax > 0.585) & (ax < 0.70) & (y > 0.675) & (y < 0.735), AMBER, 0.9)
    put(face & (y > 0.545) & (y < 0.565) & (ax < 0.74), CHROME, 1.0)
    put(face & (z > 2.0) & (y < 0.52), TRIM, 0.25)
    put(face & (np.abs(y - (HOOD_Y - 0.012)) < 0.003) & (ax < 0.86) & (z > 2.05), (52, 54, 58), 0.2)

    # ---- rear face
    back = z < -1.9
    gw = W - 0.10
    put(back & (y > 1.385) & (y < 1.73) & (ax < gw + 0.02) & (z < -2.0), BLACK, 0.2)
    rg = back & (z < -2.0) & (y > 1.40) & (y < 1.715) & (ax < gw)
    put(rg, GLASS, 0.95)
    col[rg] += (np.clip(1 - np.abs(y[rg] - 1.60) / 0.1, 0, 1) * 16)[:, None]
    tl = Path([(0.655, 1.335), (0.93, 1.335), (0.97, 1.20), (0.97, 1.00), (0.80, 0.995), (0.70, 1.13)])
    tm = back & (z < -2.22) & (ax < 0.90) & tl.contains_points(np.stack([ax.ravel(), y.ravel()], -1)).reshape(x.shape)
    put(tm, RED, 0.9)
    put(tm & (y < 1.075) & (ax < 0.88), LENS, 0.9)
    put(tm & (y > 1.06) & (y < 1.075), (120, 20, 25), 0.6)
    for pl in ([(0.665, 0.78), (0.665, 1.37)], [(-0.665, 0.78), (-0.665, 1.37)], [(-0.665, 0.78), (0.665, 0.78)]):
        put(back & (z < -2.2) & near_polyline(pl, x, y, 0.003), (52, 54, 58), 0.2)
    put(back & (z < -2.2) & (ax < 0.205) & (y > 0.905) & (y < 1.085), (70, 73, 78), 0.3)
    plate = back & (z < -2.2) & (ax < 0.152) & (y > 0.925) & (y < 1.075)
    put(plate, (232, 232, 226), 0.4)
    put(plate & ((ax > 0.142) | (y < 0.935) | (y > 1.065)), (60, 60, 64), 0.4)
    put(back & (z < -2.2) & (y > 1.105) & (y < 1.165) & (ax < 0.40), CHROME, 1.0)
    put(back & (z < -2.3) & (y > 0.745) & (y < 0.762) & (ax < 0.66), CHROME, 1.0)
    put(back & (z < -2.3) & (ax > 0.78) & (ax < 0.90) & (y > 0.585) & (y < 0.615), RED, 0.9)
    put(back & (z < -2.2) & (y < 0.50), TRIM, 0.25)
    put(back & (z < -2.2) & (ax < 0.045) & (y > 0.40) & (y < 0.47), (12, 12, 13), 0.1)

    sw = near_side & (ax > 0.86)
    put(sw & (z < -2.15) & inpoly(F["tail_red"], z, y), RED, 0.9)
    put(sw & (z < -2.15) & inpoly(F["tail_clear"], z, y), LENS, 0.9)
    put(sw & (z > 2.0) & inpoly(F["head"], z, y), LENS, 0.8)
    put(sw & (z > 2.0) & inpoly(F["head_amber"], z, y), AMBER, 0.9)
    col *= np.clip(0.82 + 0.18 * (y[..., None] - 0.3) / 0.25, 0.82, 1.0)   # rocker in shadow
    return col, spec

# ---------------------------------------------------------------- baking through planar projections
ATLAS = 2048
REG = {  # name: (col0, row0, width, height, axis-a range, axis-b range)
    "left":  (0, 0, 2048, 640, (2.50, -2.50), (1.92, 0.20)),     # u: z (front first), v: y (top first)
    "right": (0, 640, 2048, 640, (2.50, -2.50), (1.92, 0.20)),
    "front": (0, 1280, 1024, 512, (-1.08, 1.08), (1.92, 0.20)),  # u: x, v: y
    "rear":  (1024, 1280, 1024, 512, (1.08, -1.08), (1.92, 0.20)),
    "top":   (0, 1792, 2048, 256, (2.50, -2.50), (-1.08, 1.08)),  # u: z, v: x
}
PAD = 3

def region_uv(name, a, b):
    c0, r0, w, h, (a0, a1), (b0, b1) = REG[name]
    u = c0 + PAD + (a - a0) / (a1 - a0) * (w - 2 * PAD)
    v = r0 + PAD + (b - b0) / (b1 - b0) * (h - 2 * PAD)
    return u / ATLAS, 1 - v / ATLAS

def depth_maps(F):
    """Outer-surface coordinate along each projection axis, from the voxel field."""
    inside = F < 0
    def along(axis, from_max):
        arr = np.moveaxis(F, axis, -1); ins = np.moveaxis(inside, axis, -1)
        n = arr.shape[-1]; has = ins.any(-1)
        if from_max:
            i = n - 1 - np.argmax(ins[..., ::-1], -1)            # last inside sample
            j = np.minimum(i + 1, n - 1)
        else:
            i = np.argmax(ins, -1); j = np.maximum(i - 1, 0)
        fi = np.take_along_axis(arr, i[..., None], -1)[..., 0]; fj = np.take_along_axis(arr, j[..., None], -1)[..., 0]
        t = np.clip(fi / (fi - fj + 1e-9), 0, 1)
        g = (GX, GY, GZ)[axis]
        coord = g[i] + (g[j] - g[i]) * t
        return np.where(has, coord, np.nan)
    return {"x+": along(0, True), "z+": along(2, True), "z-": along(2, False), "y+": along(1, True)}

def sample2d(grid_a, grid_b, M, A, B):
    M = M.copy(); M[np.isnan(M)] = np.nanmedian(M)
    return RegularGridInterpolator((grid_a, grid_b), M, bounds_error=False, fill_value=None)(np.stack([A.ravel(), B.ravel()], -1)).reshape(A.shape)

def bake(F):
    ss = 2  # supersampling
    img = np.zeros((ATLAS * ss, ATLAS * ss, 3), np.float32); img[:] = PAINT
    spc = np.full((ATLAS * ss, ATLAS * ss), 0.55, np.float32)
    D = depth_maps(F)
    for name, (c0, r0, w, h, (a0, a1), (b0, b1)) in REG.items():
        W, Hh = w * ss, h * ss
        a = a0 + (np.arange(W) + 0.5 - PAD * ss) / (W - 2 * PAD * ss) * (a1 - a0)
        b = b0 + (np.arange(Hh) + 0.5 - PAD * ss) / (Hh - 2 * PAD * ss) * (b1 - b0)
        A, B = np.meshgrid(a, b)
        if name in ("left", "right"):
            d = sample2d(GY, GZ, D["x+"], B, A); col, s = shade(d, B, A, name == "left")
        elif name == "front":
            d = sample2d(GX, GY, D["z+"], A, B); col, s = shade(A, B, d, True)
        elif name == "rear":
            d = sample2d(GX, GY, D["z-"], A, B); col, s = shade(A, B, d, True)
        else:
            d = sample2d(GX, GZ, D["y+"], B, A); col, s = shade(B, d, A, True)
        img[r0 * ss:r0 * ss + Hh, c0 * ss:c0 * ss + W] = col
        spc[r0 * ss:r0 * ss + Hh, c0 * ss:c0 * ss + W] = s
    tex = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).resize((ATLAS, ATLAS), Image.LANCZOS)
    spec = Image.fromarray(np.clip(spc * 255, 0, 255).astype(np.uint8)).resize((ATLAS // 2, ATLAS // 2), Image.LANCZOS)
    tex = add_badges(tex)
    return tex, spec

def add_badges(tex):
    """Lettering and emblems drawn crisply on top of the bake."""
    d = ImageDraw.Draw(tex)
    def to_px(name, a, b):
        u, v = region_uv(name, a, b); return u * ATLAS, (1 - v) * ATLAS
    # 4RUNNER on the rear garnish (viewer's left = +x when seen from behind)
    font = ImageFont.truetype(FONT_B, 22)
    x0, y0 = to_px("rear", 0.33, 1.160); x1, y1 = to_px("rear", -0.33, 1.110)
    lab = Image.new("RGBA", (400, 40), (0, 0, 0, 0)); ImageDraw.Draw(lab).text((200, 20), "4RUNNER", font=ImageFont.truetype(FONT_B, 34), fill=(70, 74, 80, 255), anchor="mm")
    lab = lab.resize((int(x1 - x0), int(y1 - y0)), Image.LANCZOS); tex.paste(lab, (int(x0), int(y0)), lab)
    # Toyota emblems (three ovals)
    def emblem(cx, cy, sc):
        for rx, ry, wdt, oy in ((1.0, 0.68, 0.16, 0), (0.36, 0.58, 0.2, 0), (0.70, 0.30, 0.2, 0.28)):
            d.ellipse([cx - rx * sc, cy - ry * sc - oy * sc, cx + rx * sc, cy + ry * sc - oy * sc], outline=CHROME, width=max(1, int(wdt * sc)))
    ex, ey = to_px("front", 0.0, 1.085); emblem(ex, ey, 26)
    ex, ey = to_px("rear", 0.0, 1.265); emblem(ex, ey, 15)
    # SR5 badge on the tailgate, viewer's right
    sx, sy = to_px("rear", -0.47, 1.02)
    d.text((sx, sy), "SR5", font=ImageFont.truetype(FONT_B, 13), fill=CHROME, anchor="mm")
    return tex

# ---------------------------------------------------------------- UVs + export of the body
def uv_body(m):
    """Assign each face a projection + material, split vertices per projection, compute UVs."""
    V, Fc = m.vertices, m.faces
    fn = m.face_normals; cen = m.triangles_center
    vn = getattr(m, 'vertex_normals_field', None)
    if vn is None: vn = m.vertex_normals
    mat = np.zeros(len(Fc), np.int8)   # 0 painted atlas, 1 dark, 2 silver
    proj = np.full(len(Fc), -1)
    ax = np.abs(fn)
    side = (ax[:, 0] >= ax[:, 1]) & (ax[:, 0] >= ax[:, 2])
    fz = (ax[:, 2] > ax[:, 0]) & (ax[:, 2] >= ax[:, 1])
    up = (ax[:, 1] > ax[:, 0]) & (ax[:, 1] > ax[:, 2])
    proj[side & (fn[:, 0] > 0)] = 0; proj[side & (fn[:, 0] <= 0)] = 1
    proj[fz & (fn[:, 2] > 0)] = 2; proj[fz & (fn[:, 2] <= 0)] = 3
    proj[up & (fn[:, 1] > 0)] = 4
    down = up & (fn[:, 1] <= 0)
    mat[down & ((fn[:, 1] < -0.6) | (cen[:, 1] < 0.6))] = 1             # underside
    rest = down & (mat == 0)
    proj[rest & (fn[:, 0] > 0)] = 0; proj[rest & (fn[:, 0] <= 0)] = 1
    # wheel wells: points outside the side silhouette (inside an arch opening)
    so = SIDE_OUT(np.stack([cen[:, 1], cen[:, 2]], -1))
    mat[(so > 0.012) & (cen[:, 1] < 1.05)] = 1
    mat[(so > -0.008) & (fn[:, 1] < -0.15) & (cen[:, 1] < 1.0) & (cen[:, 1] > 0.45)] = 1
    # running boards
    p = cen.copy(); _, _, board = parts(p[None])
    mat[(board[0] < 0.006)] = 2
    names = ["left", "right", "front", "rear", "top"]
    outV, outN, outUV, outF, outM = [], [], [], [], []
    base = 0
    buckets = [(pi, 0, np.where((proj == pi) & (mat == 0))[0]) for pi in range(5)]
    buckets += [(-1, mi, np.where(mat == mi)[0]) for mi in (1, 2)]
    buckets += [(-1, 1, np.where((proj == -1) & (mat == 0))[0])]
    for pi, mi, sel in buckets:
        if len(sel) == 0: continue
        vid, inv = np.unique(Fc[sel].ravel(), return_inverse=True)
        pv = V[vid]
        if pi >= 0:
            nm = names[pi]
            if nm in ("left", "right"): u, v = region_uv(nm, pv[:, 2], pv[:, 1])
            elif nm in ("front", "rear"): u, v = region_uv(nm, pv[:, 0], pv[:, 1])
            else: u, v = region_uv(nm, pv[:, 2], pv[:, 0])
        else:
            u = np.zeros(len(vid)); v = np.zeros(len(vid))
        outV.append(pv); outN.append(vn[vid]); outUV.append(np.stack([u, v], -1))
        outF.append(inv.reshape(-1, 3) + base); outM.append(np.full(len(sel), mi))
        base += len(vid)
    V2 = np.concatenate(outV); N2 = np.concatenate(outN); UV2 = np.concatenate(outUV)
    F2 = np.concatenate(outF); M2 = np.concatenate(outM)
    order = np.argsort(M2, kind="stable")
    return V2, N2, UV2, F2[order], M2[order]

# ---------------------------------------------------------------- roof rails (explicit geometry)
def rails(F):
    """Silver roof rails on feet that sit on the roof surface."""
    gi = RegularGridInterpolator((GX, GY, GZ), F, bounds_error=False, fill_value=1.0)
    def roof_y(x, z):
        ys = np.arange(1.95, 1.4, -0.002); v = gi(np.stack([np.full_like(ys, x), ys, np.full_like(ys, z)], -1))
        return float(ys[np.argmax(v < 0)])
    parts_ = []
    z0, z1 = float(px2z(775)), float(px2z(1228)); RX = 0.64; top = 1.845
    for sx in (1, -1):
        parts_.append(trimesh.creation.cylinder(radius=0.017, segment=[[sx * RX, top, z0 - 0.07], [sx * RX, top, z1 + 0.07]], sections=12))
        for zc in (z0, z1):
            ry = roof_y(sx * RX, zc); h = top - ry + 0.025
            foot = trimesh.creation.box(extents=(0.05, h, 0.20)); foot.apply_translation((sx * RX, ry - 0.01 + h / 2, zc)); parts_.append(foot)
    return trimesh.util.concatenate(parts_)

# ---------------------------------------------------------------- wheel: KO3 tire + six-spoke alloy
def lathe(profile, seg=72):
    """profile: list of (radius, axial) -> mesh around the X axis."""
    pr = np.array(profile, float); n = len(pr)
    th = np.linspace(0, 2 * np.pi, seg, endpoint=False)
    V = np.zeros((seg * n, 3))
    for i, t in enumerate(th):
        V[i * n:(i + 1) * n] = np.stack([pr[:, 1], pr[:, 0] * np.cos(t), pr[:, 0] * np.sin(t)], -1)
    F = []
    for i in range(seg):
        j = (i + 1) % seg
        for k in range(n - 1):
            a, b, c, d = i * n + k, i * n + k + 1, j * n + k, j * n + k + 1
            F += [[a, c, b], [b, c, d]]
    return trimesh.Trimesh(V, np.array(F), process=False)

def tread_block(th0, th1, ax0, ax1, r0, r1, skew=0.0):
    """A lug spanning angles th0..th1, axial ax0..ax1, from radius r0 to r1 (skew twists it)."""
    corners = []
    for r in (r0, r1):
        for (t, a) in ((th0, ax0), (th1 + skew, ax0), (th1, ax1), (th0 - skew, ax1)):
            corners.append([a, r * np.cos(t), r * np.sin(t)])
    V = np.array(corners)
    F = np.array([[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]])
    return trimesh.Trimesh(V, F, process=False)

RIM_R = 0.2159; SW_A = 0.118  # 17" rim; sidewall face offset from centre
def tire():
    prof = [(RIM_R + 0.004, -SW_A + 0.01), (RIM_R + 0.012, -SW_A - 0.004), (0.30, -SW_A - 0.012), (0.36, -SW_A - 0.008),
            (0.383, -0.110), (0.392, -0.095), (0.392, 0.095), (0.383, 0.110), (0.36, SW_A + 0.008), (0.30, SW_A + 0.012),
            (RIM_R + 0.012, SW_A + 0.004), (RIM_R + 0.004, SW_A - 0.01)]
    base = lathe(prof, 96)
    blocks = []
    N = 34; dth = 2 * np.pi / N
    for i in range(N):
        t = i * dth
        # KO3: chunky shoulder blocks alternating long/short, interlocking centre blocks
        for side in (1, -1):
            long_ = i % 2 == 0
            a0, a1 = (0.052, 0.112) if long_ else (0.064, 0.112)
            blocks.append(tread_block(t + 0.04 * dth, t + 0.78 * dth, side * a0, side * a1, 0.389, 0.4015, 0.05 * side))
            # shoulder lugs wrapping onto the sidewall
            blocks.append(tread_block(t + 0.10 * dth, t + 0.70 * dth, side * 0.108, side * 0.122, 0.352 if long_ else 0.366, 0.394))
        off = 0.5 * dth if i % 2 else 0
        blocks.append(tread_block(t + off + 0.06 * dth, t + off + 0.70 * dth, -0.046, 0.004, 0.389, 0.4015, 0.06))
        blocks.append(tread_block(t + 0.5 * dth - off + 0.06 * dth, t + 0.5 * dth - off + 0.70 * dth, 0.0, 0.046, 0.389, 0.4015, -0.06))
    return base, trimesh.util.concatenate(blocks)

def rim():
    outer = Point(0, 0).buffer(RIM_R - 0.012, 64)
    windows = []
    for k in range(6):
        a = k * np.pi / 3 + np.pi / 6
        w = Polygon([(0.085, -0.028), (0.178, -0.072), (0.188, 0), (0.178, 0.072), (0.085, 0.028)]).buffer(0.010, 8)
        windows.append(affinity.rotate(w, a, origin=(0, 0), use_radians=True))
    face = outer
    for w in windows: face = face.difference(w)
    face = face.difference(Point(0, 0).buffer(0.032, 24))
    m = trimesh.creation.extrude_polygon(face, 0.022)                 # in XY, extruded along Z
    # map: polygon plane (x,y) -> wheel (y,z), extrusion -> axial x
    R = np.array([[0, 0, 1], [1, 0, 0], [0, 1, 0]])
    m.vertices = m.vertices @ R.T
    m.apply_translation((0.040, 0, 0))
    # dished barrel and lip
    barrel = lathe([(RIM_R - 0.012, 0.062), (RIM_R + 0.004, 0.080), (RIM_R + 0.004, 0.090), (RIM_R - 0.006, 0.090), (RIM_R - 0.014, 0.05), (RIM_R - 0.014, -0.11)], 64)
    hub = lathe([(0.0, 0.070), (0.03, 0.070), (0.036, 0.062), (0.036, 0.04)], 24)
    lugs = []
    for k in range(6):
        a = k * np.pi / 3
        c = trimesh.creation.cylinder(radius=0.0085, height=0.02, sections=6)
        c.apply_transform(trimesh.transformations.rotation_matrix(np.pi / 2, (0, 1, 0)))
        c.apply_translation((0.068, 0.055 * np.cos(a), 0.055 * np.sin(a))); lugs.append(c)
    return trimesh.util.concatenate([m, barrel, hub] + lugs)

def wheel_inner():
    """Dark brake/hub disc behind the spokes so the windows don't see through."""
    return lathe([(0.0, -0.01), (RIM_R - 0.015, -0.01)], 48)

def wheel_texture():
    """Sidewall texture: rubber with raised white BFGoodrich KO3 lettering, planar over the outer face."""
    S = 1024; img = Image.new("RGB", (S, S), (26, 26, 27)); d = ImageDraw.Draw(img)
    c = S / 2; sc = S / 2 / 0.41
    for r in np.arange(0.24, 0.40, 0.004):   # subtle sidewall shading rings
        g = int(24 + 10 * math.sin((r - 0.24) / 0.16 * math.pi))
        d.ellipse([c - r * sc, c - r * sc, c + r * sc, c + r * sc], outline=(g, g, g + 1), width=3)
    def arc_text(text, radius, size, ang0, color=(238, 238, 232), spacing=1.0):
        f = ImageFont.truetype(FONT_B, size)
        widths = [f.getlength(ch) for ch in text]
        total = sum(widths) * spacing
        ang = ang0 - total / 2 / (radius * sc)
        for ch, w in zip(text, widths):
            a = ang + w * spacing / 2 / (radius * sc)
            g = Image.new("RGBA", (size * 2, size * 2), (0, 0, 0, 0))
            ImageDraw.Draw(g).text((size, size), ch, font=f, fill=color + (255,), anchor="mm")
            g = g.rotate(-math.degrees(a) - 90, resample=Image.BICUBIC)
            x = c + radius * sc * math.cos(a) - size; y = c + radius * sc * math.sin(a) - size
            img.paste(g, (int(x), int(y)), g)
            ang += w * spacing / (radius * sc)
    for base in (-math.pi / 2, math.pi / 2):
        arc_text("BFGoodrich", 0.325, 54, base, spacing=1.04)
        arc_text("All-Terrain T/A KO3", 0.288, 26, base + math.pi / 2, spacing=1.05)
    return img

def wheel_mesh():
    base, blocks = tire()
    tire_m = trimesh.util.concatenate([base, blocks])
    # planar UV over the outer sidewall (y,z); inner side and tread use the dark border
    tv = tire_m.vertices
    uv = np.stack([0.5 - tv[:, 2] / 0.82, 0.5 + tv[:, 1] / 0.82], -1)
    inner_or_tread = (tv[:, 0] < SW_A - 0.02)
    uv[inner_or_tread] = [0.02, 0.02]
    rim_m = rim(); dark = wheel_inner()
    return tire_m, uv, rim_m, dark

# ---------------------------------------------------------------- binary export
def pack(meshes):
    """meshes: list of dicts {name, V, N, UV|None, F, groups:[(start,count,material)]}"""
    hdr = {"meshes": []}; blobs = []; off = 0
    def add(arr):
        nonlocal off
        b = arr.tobytes(); pad = (-len(b)) % 4
        blobs.append(b + b"\0" * pad); o = off; off += len(b) + pad; return o
    for m in meshes:
        V = m["V"].astype(np.float32); sc = float(np.abs(V).max()) * 1.0001
        q = np.round(V / sc * 32767).astype(np.int16)
        N = m["N"]; N = N / np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-9)
        e = {"name": m["name"], "count": len(V), "scale": sc, "pos": add(q), "nrm": add(np.round(N * 127).astype(np.int8))}
        if m.get("UV") is not None:
            e["uv"] = add(np.round(np.clip(m["UV"], 0, 1) * 65535).astype(np.uint16))
        idx = m["F"].astype(np.uint32 if len(V) > 65535 else np.uint16).ravel()
        e["index"] = add(idx); e["indexType"] = 32 if len(V) > 65535 else 16; e["indexCount"] = len(idx)
        e["groups"] = m["groups"]
        hdr["meshes"].append(e)
    hj = json.dumps(hdr).encode(); hj += b" " * ((-len(hj)) % 4)
    return struct.pack("<4sI", b"4RNR", len(hj)) + hj + b"".join(blobs)

def groups_from(M):
    g = []
    for mi in np.unique(M):
        idx = np.where(M == mi)[0]; g.append([int(idx[0] * 3), int(len(idx) * 3), int(mi)])
    return g

def main():
    os.makedirs(OUT, exist_ok=True)
    print("field…"); F = build_field()
    print("mesh…"); body = make_body(F)
    print("  body faces", len(body.faces))
    print("bake…"); tex, spec = bake(F)
    tex.save(os.path.join(OUT, "body.jpg"), quality=88, optimize=True, progressive=True)
    spec.save(os.path.join(OUT, "body_spec.jpg"), quality=85, optimize=True)
    V, N, UV, Fc, M = uv_body(body)
    rr = rails(F); rr.fix_normals()
    rv = rr.vertices; rn = rr.vertex_normals; rf = rr.faces + len(V)
    V = np.concatenate([V, rv]); N = np.concatenate([N, rn]); UV = np.concatenate([UV, np.zeros((len(rv), 2))])
    Fc = np.concatenate([Fc, rf]); M = np.concatenate([M, np.full(len(rf), 2)])
    order = np.argsort(M, kind="stable"); Fc, M = Fc[order], M[order]
    tire_m, tuv, rim_m, dark = wheel_mesh()
    wV = np.concatenate([tire_m.vertices, rim_m.vertices, dark.vertices])
    wN = np.concatenate([tire_m.vertex_normals, rim_m.vertex_normals, np.tile([[1, 0, 0]], (len(dark.vertices), 1))])
    wUV = np.concatenate([tuv, np.zeros((len(rim_m.vertices), 2)), np.zeros((len(dark.vertices), 2))])
    o1 = len(tire_m.vertices); o2 = o1 + len(rim_m.vertices)
    wF = np.concatenate([tire_m.faces, rim_m.faces + o1, dark.faces + o2])
    wM = np.concatenate([np.zeros(len(tire_m.faces)), np.ones(len(rim_m.faces)), np.full(len(dark.faces), 2)]).astype(int)
    blob = pack([
        {"name": "body", "V": V, "N": N, "UV": UV, "F": Fc, "groups": groups_from(M)},
        {"name": "wheel", "V": wV, "N": wN, "UV": wUV, "F": wF, "groups": groups_from(wM)},
    ])
    open(os.path.join(OUT, "model.bin"), "wb").write(blob)
    wheel_texture().save(os.path.join(OUT, "wheel.jpg"), quality=85, optimize=True)
    info = {"axles": [FA, RA], "wheelX": WX, "tireR": TIRE_R}
    print("done", {k: os.path.getsize(os.path.join(OUT, k)) for k in os.listdir(OUT)}, info)

if __name__ == "__main__":
    main()
