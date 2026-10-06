"""Census 2021 population of each settlement (naselje) in the counties the map covers.

    python -I -c "import sys; sys.path.insert(0, '.'); from pipeline import census; census.main()"

(`-I` keeps the download off Python's import path; the line puts the repository back.)

This downloads the Croatian Bureau of Statistics' workbook of population by settlement
(about 3 MB) into pipeline/.cache/census/ and writes pipeline/data/census_2021_settlements.json,
which pipeline/demand.py reads to give the towns and villages around the City their
residents. It is not part of `python -m pipeline all`: the result is committed, so CI does
not need openpyxl (`pip install openpyxl`), which reads the workbook.
"""

from __future__ import annotations

import json
import logging
import shutil
import urllib.request
from pathlib import Path

from .config import CACHE_DIR, PIPELINE_DIR

log = logging.getLogger(__name__)

URL = "https://podaci.dzs.hr/media/rqybclnx/popis_2021-stanovnistvo_po_naseljima.xlsx"
OUT = PIPELINE_DIR / "data" / "census_2021_settlements.json"
# Counties (županije) the map covers, as the workbook names them.
COUNTIES = ("Grad Zagreb", "Zagrebačka", "Krapinsko-zagorska", "Sisačko-moslavačka", "Karlovačka")

ATTRIBUTION = {
    "name": "DZS, Census 2021, population by settlements",
    "text": "Population by settlement from the Croatian Bureau of Statistics (Državni zavod za "
    "statistiku), Census of Population, Households and Dwellings 2021.",
    "url": URL,
}


def download(url: str, dest: Path) -> Path:
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "zg-city-sim pipeline"})
    tmp = dest.with_name(dest.name + ".partial")
    with urllib.request.urlopen(req, timeout=300) as response, tmp.open("wb") as f:
        shutil.copyfileobj(response, f)
    tmp.rename(dest)
    return dest


def read_settlements(path: Path) -> list[dict]:
    """Rows of table 1 (population by age and sex, by settlements) for both sexes together:
    county, town or municipality, settlement and total population."""
    import openpyxl

    sheet = openpyxl.load_workbook(path, read_only=True)["1."]
    out = []
    for row in sheet.iter_rows(values_only=True):
        county, kind, municipality, settlement, sex, total = (
            row[0],
            row[1],
            row[4],
            row[5],
            row[6],
            row[8],
        )
        if sex != "sv." or not settlement or county not in COUNTIES:
            continue
        out.append(
            {
                "county": county,
                # The City's settlements are listed without a town.
                "municipality": municipality or "Zagreb",
                "kind": kind,
                "settlement": settlement,
                "population": int(total) if isinstance(total, (int, float)) else 0,
            }
        )
    return out


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    rows = read_settlements(download(URL, CACHE_DIR / "census" / "settlements_2021.xlsx"))
    OUT.write_text(
        json.dumps({"source": ATTRIBUTION, "settlements": rows}, ensure_ascii=False, indent=0)
        + "\n"
    )
    log.info("wrote %s: %d settlements in %d counties", OUT, len(rows), len(COUNTIES))


if __name__ == "__main__":
    main()
