"""Export the exact Buildx result; never substitute an unrelated previous build."""

import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


def main():
    metadata = json.loads(os.environ.get("BUILD_METADATA") or "{}")
    ref = metadata.get("buildx.build.ref", "")
    if not ref:
        print("::warning::Build produced no exportable reference; diagnostics remain in the job log.")
        return
    parts = ref.split("/")
    if len(parts) != 3 or not all(re.fullmatch(r"[A-Za-z0-9_.-]+", part) for part in parts):
        raise ValueError("invalid Buildx builder/node/reference")
    name = os.environ.get("RECORD_NAME", "build-record")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", name):
        raise ValueError("invalid artifact name prefix")
    directory = Path(tempfile.mkdtemp(prefix="build-record-", dir=os.environ["RUNNER_TEMP"]))
    path = directory / "build.dockerbuild"
    subprocess.run(["docker", "buildx", "--builder", parts[0], "history", "export",
                    "--finalize", "--output", str(path), parts[2]], check=True, timeout=120)
    if not path.stat().st_size:
        raise ValueError("Buildx exported an empty record")
    with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
        output.write(f"path={path}\n")
        output.write(f"name={name}-{parts[2]}\n")


if __name__ == "__main__":
    main()
