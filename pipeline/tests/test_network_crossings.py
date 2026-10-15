from pathlib import Path

import osmium

from pipeline.network import filter_roads


def test_tram_level_crossings_are_left_out_but_railway_ones_kept(tmp_path: Path):
    # A street crossing a tram track (node 2, a tram level crossing) and a railway (node 5,
    # a level crossing that closes for trains).
    src = tmp_path / "in.osm"
    src.write_text(
        """<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
 <node id="1" lat="45.8000" lon="15.9700"/>
 <node id="2" lat="45.8000" lon="15.9710"><tag k="railway" v="tram_level_crossing"/></node>
 <node id="3" lat="45.8000" lon="15.9720"/>
 <node id="4" lat="45.8010" lon="15.9710"/>
 <node id="5" lat="45.8000" lon="15.9730"><tag k="railway" v="level_crossing"/></node>
 <node id="6" lat="45.8010" lon="15.9730"/>
 <way id="10"><nd ref="1"/><nd ref="2"/><nd ref="3"/><nd ref="5"/>
  <tag k="highway" v="residential"/></way>
 <way id="11"><nd ref="4"/><nd ref="2"/><tag k="railway" v="tram"/></way>
 <way id="12"><nd ref="6"/><nd ref="5"/><tag k="railway" v="rail"/></way>
</osm>
"""
    )
    dst = tmp_path / "roads.osm"
    filter_roads(src, dst)
    tags = {n.id: dict(n.tags) for n in osmium.FileProcessor(str(dst), osmium.osm.NODE)}
    assert tags[2] == {}
    assert tags[5] == {"railway": "level_crossing"}
    assert set(tags) == {1, 2, 3, 4, 5, 6}
