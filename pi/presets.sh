# Tower radio presets. Each preset is one thing you can pick from Home Assistant or the Car Thing.
# These are EXAMPLES for the Greenville-Spartanburg, SC area. Look up your own airports on airnav.com
# (Communications section) and replace them.
#
#   multi FILE "Title" CENTER_MHZ "freq|Label" ...   play several frequencies at once
#        (they must all fit inside ~2 MHz; CENTER_MHZ goes between them, not on top of one)
#   scan  FILE "Title" "freq|Label" ...              hop between frequencies, stop on whoever talks
#
# The first preset is the one the radio starts on.

multi 01_gsp_gmu        "GSP + GMU (Tower + Approach)"  119.65 "120.1|GSP Tower" "118.8|GSP Approach West" "119.4|GSP Approach East" "119.9|GMU Tower"
multi 02_grounds_spa    "Grounds + SPA"                 122.15 "121.25|GMU Ground" "121.4|Donaldson Ground" "121.9|GSP Ground" "123.0|SPA (no tower)"
multi 03_gyh_center     "Donaldson + Atlanta Center"    134.34 "133.325|Donaldson Tower" "135.35|Atlanta Center"
scan  04_scan_all       "Scan everything"               "120.1|GSP Tower" "118.8|GSP Approach West" "119.4|GSP Approach East" "121.9|GSP Ground" \
                                                        "119.9|GMU Tower" "121.25|GMU Ground" "133.325|Donaldson Tower" "121.4|Donaldson Ground" "123.0|SPA" "135.35|Atlanta Center"
multi 10_gsp_tower      "GSP Tower only"                120.35 "120.1|GSP Tower"
multi 11_gsp_approach   "GSP Approach only"             119.1  "118.8|GSP Approach West" "119.4|GSP Approach East"
multi 12_gsp_ground     "GSP Ground only"               122.15 "121.9|GSP Ground"
multi 13_gmu_tower      "GMU Tower only"                120.15 "119.9|GMU Tower"
multi 14_gyh_tower      "Donaldson Tower only"          133.575 "133.325|Donaldson Tower"
multi 15_spa            "SPA only"                      123.25 "123.0|SPA"
multi 16_atl_center     "Atlanta Center only"           135.6  "135.35|Atlanta Center"
