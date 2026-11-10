#!/usr/bin/env python3
"""
Builds the 1998 Lexus LX 470 (Green Mica Pearl, gray lower cladding) for the route replay.
Same engine as scripts/4runner/build.py.

How it works
  1. Body shape: a signed-distance field built from three views and blended with rounded edges:
       - the side profile traced by hand from a side-on photo (side_profile.json),
       - a cross-section (half width at each height) from published dimensions,
       - plan rounding of the four corners, plus swelling for the fender flares.
     Mirrors and the rear roof spoiler are blended into the same field. No running boards.
     Marching cubes turns the field into a mesh, which is smoothed and simplified.
  2. Paint: every detail (two-tone cladding, glass, pillars, grille, lamps, seams, badges) is
     described in 3D and baked into one texture atlas through five planar projections.
  3. Wheels: BFGoodrich KO2 275/70R16 (black sidewall) on bronze six-spoke 16" wheels.
  4. Output (assets/lx470/): model.bin, body.jpg, body_spec.jpg, wheel.jpg, meta.json.

Run:  python3 scripts/lx470/build.py
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
OUT = os.path.join(HERE, "..", "..", "assets", "lx470")
FONT_B = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

# ---------------------------------------------------------------- colours (sRGB 0-255)
PAINT  = (26, 48, 40)      # Green Mica Pearl (6R1)
CLAD   = (66, 68, 70)      # Medium Gray Metallic lower cladding
GLASS  = (22, 27, 32)
BLACK  = (18, 19, 21)
TRIM   = (40, 42, 45)
SEAM   = (14, 24, 20)
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
PBOT = ndimage.gaussian_filter1d(py2y(np.array(P["bottom"]))[_order], 0.8)
def ytop(z): return np.interp(z, PZ, PTOP, left=-1, right=-1)
def ybot(z): return np.interp(z, PZ, PBOT, left=9, right=9)
def poly_px(pts): return [(float(px2z(x)), float(py2y(y))) for x, y in pts]

FA, RA = P["xmap"]["z"][1], P["xmap"]["z"][2]   # axles (wheelbase 2.845 m)
TIRE_R, TIRE_W = 0.3957, 0.275  # 275/70R16
TRACK = 1.626                   # 64 in
WX = TRACK / 2

# ---------------------------------------------------------------- body cross-section
SEC_Y  = np.array([0.30, 0.40, 0.55, 0.90, 1.10, 1.17, 1.215, 1.245, 1.40, 1.60, 1.74, 1.80, 1.835])
SEC_HW = np.array([0.900, 0.945, 0.962, 0.962, 0.955, 0.945, 0.925, 0.892, 0.873, 0.845, 0.805, 0.760, 0.64])
def hw_section(y): return np.interp(y, SEC_Y, SEC_HW)

def hw(y, z):
    """Half width of the body at height y, station z (before corner rounding)."""
    w = hw_section(y)
    gh = np.clip((y - 1.23) / 0.08, 0, 1)                                     # greenhouse only
    w = w * (1 - gh * (0.045 * np.clip((z - 0.35) / 0.6, 0, 1) + 0.03 * np.clip((-z - 1.95) / 0.3, 0, 1)))
    # fender flares: a raised lip around each wheel opening
    for c, cy in ((FA, 0.40), (RA, 0.40)):  # subtle on the LX; the cladding does the work
        r = np.hypot(z - c, y - cy)
        lip = np.clip((r - 0.47) / 0.04, 0, 1) * np.clip((0.66 - r) / 0.10, 0, 1)
        w = w + 0.014 * lip * np.clip((1.04 - y) / 0.10, 0, 1)
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
            near = np.abs(zs - c) < 0.58
            b = np.where(near, np.minimum(b, 0.56), b)
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
    inner = np.clip((0.68 - ax) / 0.04, 0, 1).ravel()          # 1 = inside the wheel-well liner
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
MIRROR_Z = float(px2z(421)); MIRROR_Y = float(py2y(346))
def parts(p):
    x, y, z = p[..., 0], p[..., 1], p[..., 2]
    q = np.stack([np.abs(x), y, z], -1)
    mirror = sd_box(q, np.array([1.03, MIRROR_Y, MIRROR_Z]), (0.075, 0.09, 0.05), 0.035)
    stalk = sd_box(q, np.array([0.93, MIRROR_Y - 0.05, MIRROR_Z + 0.02]), (0.06, 0.03, 0.03), 0.015)
    mirror = smin(mirror, stalk, 0.03)
    # rear roof spoiler: a thin wing sloping down toward the back
    zs0, zs1 = float(px2z(1085)), float(px2z(1153))
    t = np.clip((z - zs1) / (zs0 - zs1), 0, 1)
    yc = float(py2y(204)) - 0.07 * (1 - t)
    spoiler = sd_box(np.stack([x, y - yc, z], -1), np.array([0, 0, (zs0 + zs1) / 2]), (0.70, 0.024, (zs0 - zs1) / 2), 0.02)
    return mirror, spoiler

def bumpers(b, Y, Z):
    """Front and rear bumpers as separate gray mouldings standing proud of the body (like the real wrap-around covers)."""
    fy0, fy1, fz = 0.43, float(py2y(478)), float(px2z(99))        # front: below the lamps, ahead of the front arch
    ry0, ry1, rz = 0.41, float(py2y(495)), float(px2z(1071))      # rear: below the quarter cladding, behind the rear arch
    regf = np.maximum.reduce([fy0 - Y, Y - fy1, fz - Z])
    regr = np.maximum.reduce([ry0 - Y, Y - ry1, Z - rz])
    front = smax(b - 0.024, regf, 0.012)
    rear = smax(b - 0.030, regr, 0.012)
    return np.minimum(front, rear)

def field(X, Y, Z):
    b = body_field(X, Y, Z)
    p = np.stack([X, Y, Z], -1)
    m, s = parts(p)
    f = smin(b, m, 0.025); f = smin(f, s, 0.03)
    f = np.minimum(f, bumpers(b, Y, Z))
    return f, b, m, s

# ---------------------------------------------------------------- mesh
STEP = 0.011
GX = np.arange(-1.12, 1.12 + STEP, STEP); GY = np.arange(0.25, 1.94 + STEP, STEP); GZ = np.arange(-2.52, 2.52 + STEP, STEP)

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
    """Features on the body sides, as polygons in (z, y), traced from the photo (px)."""
    F = {}
    F["frame_front"] = poly_px([(430, 368), (537, 226), (676, 226), (676, 366)])
    F["pane_front"] = poly_px([(442, 362), (538, 238), (659, 237), (659, 362)])
    F["frame_rear"] = poly_px([(678, 226), (892, 226), (892, 365), (678, 366)])
    F["panes_rear"] = [poly_px([(684, 232), (825, 232), (825, 361), (684, 362)]), poly_px([(833, 232), (886, 232), (886, 361), (833, 361)])]
    F["quarter_frame"] = poly_px([(893, 220), (1092, 220), (1122, 248), (1133, 290), (1131, 325), (1116, 350), (1100, 356), (900, 357)])
    F["quarter"] = poly_px([(899, 225), (1088, 225), (1116, 251), (1127, 290), (1125, 321), (1111, 345), (1098, 350), (904, 351)])
    F["louver"] = poly_px([(1132, 324), (1188, 324), (1191, 347), (1128, 347)])
    F["tail_red"] = poly_px([(1186, 412), (1196, 396), (1219, 392), (1221, 467), (1189, 469), (1184, 440)])
    F["tail_clear"] = poly_px([(1196, 396), (1206, 387), (1219, 392), (1219, 412), (1192, 414)])
    F["turn"] = poly_px([(45, 413), (80, 412), (82, 424), (70, 450), (48, 456)])
    F["handles"] = [poly_px([(572, 400), (640, 398), (642, 415), (574, 417)]), poly_px([(828, 397), (896, 395), (898, 412), (830, 414)])]
    F["seams"] = [poly_px([(375, 350), (374, 450), (375, 556)]),
                  poly_px([(657, 366), (656, 470), (656, 556)]),
                  poly_px([(907, 358), (912, 420), (915, 450), (895, 468), (867, 478), (850, 490)]),
                  poly_px([(387, 348), (375, 350)])]
    F["fuel"] = poly_px([(1069, 398), (1108, 396), (1113, 401), (1113, 432), (1108, 436), (1072, 437), (1067, 432), (1067, 402)])
    F["clad_ribs"] = [py2y(505), py2y(522), py2y(537)]
    F["clad_strip"] = (py2y(489), py2y(484))
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

Z_NOSE = float(px2z(43)); Z_FBUMP = float(px2z(22)); Z_TAIL = float(px2z(1219)); Z_RBUMP = float(px2z(1235))
CLAD_Y = float(py2y(481)); CLAD_Y_REAR = float(py2y(472)); FBUMP_TOP = float(py2y(478))
HOOD_FRONT_Y = float(py2y(393))
WS_Z0, WS_Z1 = float(px2z(387)), float(px2z(545))

def shade(x, y, z, fuel_door):
    """Colour + specular for 3D points on the body surface. Every projection calls this, so features line up."""
    col = np.zeros(x.shape + (3,), np.float32); col[:] = PAINT
    spec = np.full(x.shape, 0.6, np.float32)
    def put(mask, c, s):
        col[mask] = c; spec[mask] = s
    ax = np.abs(x)
    W = hw(y, z)
    near_side = ax > W - 0.06
    on_mirror = (ax > 0.98) & (np.abs(z - MIRROR_Z) < 0.13) & (np.abs(y - MIRROR_Y) < 0.13)
    sideok = near_side & ~on_mirror

    # ---- two-tone: gray cladding on the lower body, bumpers and around the arches
    clad = (y < np.where(z < RA - 0.42, CLAD_Y_REAR, CLAD_Y)) | (z > Z_NOSE + 0.03) & (y < FBUMP_TOP) | (z < Z_TAIL - 0.01) & (y < CLAD_Y_REAR + 0.02)
    put(clad, CLAD, 0.5)
    F = side_features(fuel_door)
    a0, a1 = F["clad_strip"]
    put(sideok & (y < a0) & (y > a1) & (z < float(px2z(300))) & (z > float(px2z(1062))), SILVER, 1.0)
    for ry in F["clad_ribs"]:
        put(sideok & clad & (np.abs(y - ry) < 0.003) & (z < float(px2z(330))) & (z > float(px2z(845))), (70, 72, 75), 0.3)

    # ---- windshield, cowl, hood shut lines
    ws = (z < WS_Z0) & (z > WS_Z1) & (y > float(py2y(345))) & (y < float(py2y(222))) & (ax < W - 0.08)
    put(ws, GLASS, 0.95)
    col[ws] += (np.clip(1 - np.abs(y[ws] - 1.55) / 0.15, 0, 1) * 16)[:, None]
    put((z < WS_Z0 + 0.10) & (z > WS_Z0 - 0.04) & (y > float(py2y(356))) & (y < float(py2y(343))) & (ax < 0.84), BLACK, 0.2)
    put((z > WS_Z0 + 0.10) & (z < Z_NOSE - 0.05) & (y > 1.05) & (np.abs(ax - 0.82) < 0.003), SEAM, 0.2)

    # ---- sides: windows, pillars, seams, handles, fuel door, louver
    for k in ("frame_front", "frame_rear", "quarter_frame"):
        put(inpoly(F[k], z, y) & sideok, BLACK, 0.2)
    for pn in [F["pane_front"], F["quarter"]] + F["panes_rear"]:
        put(inpoly(pn, z, y) & sideok, GLASS, 0.95)
    gl = sideok & (spec > 0.9)
    col[gl] += (np.clip(1 - np.abs(y[gl] - 1.60) / 0.12, 0, 1) * 18)[:, None]
    put(inpoly(F["louver"], z, y) & sideok, TRIM, 0.3)
    lv = inpoly(F["louver"], z, y) & sideok & (np.sin((y - float(py2y(347))) * 2 * np.pi / 0.018) > 0.3)
    put(lv, (12, 13, 14), 0.2)
    for sm in F["seams"]:
        put(near_polyline(sm, z, y, 0.0035) & sideok, SEAM, 0.2)
    if fuel_door:
        put(near_polyline(F["fuel"] + [F["fuel"][0]], z, y, 0.003) & sideok, SEAM, 0.2)
    for h in F["handles"]:
        m = inpoly(h, z, y) & sideok; put(m, tuple(int(c * 0.72) for c in PAINT), 0.9)
        put(m & (y < np.mean([p[1] for p in h]) - 0.008), (14, 15, 16), 0.2)
    put(on_mirror & (z < MIRROR_Z - 0.03) & (ax > 0.97), (40, 48, 56), 1.0)   # mirror glass
    sw = near_side & (ax > 0.88)
    put(sw & (z < Z_TAIL + 0.15) & inpoly(F["tail_red"], z, y), RED, 0.9)
    put(sw & (z < Z_TAIL + 0.15) & inpoly(F["tail_clear"], z, y), LENS, 0.9)
    put(sw & (z > Z_NOSE - 0.2) & inpoly(F["turn"], z, y), AMBER, 0.9)

    # ---- front face (LX 470), measured from a straight-on front photo (scaled by the 76 in body width):
    #      a wide trapezoid grille (much wider at the top) with a chrome ring, seven thin chrome bars on black and a big
    #      Lexus L; each side a small inner lamp angled along the grille edge and a big outer lamp (projector + amber
    #      corner); a body-colour strip, then the gray bumper with plate recess, two-slot intakes and rectangular fog lamps.
    face = z > Z_NOSE - 0.10
    def poly(pts):
        return face & Path(pts).contains_points(np.stack([ax.ravel(), y.ravel()], -1)).reshape(x.shape)
    GT, GB = 1.058, 0.812
    gw = lambda yy: 0.395 + 0.087 * np.clip((yy - GB) / (GT - GB), 0, 1)        # half width: 0.395 at the bottom, 0.482 at the top
    def trap_in(pad, r_top, r_bot):
        a0, a1 = GB + pad, GT - pad; hw_ = gw(y) - pad
        inside = (ax < hw_) & (y > a0) & (y < a1)
        cut = np.zeros_like(inside)
        for cy, r in ((a1 - r_top, r_top), (a0 + r_bot, r_bot)):
            cx = gw(cy) - pad - r
            zone = (ax > cx) & ((y > cy) if cy > (a0 + a1) / 2 else (y < cy))
            cut |= zone & (np.hypot(ax - cx, y - cy) > r)
        return face & inside & ~cut
    put(trap_in(0.0, 0.03, 0.055), CHROME, 1.0)
    g_in = trap_in(0.016, 0.02, 0.04)
    put(g_in, (10, 11, 12), 0.3)
    t = np.mod((y - GB - 0.026) / 0.0305, 1.0)
    bars = g_in & (t < 0.27) & (y > GB + 0.02) & (y < GT - 0.02)
    put(bars, (176, 181, 187), 1.0)
    put(bars & (t < 0.1), (222, 226, 230), 1.0)                                    # bright top edge of each bar
    put(g_in & (np.abs(np.mod(ax + 0.06, 0.12) - 0.06) < 0.0025), (26, 27, 29), 0.3)   # faint vertical dividers
    put(face & (np.hypot(ax / 0.084, (y - 0.944) / 0.056) < 1.0), (12, 13, 14), 0.4)    # clear the bars behind the emblem

    # inner lamp: rounded quadrilateral whose inner edge runs parallel to the grille side
    inner_l = poly([(0.445, 0.830), (0.598, 0.830), (0.614, 0.846), (0.612, 0.982), (0.598, 0.995), (0.494, 0.990), (0.478, 0.976)])
    # outer lamp: taller, top edge rising toward the outside, wraps the corner
    outer_l = poly([(0.628, 0.824), (0.900, 0.824), (0.918, 0.842), (0.922, 1.030), (0.902, 1.046), (0.700, 1.036), (0.640, 1.022), (0.626, 1.004)])
    for lm in (inner_l, outer_l):
        put(lm, (168, 174, 180), 0.75)                                             # clear lens over a chrome reflector
        facets = lm & (np.sin(ax * 260 + np.sin(y * 90) * 2.0) * np.sin(y * 230) > 0.45)
        col[facets] *= 1.10
        col[lm] *= np.clip(0.84 + 0.20 * (y[lm] - 0.83) / 0.2, 0.84, 1.04)[:, None]
        edge = lm & ~(np.roll(lm, 3, 0) & np.roll(lm, -3, 0) & np.roll(lm, 3, 1) & np.roll(lm, -3, 1))
        put(edge, (112, 117, 122), 0.6)                                            # housing edge
    d = np.hypot(ax - 0.528, y - 0.912)
    put(inner_l & (d < 0.050), (196, 201, 206), 0.85)                              # inner lamp reflector
    put(inner_l & (d < 0.050) & (d > 0.044), (140, 146, 152), 0.85)
    put(inner_l & (d < 0.016), (150, 156, 162), 0.85)
    d = np.hypot(ax - 0.718, y - 0.926)
    put(outer_l & (d < 0.064), (198, 203, 208), 0.85)                              # projector bowl
    put(outer_l & (d < 0.064) & (d > 0.057), (140, 146, 152), 0.85)
    put(outer_l & (d < 0.034), (70, 76, 84), 0.95)                                 # projector lens
    put(outer_l & (d < 0.034) & (ax - 0.718 < -0.008) & (y - 0.926 > 0.008), (150, 158, 166), 0.95)   # glint
    put(outer_l & (np.abs(ax - 0.826) < 0.005) & (y > 0.84) & (y < 1.03), (200, 205, 210), 0.95)   # divider
    amber = outer_l & (ax > 0.832) & (y > 0.855) & (y < 1.015)
    put(amber, (214, 124, 34), 0.8)

    # bumper
    bump = face & (y < FBUMP_TOP + 0.005)
    put(face & (np.abs(y - FBUMP_TOP) < 0.004), (40, 42, 44), 0.3)
    put(bump & (y > 0.69) & (y < 0.785), tuple(int(c * 1.07) for c in CLAD), 0.55)     # upper bulge catches the light
    put(bump & (np.abs(y - 0.684) < 0.004), (48, 50, 52), 0.3)
    put(bump & (ax < 0.205) & (y > 0.475) & (y < 0.655), (44, 46, 48), 0.3)            # plate recess
    plate = bump & (ax < 0.163) & (y > 0.49) & (y < 0.645)
    put(plate, (196, 200, 204), 0.4)
    put(plate & ((ax > 0.153) | (y < 0.50) | (y > 0.635)), (60, 60, 64), 0.4)
    def slot(y0, y1):
        r = (y1 - y0) / 2; cy = (y0 + y1) / 2
        core = (ax > 0.27 + r) & (ax < 0.59) & (y > y0) & (y < y1)
        cap = np.hypot(ax - (0.27 + r), y - cy) < r
        return bump & (core | cap)
    s1, s2 = slot(0.602, 0.646), slot(0.552, 0.596)
    put(bump & (ax > 0.262) & (ax < 0.598) & (y > 0.544) & (y < 0.654), (30, 31, 33), 0.25)   # intake surround
    for sl in (s1, s2):
        put(sl, (8, 9, 10), 0.15)
    fog = bump & (ax > 0.612) & (ax < 0.892) & (y > 0.552) & (y < 0.652)
    put(fog, (62, 64, 66), 0.4)
    fogl = bump & (ax > 0.622) & (ax < 0.882) & (y > 0.560) & (y < 0.644)
    put(fogl, (176, 172, 158), 0.85)                                                 # clear lens, slightly warm
    put(fogl & (np.hypot(ax - 0.705, y - 0.602) < 0.028), (214, 216, 218), 0.9)        # bulb
    put(fogl & (ax > 0.80), (196, 150, 90), 0.85)                                     # amber-tinted outer end
    put(bump & (y < 0.445), TRIM, 0.25)

    # ---- rear face: liftgate glass over a lower tailgate, LEXUS garnish, corner lamps, gray bumper
    back = z < Z_TAIL + 0.12
    upper_back = z < -1.85
    gwid = W - 0.12
    put(upper_back & (y > float(py2y(355))) & (y < float(py2y(232))) & (ax < gwid + 0.025), BLACK, 0.2)
    rg = upper_back & (y > float(py2y(350))) & (y < float(py2y(238))) & (ax < gwid)
    put(rg, GLASS, 0.95)
    col[rg] += (np.clip(1 - np.abs(y[rg] - 1.58) / 0.1, 0, 1) * 16)[:, None]
    tl = back & (ax > 0.76) & (y > float(py2y(469))) & (y < float(py2y(392)))
    put(tl, RED, 0.9)
    put(tl & (y > float(py2y(414))), LENS, 0.9)
    put(back & (ax > 0.74) & (ax < 0.76) & (y > float(py2y(469))) & (y < float(py2y(392))), SEAM, 0.2)
    # tailgate split line and edges
    put(back & (np.abs(y - float(py2y(358))) < 0.003) & (ax < 0.72), SEAM, 0.2)
    for pl in ([(0.72, float(py2y(470))), (0.72, float(py2y(358)))], [(-0.72, float(py2y(470))), (-0.72, float(py2y(358)))]):
        put(back & near_polyline(pl, x, y, 0.003), SEAM, 0.2)
    put(back & (y > 1.03) & (y < 1.075) & (ax < 0.52), CHROME, 1.0)                      # garnish
    put(back & (ax < 0.20) & (y > 0.83) & (y < 1.005), (32, 52, 44), 0.3)                 # plate recess
    plate = back & (ax < 0.152) & (y > 0.845) & (y < 0.99)
    put(plate, (232, 232, 226), 0.4)
    put(plate & ((ax > 0.142) | (y < 0.855) | (y > 0.98)), (60, 60, 64), 0.4)
    put(back & (z < Z_TAIL - 0.02) & (y > CLAD_Y_REAR - 0.05) & (y < CLAD_Y_REAR - 0.01) & (ax < 0.70), TRIM, 0.25)   # step pad
    put(back & (z < Z_TAIL - 0.02) & (ax > 0.80) & (ax < 0.92) & (y > 0.55) & (y < 0.58), RED, 0.9)
    put(back & (z < Z_TAIL - 0.02) & (y < 0.45), TRIM, 0.25)

    col *= np.clip(0.84 + 0.16 * (y[..., None] - 0.32) / 0.25, 0.84, 1.0)   # rocker in shadow
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
    spc = np.full((ATLAS * ss, ATLAS * ss), 0.6, np.float32)
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
    def label(name, text, a0, b0, a1, b1, fill):
        x0, y0 = to_px(name, a0, b0); x1, y1 = to_px(name, a1, b1)
        lab = Image.new("RGBA", (520, 48), (0, 0, 0, 0))
        ImageDraw.Draw(lab).text((260, 24), text, font=ImageFont.truetype(FONT_B, 38), fill=fill + (255,), anchor="mm")
        lab = lab.resize((max(1, int(abs(x1 - x0))), max(1, int(abs(y1 - y0)))), Image.LANCZOS)
        tex.paste(lab, (int(min(x0, x1)), int(min(y0, y1))), lab)
    label("rear", "L E X U S", 0.42, 1.072, -0.42, 1.033, (60, 64, 70))
    def lexus_l(cx, cy, sc):  # the Lexus "L" in an oval
        d.ellipse([cx - sc, cy - 0.72 * sc, cx + sc, cy + 0.72 * sc], outline=CHROME, width=max(1, int(0.14 * sc)))
        d.line([(cx - 0.32 * sc, cy - 0.5 * sc), (cx - 0.32 * sc, cy + 0.42 * sc), (cx + 0.5 * sc, cy + 0.42 * sc)], fill=CHROME, width=max(1, int(0.14 * sc)))
    ex, ey = to_px("front", 0.0, 0.944); lexus_l(ex, ey, 34)
    ex, ey = to_px("rear", 0.0, 1.16); lexus_l(ex, ey, 16)
    sx, sy = to_px("rear", -0.55, 1.12)
    d.text((sx, sy), "LX470", font=ImageFont.truetype(FONT_B, 13), fill=CHROME, anchor="mm")
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
    near_axle = (np.abs(cen[:, 2] - FA) < 0.53) | (np.abs(cen[:, 2] - RA) < 0.53)
    mat[(so > 0.012) & (cen[:, 1] < 1.05) & near_axle] = 1
    mat[(so > -0.008) & (fn[:, 1] < -0.15) & (cen[:, 1] < 1.0) & (cen[:, 1] > 0.45) & near_axle] = 1
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
    z0, z1 = float(px2z(655)), float(px2z(1082)); RX = 0.66; top = float(py2y(197))
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

RIM_R = 0.2032; SW_A = TIRE_W / 2 - 0.016   # 16" rim; sidewall face offset from centre
def tire():
    R = TIRE_R; hw_ = TIRE_W / 2
    prof = [(RIM_R + 0.004, -SW_A + 0.01), (RIM_R + 0.012, -SW_A - 0.004), (R - 0.10, -SW_A - 0.012), (R - 0.04, -SW_A - 0.008),
            (R - 0.019, -hw_ + 0.012), (R - 0.0095, -hw_ + 0.03), (R - 0.0095, hw_ - 0.03), (R - 0.019, hw_ - 0.012), (R - 0.04, SW_A + 0.008), (R - 0.10, SW_A + 0.012),
            (RIM_R + 0.012, SW_A + 0.004), (RIM_R + 0.004, SW_A - 0.01)]
    base = lathe(prof, 96)
    blocks = []
    N = 32; dth = 2 * np.pi / N
    for i in range(N):
        t = i * dth
        # KO2: stepped shoulder blocks with deep sipes, staggered centre blocks, serrated shoulder lugs
        for side in (1, -1):
            long_ = i % 2 == 0
            a0, a1 = (0.050, hw_ - 0.01) if long_ else (0.066, hw_ - 0.01)
            blocks.append(tread_block(t + 0.05 * dth, t + 0.80 * dth, side * a0, side * a1, R - 0.0125, R, 0.07 * side))
            blocks.append(tread_block(t + 0.12 * dth, t + 0.66 * dth, side * (hw_ - 0.018), side * (hw_ - 0.004), R - (0.052 if long_ else 0.036), R - 0.008))
        off = 0.5 * dth if i % 2 else 0
        blocks.append(tread_block(t + off + 0.08 * dth, t + off + 0.66 * dth, -0.044, 0.002, R - 0.0125, R, 0.08))
        blocks.append(tread_block(t + 0.5 * dth - off + 0.08 * dth, t + 0.5 * dth - off + 0.66 * dth, -0.002, 0.044, R - 0.0125, R, -0.08))
    return base, trimesh.util.concatenate(blocks)

def rim():
    """Bronze six-spoke off-road wheel: flat-faced, wide spokes, big windows, machined lip."""
    outer = Point(0, 0).buffer(RIM_R - 0.014, 64)
    windows = []
    for k in range(6):
        a = k * np.pi / 3 + np.pi / 6
        w = Polygon([(0.088, -0.014), (0.164, -0.040), (0.170, 0), (0.164, 0.040), (0.088, 0.014)]).buffer(0.012, 10)
        windows.append(affinity.rotate(w, a, origin=(0, 0), use_radians=True))
    face = outer
    for w in windows: face = face.difference(w)
    face = face.difference(Point(0, 0).buffer(0.034, 24))
    m = trimesh.creation.extrude_polygon(face, 0.026)
    Rm = np.array([[0, 0, 1], [1, 0, 0], [0, 1, 0]])
    m.vertices = m.vertices @ Rm.T
    m.apply_translation((0.034, 0, 0))
    barrel = lathe([(RIM_R - 0.014, 0.060), (RIM_R + 0.006, 0.070), (RIM_R + 0.006, 0.082), (RIM_R - 0.004, 0.084), (RIM_R - 0.016, 0.05), (RIM_R - 0.016, -0.11)], 64)
    hub = lathe([(0.0, 0.066), (0.03, 0.066), (0.036, 0.058), (0.036, 0.04)], 24)
    lugs = []
    for k in range(6):
        a = k * np.pi / 3
        c = trimesh.creation.cylinder(radius=0.009, height=0.022, sections=6)
        c.apply_transform(trimesh.transformations.rotation_matrix(np.pi / 2, (0, 1, 0)))
        c.apply_translation((0.066, 0.056 * np.cos(a), 0.056 * np.sin(a))); lugs.append(c)
    return trimesh.util.concatenate([m, barrel, hub] + lugs)

def wheel_inner():
    """Dark brake/hub disc behind the spokes so the windows don't see through."""
    return lathe([(0.0, -0.01), (RIM_R - 0.015, -0.01)], 48)

def wheel_texture():
    """Sidewall texture: black rubber with raised (unpainted) BFGoodrich KO2 lettering, planar over the outer face."""
    S = 1024; img = Image.new("RGB", (S, S), (26, 26, 27)); d = ImageDraw.Draw(img)
    c = S / 2; sc = S / 2 / 0.41
    for r in np.arange(0.24, 0.40, 0.004):   # subtle sidewall shading rings
        g = int(24 + 10 * math.sin((r - 0.24) / 0.16 * math.pi))
        d.ellipse([c - r * sc, c - r * sc, c + r * sc, c + r * sc], outline=(g, g, g + 1), width=3)
    def arc_text(text, radius, size, ang0, color=(54, 54, 56), spacing=1.0):
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
        arc_text("BFGoodrich", 0.318, 52, base, spacing=1.04)
        arc_text("All-Terrain T/A KO2", 0.282, 25, base + math.pi / 2, spacing=1.05)
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
    return struct.pack("<4sI", b"VHCL", len(hj)) + hj + b"".join(blobs)

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
    info = {"axles": [FA, RA], "wheelX": WX, "tireR": TIRE_R, "rim": "#5c4229"}
    json.dump(info, open(os.path.join(OUT, "meta.json"), "w"))
    print("done", {k: os.path.getsize(os.path.join(OUT, k)) for k in os.listdir(OUT)}, info)

if __name__ == "__main__":
    main()
