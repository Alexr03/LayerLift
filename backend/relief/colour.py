"""Colour-space helpers: sRGB <-> CIELAB (D65) and the CIEDE2000 colour difference."""

from __future__ import annotations

import numpy as np

_M_RGB_TO_XYZ = np.array(
    [
        [0.4124564, 0.3575761, 0.1804375],
        [0.2126729, 0.7151522, 0.0721750],
        [0.0193339, 0.1191920, 0.9503041],
    ]
)
_WHITE_D65 = np.array([0.95047, 1.0, 1.08883])


def hex_to_rgb(value: str) -> tuple[int, int, int]:
    """Parse '#RRGGBB' or 'RRGGBB' (also '#RGB') into an RGB tuple."""
    s = value.strip().lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    if len(s) != 6:
        raise ValueError(f"invalid hex colour: {value!r}")
    return int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)


def rgb_to_hex(rgb) -> str:
    r, g, b = (int(round(float(c))) for c in rgb[:3])
    return f"#{max(0, min(255, r)):02X}{max(0, min(255, g)):02X}{max(0, min(255, b)):02X}"


def srgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    """Convert sRGB values in 0..255 (any shape ending in 3) to CIELAB (D65)."""
    c = np.asarray(rgb, dtype=np.float64) / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    xyz = lin @ _M_RGB_TO_XYZ.T / _WHITE_D65
    eps = 216 / 24389
    kappa = 24389 / 27
    f = np.where(xyz > eps, np.cbrt(xyz), (kappa * xyz + 16) / 116)
    lab = np.empty_like(f)
    lab[..., 0] = 116 * f[..., 1] - 16
    lab[..., 1] = 500 * (f[..., 0] - f[..., 1])
    lab[..., 2] = 200 * (f[..., 1] - f[..., 2])
    return lab


def lab_to_srgb(lab: np.ndarray) -> np.ndarray:
    """Convert CIELAB (D65) back to sRGB 0..255 floats (clipped)."""
    lab = np.asarray(lab, dtype=np.float64)
    fy = (lab[..., 0] + 16) / 116
    fx = fy + lab[..., 1] / 500
    fz = fy - lab[..., 2] / 200
    eps = 216 / 24389
    kappa = 24389 / 27

    def finv(t):
        t3 = t**3
        return np.where(t3 > eps, t3, (116 * t - 16) / kappa)

    xyz = np.stack([finv(fx), np.where(lab[..., 0] > kappa * eps, fy**3, lab[..., 0] / kappa), finv(fz)], -1)
    xyz = xyz * _WHITE_D65
    lin = xyz @ np.linalg.inv(_M_RGB_TO_XYZ).T
    lin = np.clip(lin, 0, 1)
    c = np.where(lin <= 0.0031308, 12.92 * lin, 1.055 * lin ** (1 / 2.4) - 0.055)
    return np.clip(c * 255, 0, 255)


def hex_to_lab(value: str) -> np.ndarray:
    return srgb_to_lab(np.array(hex_to_rgb(value), dtype=np.float64))


def relative_luminance(rgb) -> float:
    """WCAG relative luminance of an sRGB colour (0..255), in 0..1."""
    c = np.asarray(rgb[:3], dtype=np.float64) / 255.0
    lin = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    return float(lin @ np.array([0.2126, 0.7152, 0.0722]))


def delta_e_2000(lab1: np.ndarray, lab2: np.ndarray) -> np.ndarray:
    """CIEDE2000 colour difference. Broadcasts over leading dimensions."""
    lab1 = np.asarray(lab1, dtype=np.float64)
    lab2 = np.asarray(lab2, dtype=np.float64)
    L1, a1, b1 = lab1[..., 0], lab1[..., 1], lab1[..., 2]
    L2, a2, b2 = lab2[..., 0], lab2[..., 1], lab2[..., 2]

    C1 = np.hypot(a1, b1)
    C2 = np.hypot(a2, b2)
    Cbar = (C1 + C2) / 2
    Cbar7 = Cbar**7
    G = 0.5 * (1 - np.sqrt(Cbar7 / (Cbar7 + 25.0**7)))
    a1p = (1 + G) * a1
    a2p = (1 + G) * a2
    C1p = np.hypot(a1p, b1)
    C2p = np.hypot(a2p, b2)
    h1p = np.degrees(np.arctan2(b1, a1p)) % 360
    h2p = np.degrees(np.arctan2(b2, a2p)) % 360

    dLp = L2 - L1
    dCp = C2p - C1p
    dh = h2p - h1p
    dh = np.where(dh > 180, dh - 360, dh)
    dh = np.where(dh < -180, dh + 360, dh)
    dh = np.where(C1p * C2p == 0, 0.0, dh)
    dHp = 2 * np.sqrt(C1p * C2p) * np.sin(np.radians(dh) / 2)

    Lbarp = (L1 + L2) / 2
    Cbarp = (C1p + C2p) / 2
    hsum = h1p + h2p
    hbarp = np.where(np.abs(h1p - h2p) > 180, np.where(hsum < 360, hsum + 360, hsum - 360), hsum) / 2
    hbarp = np.where(C1p * C2p == 0, hsum, hbarp)

    T = (
        1
        - 0.17 * np.cos(np.radians(hbarp - 30))
        + 0.24 * np.cos(np.radians(2 * hbarp))
        + 0.32 * np.cos(np.radians(3 * hbarp + 6))
        - 0.20 * np.cos(np.radians(4 * hbarp - 63))
    )
    dtheta = 30 * np.exp(-(((hbarp - 275) / 25) ** 2))
    Cbarp7 = Cbarp**7
    Rc = 2 * np.sqrt(Cbarp7 / (Cbarp7 + 25.0**7))
    Sl = 1 + 0.015 * (Lbarp - 50) ** 2 / np.sqrt(20 + (Lbarp - 50) ** 2)
    Sc = 1 + 0.045 * Cbarp
    Sh = 1 + 0.015 * Cbarp * T
    Rt = -np.sin(np.radians(2 * dtheta)) * Rc

    return np.sqrt(
        (dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2 + Rt * (dCp / Sc) * (dHp / Sh)
    )


def pairwise_delta_e(lab_a: np.ndarray, lab_b: np.ndarray) -> np.ndarray:
    """Matrix of CIEDE2000 differences between two lists of Lab colours."""
    lab_a = np.asarray(lab_a, dtype=np.float64).reshape(-1, 3)
    lab_b = np.asarray(lab_b, dtype=np.float64).reshape(-1, 3)
    return delta_e_2000(lab_a[:, None, :], lab_b[None, :, :])
