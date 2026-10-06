import numpy as np

from pipeline.landcover import BUILT_UP, CLASSES, WATER, ground_colours


def test_ground_colours_follow_class_palette():
    classes = np.full((64, 64), WATER, np.uint8)
    classes[:, 32:] = BUILT_UP
    rgb = ground_colours(classes).astype(float)
    water = rgb[16:48, 4:24].mean(axis=(0, 1))
    built = rgb[16:48, 40:60].mean(axis=(0, 1))
    np.testing.assert_allclose(water, CLASSES[WATER][1], atol=12)
    np.testing.assert_allclose(built, CLASSES[BUILT_UP][1], atol=12)


def test_ground_colours_is_deterministic():
    classes = np.random.default_rng(1).choice(list(CLASSES), size=(32, 32)).astype(np.uint8)
    assert np.array_equal(ground_colours(classes), ground_colours(classes))
