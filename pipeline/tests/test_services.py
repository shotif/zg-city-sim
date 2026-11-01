from pipeline.services import (
    BRANCH_SCHOOL_PLACES,
    CITY_KINDERGARTEN_CHILDREN,
    GP_MEAN_LIST,
    GP_TEAM,
    HEALTH_CENTRE,
    PRIVATE_KINDERGARTEN_PLACES,
    PRIVATE_SCHOOL_PLACES,
    REGULAR,
    city_services,
    classify,
    deduplicate,
    tidy_name,
)


def test_openstreetmap_services_are_told_apart_by_their_tags_and_names():
    def kind(**tags):
        return classify(tags)

    school = kind(amenity="school", **{"isced:level": "1;2"}, name="Osnovna škola Jabukovac")
    assert school == ("school", REGULAR)
    branch = kind(amenity="school", name="Područna škola Planina Gornja")
    assert branch == ("school", BRANCH_SCHOOL_PLACES)
    private = kind(amenity="school", **{"isced:level": "1;2"}, name="Privatna osnovna škola Epoha")
    assert private == ("school", PRIVATE_SCHOOL_PLACES)
    # Secondary schools are not primary.
    assert kind(amenity="school", **{"isced:level": "3"}, name="XVI. gimnazija") is None
    assert kind(amenity="kindergarten", name="Dječji vrtić Jarun") == ("kindergarten", REGULAR)
    assert kind(amenity="kindergarten", **{"operator:type": "private"}) == (
        "kindergarten",
        PRIVATE_KINDERGARTEN_PLACES,
    )
    assert kind(amenity="clinic", name="Dom zdravlja Savica") == ("health", HEALTH_CENTRE)
    assert kind(amenity="doctors", name="Ordinacija opće / obiteljske medicine") == (
        "health",
        GP_TEAM,
    )
    assert kind(amenity="clinic", name="Poliklinika Medikol") is None
    # Professional fire brigades, not volunteer halls; local police stations.
    assert kind(amenity="fire_station", name="Vatrogasna postaja Zagreb (Dubrava)") == ("fire", 0)
    assert kind(amenity="fire_station", name="DVD Granešina") is None
    assert kind(amenity="police", name="VI. policijska postaja Zagreb") == ("police", 0)
    assert kind(amenity="police", name="Policijska uprava zagrebačka") is None


def test_a_place_mapped_twice_is_kept_once():
    s = [
        {"kind": "school", "name": "OŠ A", "x": 0.0, "z": 0.0, "places": 1},
        {"kind": "school", "name": "OŠ A", "x": 40.0, "z": 0.0, "places": 1},
        {"kind": "school", "name": "", "x": 20.0, "z": 0.0, "places": 1},
        {"kind": "school", "name": "OŠ B", "x": 30.0, "z": 0.0, "places": 1},
        {"kind": "kindergarten", "name": "OŠ A", "x": 0.0, "z": 0.0, "places": 1},
    ]
    kept = deduplicate(s)
    assert sorted((k["kind"], k["name"]) for k in kept) == [
        ("kindergarten", "OŠ A"),
        ("school", "OŠ A"),
        ("school", "OŠ B"),
    ]


def test_names_in_capitals_are_written_as_croatian_writes_them():
    assert tidy_name("OSNOVNA ŠKOLA IVANA GORANA KOVAČIĆA") == "Osnovna škola Ivana Gorana Kovačića"
    assert (
        tidy_name("PODRUČNA ŠKOLA LEKENIK (OŠ BREZOVICA)")
        == "Područna škola Lekenik (OŠ Brezovica)"
    )
    assert tidy_name("IVANA BRLIĆ-MAŽURANIĆ") == "Ivana Brlić-Mažuranić"
    assert tidy_name("VIII. POLICIJSKA POSTAJA") == "VIII. Policijska Postaja"


def test_the_citys_services_take_its_counts_and_share_its_totals():
    at = {"X": "15.97", "Y": "45.81"}
    rows = {
        "school": [
            {**at, "naziv": "OSNOVNA ŠKOLA A", "vrsta_odg_ust": "REDOVNA ŠKOLA", "br_uc": "500"},
            {**at, "naziv": "OSNOVNA ŠKOLA B", "vrsta_odg_ust": "REDOVNA ŠKOLA", "br_uc": ""},
            {**at, "naziv": "GLAZBENA ŠKOLA", "vrsta_odg_ust": "UMJETNIČKA ŠKOLA", "br_uc": "300"},
        ],
        "kindergarten": [
            {**at, "naziv": "JARUN", "adresa": "Ulica 1", "vr_vrtica": "Gradski vrtić"},
            {**at, "naziv": "JARUN", "adresa": "Ulica 2", "vr_vrtica": "Gradski vrtić"},
            {**at, "naziv": "IGRA", "adresa": "", "vr_vrtica": "Privatni vrtić"},
        ],
        "health": [
            {
                **at,
                "Domovi_zdravlja_naziv": "Dom zdravlja Zagreb - Zapad",
                "Domovi_zdravlja_adresa": "A 1",
            }
        ],
        "police": [
            {**at, "naziv": "I. Policijska postaja Zagreb"},
            {**at, "naziv": "Prijavništvo i osobne isprave"},
        ],
    }
    out = city_services(rows, residents=GP_MEAN_LIST * 10)
    got = [(s["kind"], s["name"], s["places"]) for s in out]
    assert got == [
        ("school", "Osnovna škola A", 500),
        # No count: the median of those with one; art schools are left out.
        ("school", "Osnovna škola B", 500),
        ("kindergarten", "Dječji vrtić Jarun, Ulica 1", CITY_KINDERGARTEN_CHILDREN // 2),
        ("kindergarten", "Dječji vrtić Jarun, Ulica 2", CITY_KINDERGARTEN_CHILDREN // 2),
        ("kindergarten", "Dječji vrtić Igra", PRIVATE_KINDERGARTEN_PLACES),
        ("health", "Dom zdravlja Zagreb - Zapad, A 1", 10 * GP_TEAM),
        ("police", "I. Policijska postaja Zagreb", 0),
    ]
