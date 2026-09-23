"""LayerLift relief library: image -> multi-colour 3D-printable relief."""

import os

# Release builds set LAYERLIFT_VERSION (see the Dockerfile and .github/workflows/release.yml).
__version__ = os.environ.get("LAYERLIFT_VERSION", "0.0.0-dev")
