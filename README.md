# Lucky Slots

A small three-reel slot machine for the **M5StickS3** running
[Bruce firmware](https://github.com/BruceDevices/firmware) with the mQuickJS
JavaScript interpreter.

## Features

- Three spinning reels with four symbols: lemon, cherry, 7 and orange.
- Sequential stopping: the first click stops the left reel, the second the
  middle reel and the third the right reel.
- Simple results: three of a kind is a jackpot, two of a kind is a small win,
  anything else is a loss.
- Reels are composed in PSRAM sprites and pushed to the display in one
  operation, which prevents TFT flicker during the animation.
- The main loop polls the button every pass and redraws at most one changed
  reel, keeping the controls responsive.

## Controls

| Action | Button |
| --- | --- |
| Start spinning | Hold the M5 button (GPIO 11) for about 0.5 seconds |
| Stop reel 1 / 2 / 3 | Click the M5 button |
| Exit the game | Long-press the side button |

Bruce mQuickJS does not expose an IMU module, so the hold-button start is used
instead of shake-to-start.

## Installation

1. Copy `slot_machine.js` to the `/scripts` folder on the StickS3 (SD card or
   LittleFS).
2. Open the **Scripts** menu in Bruce and run **slot_machine.js**.

## Requirements

- M5StickS3
- Bruce firmware with mQuickJS support

## Development notes

The script is a single ES5-compatible file. It does not use `let`, `const`,
arrow functions or `for...of`. The reel rendering is clipped at the reel edges
and uses three off-screen sprites (`display.createSprite` / `pushSprite`). If
real sprites are unavailable, the script falls back to direct drawing.

The current version was checked with Node's syntax checker, an ES5 parser,
a simulation harness covering jackpot/pair/loss, rapid clicks and held-button
starts, and visual frame rendering.
