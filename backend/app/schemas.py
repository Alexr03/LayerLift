"""Request and response models for the HTTP API."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator

HEX = r"^#?[0-9A-Fa-f]{6}$"


class BackgroundOptions(BaseModel):
    mode: Literal["auto", "alpha", "colour", "none"] = "auto"
    colour: str | None = Field(default=None, pattern=HEX)
    tolerance: float = Field(default=12.0, ge=1, le=60)


class AnalysisOptions(BaseModel):
    background: BackgroundOptions = BackgroundOptions()
    max_colours: int = Field(default=12, ge=2, le=16)
    n_colours: int | None = Field(default=None, ge=1, le=16)
    merge_delta_e: float = Field(default=8.0, ge=1, le=40)


class FilamentIn(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    hex: str = Field(pattern=HEX)
    height_mm: float | None = Field(default=None, gt=0, le=50)
    start_from_bed: bool = False
    density: float = Field(default=1.24, gt=0.5, le=3)

    @field_validator("hex")
    @classmethod
    def normalise_hex(cls, v: str) -> str:
        return "#" + v.lstrip("#").upper()


class RegionOverrideIn(BaseModel):
    filament: int | None = Field(default=None, ge=0)
    height_mm: float | None = Field(default=None, gt=0, le=50)
    removed: bool = False


class BuildRequest(BaseModel):
    title: str = Field(default="LayerLift relief", max_length=80)
    analysis: AnalysisOptions = AnalysisOptions()
    filaments: list[FilamentIn] = Field(min_length=1, max_length=16)
    mapping: list[int] | None = None
    cluster_heights: dict[int, float] = Field(default_factory=dict)
    region_overrides: dict[int, RegionOverrideIn] = Field(default_factory=dict)
    width_mm: float = Field(default=100.0, ge=5, le=500)
    size_mode: Literal["width", "height", "longest"] = "width"
    nozzle_mm: float = Field(default=0.4, ge=0.1, le=1.2)
    layer_mm: float = Field(default=0.2, ge=0.04, le=0.6)
    base_mm: float = Field(default=2.0, ge=0, le=20)
    min_feature_mm: float | None = Field(default=None, ge=0, le=5)
    height_mode: Literal["manual", "by_luminance"] = "manual"
    lighter_taller: bool = True
    relief_min_mm: float = Field(default=0.8, ge=0, le=20)
    relief_step_mm: float = Field(default=0.4, ge=0, le=10)
    base_filament: int | None = Field(default=None, ge=0)
    mirror: bool = False
    strategy: Literal["detailed", "compact", "stacked"] = "detailed"

    @field_validator("cluster_heights")
    @classmethod
    def check_heights(cls, v: dict[int, float]) -> dict[int, float]:
        for h in v.values():
            if not 0 < h <= 50:
                raise ValueError("cluster heights must be between 0 and 50 mm")
        return v


class MapClusterIn(BaseModel):
    hex: str = Field(pattern=HEX)
    share: float = Field(ge=0)


class MapRequest(BaseModel):
    clusters: list[MapClusterIn] = Field(min_length=1, max_length=16)
    adjacency: list[list[float]]
    filaments: list[FilamentIn] = Field(min_length=1, max_length=16)
    fixed: dict[int, int] = Field(default_factory=dict)


class MapResponse(BaseModel):
    mapping: list[int]
    method: str


class ClusterOut(BaseModel):
    id: int
    hex: str
    rgb: tuple[int, int, int]
    share: float
    pixels: int


class RegionOut(BaseModel):
    id: int
    cluster: int
    area: int
    bbox: tuple[int, int, int, int]
    centroid: tuple[float, float]
    outline_share: float
    neighbours: list[tuple[int, int]] = []  # (region id, shared boundary px), longest first


class AnalyseResponse(BaseModel):
    analysis_id: str
    width: int
    height: int
    source_format: str
    original_size: tuple[int, int]
    background: dict
    clusters: list[ClusterOut]
    regions: list[RegionOut]
    adjacency: list[list[float]]
    outline_region: int | None
    region_map_png: str  # base64 PNG: RGB = region id + 1 (24-bit), 0 = background
    suggested_mapping: list[int] | None = None


class WarningOut(BaseModel):
    code: str
    message: str
    detail: dict = {}


class PartOut(BaseModel):
    slot: int  # 1-based filament / AMS slot
    filament: int
    name: str
    hex: str
    volume_mm3: float
    grams: float
    z_max: float


class LayerOut(BaseModel):
    index: int
    z_top: float
    filaments: list[int]
    changes: int


class BuildResponse(BaseModel):
    job_id: str
    preview_url: str
    glb_url: str
    downloads: dict[str, str]
    size_mm: tuple[float, float, float]
    base_filament: int
    base_mm: float
    mapping: list[int]
    filament_heights: dict[int, float]
    parts: list[PartOut]
    total_grams: float
    filament_changes: int
    layers: list[LayerOut]
    warnings: list[WarningOut]
    elapsed_s: float
