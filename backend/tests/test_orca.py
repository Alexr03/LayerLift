"""Optional: round-trip the exported 3MF through the OrcaSlicer CLI.

Skipped unless OrcaSlicer is installed. Set ORCA_SLICER to the executable path if it is not
in the default location.
"""

from __future__ import annotations

import os
import re
import subprocess
import zipfile
from pathlib import Path

import pytest

from relief.export import export_3mf

CANDIDATES = [
    os.environ.get("ORCA_SLICER", ""),
    r"C:\Program Files\OrcaSlicer\orca-slicer.exe",
    "/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer",
    "/usr/bin/orca-slicer",
]
ORCA = next((p for p in CANDIDATES if p and Path(p).is_file()), None)


@pytest.mark.skipif(ORCA is None, reason="OrcaSlicer not installed")
def test_orca_round_trip_keeps_parts_and_slots(result_4, tmp_path):
    src = tmp_path / "turtles.3mf"
    src.write_bytes(export_3mf(result_4, "Space Turtles"))
    proc = subprocess.run(
        [ORCA, "--outputdir", str(tmp_path), "--export-3mf", "roundtrip.3mf", str(src)],
        capture_output=True,
        timeout=300,
        cwd=tmp_path,  # Orca writes a log file into the working directory
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    settings = zipfile.ZipFile(tmp_path / "roundtrip.3mf").read("Metadata/model_settings.config").decode()
    assert settings.count("<object ") == 1
    names = re.findall(r'<part id="\d+"[^>]*>\s*<metadata key="name" value="([^"]+)"', settings)
    assert names == ["01 Black", "02 Blue", "03 Apricot", "04 White"]
    # Orca omits a part's extruder when it equals the object's (slot 1).
    slots = [m or "1" for m in re.findall(r'<part id="\d+"[^>]*>(?:(?!</part>).)*?(?:key="extruder" value="(\d+)"|</part>)', settings, flags=re.S)]
    assert slots[1:] == ["2", "3", "4"]
