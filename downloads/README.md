# Ready-made downloads

No building needed. All of these were built from the code in this repo.

| File | What it's for | How to use it |
|---|---|---|
| `PlaneRadar-CarThing-v0.12.2.zip` | Car Thing app | DeskThing → Apps → Upload App → pick this zip. Then set **Pi address** in the app's settings. |
| `PlaneRadar-display-v3.3-full.bin` | Round display, **first install** | Flash at address **0x0** with [ESP Web Flasher](https://espressif.github.io/esptool-js/) in Chrome. |
| `PlaneRadar-display-v3.3-update.bin` | Round display, **updating** an existing install | Flash at address **0x10000**. Keeps your saved Wi-Fi and Pi address. |

After a first install, the display makes a Wi-Fi hotspot called **PlaneRadar-Setup**. Join it from your phone, pick your Wi-Fi, and type your Pi's address.

Note: the display firmware has the GSP and SPA airports (South Carolina) built in. To show your own airports, edit `AIRPORTS` in `firmware/PlaneRadar/PlaneRadar.ino` and build it yourself.
