#!/usr/bin/env python3
"""Build a deterministic, allowlisted CUAR release-candidate ZIP."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import tempfile
from urllib.parse import urlparse
import zipfile


ROOT = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = "codex-usage-and-resets"
FIXED_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
STRICT_SEMVER = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$"
)
RUNTIME_VERSION = re.compile(
    r'^export const CUAR_VERSION = "([^"]+)";$',
    re.MULTILINE,
)

RUNTIME_FILES = (
    ".codex-plugin/plugin.json",
    ".codexignore",
    "LICENSE",
    "PRIVACY.md",
    "README.md",
    "SECURITY.md",
    "SUPPORT.md",
    "assets/icon.png",
    "schema/report.schema.json",
    "scripts/cuar.mjs",
    "scripts/lib/app-server.mjs",
    "scripts/lib/calculate.mjs",
    "scripts/lib/cli.mjs",
    "scripts/lib/errors.mjs",
    "scripts/lib/normalize.mjs",
    "scripts/lib/reset-ledger.mjs",
    "scripts/lib/schema.mjs",
    "scripts/lib/time.mjs",
    "skills/cuar/SKILL.md",
    "skills/cuar/agents/openai.yaml",
)

EXECUTABLE_FILES = frozenset({"scripts/cuar.mjs"})
MAX_COMPRESSED_BYTES = 100 * 1024 * 1024
MAX_EXPANDED_BYTES = 512 * 1024 * 1024
MAX_ENTRY_BYTES = 100 * 1024 * 1024
MAX_ENTRIES = 5000
MAX_PATH_SEGMENTS = 20
MAX_ASSET_BYTES = 5 * 1024 * 1024
MIN_RASTER_DIMENSION = 48
MAX_RASTER_DIMENSION = 4096
PACKAGE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build the deterministic CUAR release-candidate ZIP."
    )
    parser.add_argument(
        "--output",
        type=Path,
        help=(
            "Output ZIP path. Defaults to "
            "dist/<name>-release-candidate-<version>.zip."
        ),
    )
    return parser.parse_args()


def read_json(relative_path: str) -> dict:
    path = ROOT / relative_path
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"{relative_path} must contain a JSON object")
    return value


def validate_metadata() -> str:
    plugin = read_json(".codex-plugin/plugin.json")
    package = read_json("package.json")
    runtime_source = (ROOT / "scripts/lib/schema.mjs").read_text(encoding="utf-8")
    runtime_match = RUNTIME_VERSION.search(runtime_source)

    if plugin.get("name") != PACKAGE_ROOT or package.get("name") != PACKAGE_ROOT:
        raise ValueError(f"plugin and package names must be {PACKAGE_ROOT!r}")
    if PACKAGE_NAME.fullmatch(PACKAGE_ROOT) is None:
        raise ValueError("plugin name violates the final-directory name contract")

    versions = {
        plugin.get("version"),
        package.get("version"),
        runtime_match.group(1) if runtime_match else None,
    }
    if len(versions) != 1:
        raise ValueError("plugin, package, and runtime versions must match")
    version = versions.pop()
    if not isinstance(version, str) or not STRICT_SEMVER.fullmatch(version):
        raise ValueError(f"release version is not strict SemVer: {version!r}")
    if len(version) > 64:
        raise ValueError("release version exceeds the final-directory limit")

    if plugin.get("license") != "Apache-2.0":
        raise ValueError("plugin license must be Apache-2.0")
    if plugin.get("homepage") != "https://filamentlabs.io/CUAR":
        raise ValueError("plugin homepage must be the canonical CUAR website")
    if plugin.get("repository") != (
        "https://github.com/joelfarthing/codex-usage-and-resets"
    ):
        raise ValueError("plugin repository must be the public CUAR source")
    if plugin.get("keywords") != [
        "codex",
        "usage",
        "rate-limits",
        "capacity-planning",
        "reset-credits",
    ]:
        raise ValueError("plugin keywords must match the reviewed discovery set")
    if plugin.get("skills") != "./skills/":
        raise ValueError("plugin skills path must be './skills/'")
    for forbidden_component in ("apps", "hooks", "mcpServers"):
        if forbidden_component in plugin:
            raise ValueError(
                f"skills-only release must omit {forbidden_component!r}"
            )

    interface = plugin.get("interface")
    if not isinstance(interface, dict):
        raise ValueError("plugin manifest must contain interface metadata")
    if interface.get("category") != "Productivity":
        raise ValueError("plugin category must be 'Productivity'")
    if interface.get("capabilities") != ["Read", "Local storage"]:
        raise ValueError(
            "plugin capabilities must be exactly ['Read', 'Local storage']"
        )
    validate_bounded_line(interface, "displayName", 30)
    validate_bounded_line(interface, "shortDescription", 30)
    validate_bounded_line(interface, "longDescription", 4000)
    validate_bounded_line(interface, "developerName", 80)
    capabilities = interface["capabilities"]
    if not 1 <= len(capabilities) <= 20:
        raise ValueError("capabilities must contain one to twenty entries")
    for capability in capabilities:
        if (
            not isinstance(capability, str)
            or not capability.strip()
            or "\n" in capability
            or len(capability) > 120
        ):
            raise ValueError("capabilities must be bounded non-empty lines")
    if interface.get("composerIcon") != "./assets/icon.png":
        raise ValueError("plugin composerIcon must be './assets/icon.png'")
    if interface.get("logo") != "./assets/icon.png":
        raise ValueError("plugin logo must be './assets/icon.png'")
    expected_urls = {
        "websiteURL": "https://filamentlabs.io/CUAR",
        "privacyPolicyURL": "https://filamentlabs.io/CUAR/privacy",
        "termsOfServiceURL": "https://filamentlabs.io/CUAR/terms",
    }
    if any(interface.get(field) != value for field, value in expected_urls.items()):
        raise ValueError("plugin interface URLs must match the canonical CUAR pages")
    validate_icon(ROOT / "assets/icon.png")

    for field in (
        "websiteURL",
        "supportURL",
        "privacyPolicyURL",
        "termsOfServiceURL",
    ):
        value = interface.get(field)
        if value is None:
            continue
        parsed = urlparse(value) if isinstance(value, str) else None
        if (
            parsed is None
            or parsed.scheme != "https"
            or not parsed.netloc
            or len(value) > 1024
        ):
            raise ValueError(f"{field} must be a bounded absolute HTTPS URL")

    prompts = interface.get("defaultPrompt")
    if not isinstance(prompts, list) or not 1 <= len(prompts) <= 3:
        raise ValueError("defaultPrompt must contain one to three prompts")
    if any(
        not isinstance(prompt, str)
        or not prompt.strip()
        or "\n" in prompt
        or len(prompt) > 128
        or "@" in prompt
        for prompt in prompts
    ):
        raise ValueError("default prompts must be bounded non-empty lines")
    if len(set(prompts)) != len(prompts):
        raise ValueError("default prompts must be unique")

    skill = (ROOT / "skills/cuar/SKILL.md").read_text(encoding="utf-8")
    if "[TODO:" in skill:
        raise ValueError("skill contains an unfinished placeholder")

    return version


def validate_bounded_line(
    payload: dict, field: str, maximum_length: int
) -> None:
    value = payload.get(field)
    if (
        not isinstance(value, str)
        or not value.strip()
        or "\n" in value
        or len(value) > maximum_length
    ):
        raise ValueError(
            f"{field} must be a non-empty line no longer than {maximum_length}"
        )


def validate_icon(path: Path) -> None:
    payload = path.read_bytes()
    if len(payload) > MAX_ASSET_BYTES:
        raise ValueError("plugin icon exceeds the final-directory size limit")
    if len(payload) < 24 or payload[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("plugin icon must be a PNG")
    if payload[12:16] != b"IHDR":
        raise ValueError("plugin icon has an invalid PNG header")
    width, height = struct.unpack(">II", payload[16:24])
    if width != height:
        raise ValueError("plugin icon must be square")
    if not MIN_RASTER_DIMENSION <= width <= MAX_RASTER_DIMENSION:
        raise ValueError("plugin icon dimensions violate final-directory limits")


def source_file(relative_path: str) -> Path:
    relative = Path(relative_path)
    if relative.is_absolute() or ".." in relative.parts:
        raise ValueError(f"unsafe allowlist path: {relative_path}")

    current = ROOT
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError(f"symlinks are not allowed: {relative_path}")

    metadata = os.lstat(current)
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"only regular files are allowed: {relative_path}")
    return current


def zip_info(archive_name: str, relative_path: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(archive_name, FIXED_TIMESTAMP)
    info.create_system = 3
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = (
        stat.S_IFREG | (0o755 if relative_path in EXECUTABLE_FILES else 0o644)
    ) << 16
    info.extra = b""
    info.comment = b""
    return info


def expected_entries() -> list[str]:
    return [f"{PACKAGE_ROOT}/{relative}" for relative in sorted(RUNTIME_FILES)]


def verify_archive(path: Path, source_bytes: dict[str, bytes]) -> None:
    expected = expected_entries()
    if path.stat().st_size > MAX_COMPRESSED_BYTES:
        raise ValueError("archive exceeds the final-directory compressed-size limit")
    with zipfile.ZipFile(path, "r") as archive:
        infos = archive.infolist()
        if len(infos) > MAX_ENTRIES:
            raise ValueError("archive exceeds the final-directory entry limit")
        if sum(info.file_size for info in infos) > MAX_EXPANDED_BYTES:
            raise ValueError("archive exceeds the final-directory expanded-size limit")
        if archive.namelist() != expected:
            raise ValueError("archive entries do not match the reviewed allowlist")
        if archive.testzip() is not None:
            raise ValueError("archive contains a corrupt member")

        for info in infos:
            if len(Path(info.filename).parts) > MAX_PATH_SEGMENTS:
                raise ValueError(f"archive path is too deep: {info.filename}")
            if info.file_size > MAX_ENTRY_BYTES:
                raise ValueError(f"archive member is too large: {info.filename}")
            if info.flag_bits & 0x1:
                raise ValueError(f"archive member is encrypted: {info.filename}")
            if info.is_dir() or info.date_time != FIXED_TIMESTAMP:
                raise ValueError(
                    f"archive metadata is not normalized: {info.filename}"
                )
            relative = info.filename.removeprefix(f"{PACKAGE_ROOT}/")
            expected_mode = 0o755 if relative in EXECUTABLE_FILES else 0o644
            actual_mode = (info.external_attr >> 16) & 0o777
            if actual_mode != expected_mode:
                raise ValueError(f"archive mode mismatch: {info.filename}")
            if archive.read(info) != source_bytes[relative]:
                raise ValueError(f"archive content mismatch: {info.filename}")


def build_archive(output: Path) -> dict:
    version = validate_metadata()
    source_bytes = {
        relative: source_file(relative).read_bytes()
        for relative in sorted(RUNTIME_FILES)
    }

    output = output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_name = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=f".{output.name}.",
            suffix=".tmp",
            dir=output.parent,
            delete=False,
        ) as temporary:
            temporary_name = Path(temporary.name)

        with zipfile.ZipFile(
            temporary_name,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=9,
            strict_timestamps=True,
        ) as archive:
            for relative, payload in source_bytes.items():
                archive.writestr(
                    zip_info(f"{PACKAGE_ROOT}/{relative}", relative),
                    payload,
                    compress_type=zipfile.ZIP_DEFLATED,
                    compresslevel=9,
                )

        verify_archive(temporary_name, source_bytes)
        os.replace(temporary_name, output)
        temporary_name = None
    finally:
        if temporary_name is not None:
            temporary_name.unlink(missing_ok=True)

    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    return {
        "output": str(output),
        "version": version,
        "sha256": digest,
        "size": output.stat().st_size,
        "entries": expected_entries(),
    }


def main() -> None:
    args = parse_args()
    version = validate_metadata()
    output = args.output or (
        ROOT / "dist" / f"{PACKAGE_ROOT}-release-candidate-{version}.zip"
    )
    print(json.dumps(build_archive(output), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
