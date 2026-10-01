import pytest

from buurtradar.parser import parse_message, parse_location, parse_postcode


@pytest.mark.parametrize("title, description, discipline, priority, street, city, postcode", [
    ("a1 13105 parnassiaveld 1115 duivendrecht 94056",
     "Ambulance met spoed naar Parnassiaveld in Duivendrecht",
     "ambulance", 1, "Parnassiaveld", "Duivendrecht", "1115"),
    ("a1 wilhelminakade 3072ap rotterdam rottdm",
     "Ambulance met spoed naar Wilhelminakade in Rotterdam",
     "ambulance", 1, "Wilhelminakade", "Rotterdam", "3072AP"),
    ("p 1 bnn-01 br container vrind optiek oosterstraat groningen 011832",
     "Buitenbrand (container) op Oosterstraat in Groningen",
     "brandweer", 1, "Oosterstraat", "Groningen", None),
    ("p 1 bnh-03 reanimatie achterdijk purmerend 115031",
     "Assistentie bij reanimatie op Achterdijk in Purmerend",
     "brandweer", 1, "Achterdijk", "Purmerend", None),
    ("ongeval wegvervoer letsel boerenkamplaan someren",
     "Politie naar Boerenkamplaan in Someren voor ongeval met letsel",
     "politie", None, "Boerenkamplaan", "Someren", None),
    ("a1 bergen op zoom rit: 171961",
     "Ambulance met spoed naar Bergen Op Zoom",
     "ambulance", 1, None, "Bergen Op Zoom", None),
    ("a0 reanimatie deventer 298883", "Reanimatie in Deventer",
     "ambulance", 0, None, "Deventer", None),
    ("p 1 bnh-01 br gebouw opkomstplaats 214 tata steel velsen-noord 129032",
     "Gebouwbrand in Velsen-Noord", "brandweer", 1, None, "Velsen-Noord", None),
    ("a2 ambu 17124 hoofdstraat 3311ab dordrecht", "Ambulance naar Hoofdstraat in Dordrecht",
     "ambulance", 2, "Hoofdstraat", "Dordrecht", "3311AB"),
    ("b2 ambu 17124 hoofdstraat dordrecht", "Besteld ambulancevervoer naar Hoofdstraat in Dordrecht",
     "ambulance", 3, "Hoofdstraat", "Dordrecht", None),
    ("a1 ambu 18177 havenstraat 3361xd sliedrecht sliedr bon 150152",
     "Ambulance met spoed naar Havenstraat in Sliedrecht",
     "ambulance", 1, "Havenstraat", "Sliedrecht", "3361XD"),
])
def test_parse_message(title, description, discipline, priority, street, city, postcode):
    msg = parse_message(title, description)
    assert msg.discipline == discipline
    assert msg.priority == priority
    assert (msg.street, msg.city) == (street, city)
    assert msg.postcode == postcode
    assert not msg.is_test


def test_sirene_flag():
    assert parse_message("a1 soest 158265", "Ambulance met spoed naar Soest").sirene
    assert parse_message("a0 reanimatie deventer", "Reanimatie in Deventer").sirene
    assert not parse_message("p 2 liftopsluiting", "Liftopsluiting in Ede").sirene


def test_test_messages_detected():
    assert parse_message("p 3 proefalarm kazerne ede", "Proefalarm in Ede").is_test


def test_street_before_city_in_bergen_op_zoom():
    assert parse_location("Ambulance met spoed naar Middenweg in Bergen op Zoom") == (
        "Middenweg", "Bergen op Zoom")


def test_postcode_ignores_unit_and_ride_numbers():
    assert parse_postcode("a1 ambu 07123 - wekerom rit 298880") is None
    assert parse_postcode("a1 13108 westzaanstraat 1013 amsterdam 94053") == "1013"
