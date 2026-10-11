"""Census 2021 population of each settlement (naselje) in the counties the map covers, and
each town's commuters.

    python -I -c "import sys; sys.path.insert(0, '.'); from pipeline import census; census.main()"
    python -I -c "import sys; sys.path.insert(0, '.'); from pipeline import census; \
        census.main_commuters()"

(`-I` keeps the download off Python's import path; the line puts the repository back.)

The first downloads the Croatian Bureau of Statistics' workbook of population by settlement
(about 3 MB) into pipeline/.cache/census/ and writes pipeline/data/census_2021_settlements.json,
which pipeline/demand.py reads to give the towns and villages around the City their
residents. The second downloads the workbook of population by towns and municipalities
(about 18 MB) and writes pipeline/data/census_2021_commuters.json: each town's employed
residents and its daily commuters by where they work (M13), which the validation compares
the simulated commutes with. Neither is part of `python -m pipeline all`: the results are
committed, so CI does not need openpyxl (`pip install openpyxl`), which reads the workbooks.
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


TOWNS_URL = (
    "https://podaci.dzs.hr/media/td3jvrbu/popis_2021-stanovnistvo_po_gradovima_opcinama.xlsx"
)
COMMUTERS_OUT = PIPELINE_DIR / "data" / "census_2021_commuters.json"
TOWNS_ATTRIBUTION = {
    "name": "DZS, Census 2021, population by towns/municipalities",
    "text": "Employed residents (table 12) and daily commuters by where they work (table 18, "
    "daily and weekly migrants) of each town and municipality, from the Croatian Bureau of "
    "Statistics (Državni zavod za statistiku), Census of Population, Households and Dwellings "
    "2021.",
    "url": TOWNS_URL,
}


def _number(value) -> int:
    """A cell's count: '-' (none) and empty cells are 0."""
    return int(value) if isinstance(value, (int, float)) else 0


def read_commuters(path: Path) -> list[dict]:
    """Each town's, municipality's and City district's employed residents (table 12, all ages)
    and employed daily commuters (table 18) by where they work: another settlement of the
    same town, another town of the same county, another county, abroad. The City of Zagreb
    as a whole is the row with no town; its districts are kind 'Gradska četvrt'."""
    import openpyxl

    book = openpyxl.load_workbook(path, read_only=True)
    employed: dict[tuple[str, str], int] = {}
    for row in book["12."].iter_rows(values_only=True):
        county, town, age, sex = row[0], row[4], row[5], row[7]
        if county in COUNTIES and age == "Ukupno" and sex == "sv.":
            employed[(county, town or "Zagreb")] = _number(row[11])
    out = []
    for row in book["18."].iter_rows(values_only=True):
        county, kind, town, sex = row[0], row[1], row[4], row[5]
        if county not in COUNTIES or sex != "sv." or (kind is None and town is not None):
            continue
        if kind is None and county != "Grad Zagreb":
            continue  # a county's total
        name = town or "Zagreb"
        out.append(
            {
                "county": county,
                "kind": kind or "Grad",
                "town": name,
                "employed": employed.get((county, name), 0),
                "commuters": _number(row[8]),
                "withinTown": _number(row[9]),
                "otherTown": _number(row[10]),
                "otherCounty": _number(row[11]),
                "abroad": _number(row[12]),
            }
        )
    return out


def main_commuters() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    rows = read_commuters(download(TOWNS_URL, CACHE_DIR / "census" / "towns_2021.xlsx"))
    COMMUTERS_OUT.write_text(
        json.dumps({"source": TOWNS_ATTRIBUTION, "towns": rows}, ensure_ascii=False, indent=0)
        + "\n"
    )
    log.info("wrote %s: %d towns, municipalities and districts", COMMUTERS_OUT, len(rows))


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
