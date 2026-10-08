from pipeline.network import default_maxspeed


def test_main_roads_without_a_speed_limit_get_the_law_s():
    # Through a settlement: 50 km/h, whether built up around or named a street.
    assert default_maxspeed({"highway": "secondary"}, 0.6) == "50"
    assert default_maxspeed({"highway": "tertiary", "name": "Vatrogasna ulica"}, 0.0) == "50"
    assert default_maxspeed({"highway": "primary", "name": "Trg bana Jelačića"}, 0.0) == "50"
    # Outside: 90 km/h on primary and secondary roads; tertiary roads keep netconvert's 80.
    assert default_maxspeed({"highway": "secondary", "ref": "2216"}, 0.1) == "90"
    assert default_maxspeed({"highway": "primary_link"}, 0.0) == "90"
    assert default_maxspeed({"highway": "tertiary", "name": "Hrebinečka cesta"}, 0.0) is None
    # Roads with a limit, and other classes, are left alone.
    assert default_maxspeed({"highway": "secondary", "maxspeed": "70"}, 0.9) is None
    assert default_maxspeed({"highway": "secondary", "maxspeed:forward": "60"}, 0.9) is None
    assert default_maxspeed({"highway": "residential"}, 0.9) is None
    assert default_maxspeed({"highway": "motorway"}, 0.0) is None
