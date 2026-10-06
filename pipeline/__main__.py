"""Build the app's static data: `python -m pipeline [step ...]` (default: all steps)."""

from __future__ import annotations

import argparse
import logging
import time

from . import landcover, manifest, network, terrain

STEPS = {
    "terrain": terrain.build_terrain,
    "ground": landcover.build_ground,
    "network": network.build_network,
}

log = logging.getLogger("pipeline")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m pipeline", description=__doc__)
    parser.add_argument("steps", nargs="*", help=f"steps to run: {', '.join(STEPS)} or all")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    steps = list(STEPS) if not args.steps or "all" in args.steps else args.steps
    unknown = [s for s in steps if s not in STEPS]
    if unknown:
        parser.error(f"unknown step(s): {', '.join(unknown)}")

    for name in steps:
        started = time.monotonic()
        manifest.update(name, STEPS[name]())
        log.info("step %s done in %.1fs", name, time.monotonic() - started)


if __name__ == "__main__":
    main()
