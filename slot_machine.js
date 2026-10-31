/*
 * Lucky Slots for M5StickS3 - Bruce firmware (mQuickJS)
 *
 * HOLD M5 (GPIO 11) ~0.5 s -> start spin
 * CLICK M5 -> stop reel 1, then reel 2, then reel 3
 * LONG-PRESS side button -> quit
 *
 * Bruce mQuickJS has no IMU module, so hold-to-start replaces shake.
 * ES5 single file. One main loop polls the button often and redraws
 * at most one changed reel per pass. Reels are composed in PSRAM
 * sprites and pushed in one operation, which prevents TFT flicker.
 */

var display = require("display");
var keyboard = require("keyboard");

var gpio = null;
var gpioOk = false;
try {
    gpio = require("gpio");
    gpio.pinMode(11, "input", "up");
    gpioOk = true;
} catch (e) {
    gpioOk = false;
}

var BTN_PIN = 11;
var HOLD_MS = 500;
var DEBOUNCE_MS = 20;
var FRAME_MS = 30;
var RESULT_MS = 1300;
var LOOP_MS = 2;
var SYMBOLS = 4;

var W = display.width();
var H = display.height();

var margin = Math.floor(W * 0.025);
if (margin < 4) margin = 4;
var gap = Math.floor(W * 0.018);
if (gap < 3) gap = 3;
var headerH = Math.floor(H * 0.16);
if (headerH < 18) headerH = 18;
var footerH = Math.floor(H * 0.135);
if (footerH < 15) footerH = 15;

var reelTop = headerH + 4;
var reelH = H - footerH - 3 - reelTop;
if (reelH < 36) reelH = 36;
var reelW = Math.floor((W - margin * 2 - gap * 2) / 3);
var reelX = [margin, margin + reelW + gap, margin + (reelW + gap) * 2];

var innerW = reelW - 4;
var innerH = reelH - 4;
var symStep = Math.floor(innerH / 3);
if (symStep < 10) symStep = 10;
var symR = Math.floor(innerW * 0.40);
var maxR = Math.floor((symStep - 2) / 2);
if (symR > maxR) symR = maxR;
if (symR > 16) symR = 16;
if (symR < 6) symR = 6;

var reelCy = reelTop + Math.floor(reelH / 2);
var titleSize = 2;
if (W < 190) titleSize = 1;

var C_BG = display.color(8, 10, 16);
var C_HEADER = display.color(24, 16, 40);
var C_FOOTER = display.color(14, 12, 24);
var C_GOLD = display.color(255, 201, 64);
var C_GOLD_DIM = display.color(112, 84, 32);
var C_CREAM = display.color(250, 246, 232);
var C_GREEN = display.color(60, 200, 110);
var C_GRAY = display.color(140, 140, 150);

var C_LEMON = display.color(255, 222, 64);
var C_LEMON_LIGHT = display.color(255, 245, 170);
var C_LEMON_DARK = display.color(214, 168, 28);
var C_CHERRY = display.color(220, 40, 60);
var C_CHERRY_LIGHT = display.color(255, 120, 130);
var C_CHERRY_DARK = display.color(140, 20, 40);
var C_STEM = display.color(110, 70, 35);
var C_LEAF = display.color(70, 180, 80);
var C_ORANGE = display.color(255, 145, 30);
var C_ORANGE_LIGHT = display.color(255, 200, 110);
var C_ORANGE_DARK = display.color(190, 92, 10);
var C_SEVEN = display.color(235, 48, 60);
var C_SEVEN_DARK = display.color(120, 16, 30);
var C_MAGIC = display.color(255, 0, 255);

/* Off-screen reel buffers. On the StickS3 build BOARD_HAS_PSRAM is set,
 * so display.createSprite() gives real PSRAM-backed sprites. */
var reelSprites = [null, null, null];
var spriteOk = false;
var gfx = display;
var gfxOX = 0;
var gfxOY = 0;

var STATE_READY = 0;
var STATE_SPIN = 1;
var STATE_RESULT = 2;
var RS_STOP = 0;
var RS_SPIN = 1;
var RS_STOPPING = 2;

var running = true;
var state = STATE_READY;
var reelPos = [0, 1, 2];
var reelScroll = [0, 0, 0];
var reelSpeed = [9, 11, 13];
var reelState = [0, 0, 0];
var stopTarget = [0, 0, 0];
var stopLeft = [0, 0, 0];
var nextFrame = [0, 0, 0];
var dirty = [1, 1, 1];
var stopIndex = 0;
var serviceCursor = 0;
var winLevel = 0;
var winReels = [false, false, false];
var resultUntil = 0;

var clickEvent = false;
var btnDown = false;
var lastRaw = false;
var rawChangedAt = 0;
var holdStart = 0;
var holdActive = false;
var needRelease = false;
var waitRelease = false;
var symClipTop = 0;
var symClipBottom = 135;

function mod4(v) {
    var r = v % SYMBOLS;
    if (r < 0) r = r + SYMBOLS;
    return r;
}

function fillRectClip(x, y, w, h, color) {
    var y0 = y;
    var y1 = y + h;
    if (y1 <= symClipTop || y0 >= symClipBottom) return;
    if (y0 < symClipTop) y0 = symClipTop;
    if (y1 > symClipBottom) y1 = symClipBottom;
    if (y1 > y0) gfx.drawFillRect(x - gfxOX, y0 - gfxOY, w, y1 - y0, color);
}

function fillEllipse(cx, cy, rx, ry, color) {
    if (rx < 1) rx = 1;
    if (ry < 1) ry = 1;
    var y;
    var ry2 = ry * ry;
    for (y = -ry; y <= ry; y += 2) {
        var t = 1 - (y * y) / ry2;
        if (t < 0) t = 0;
        var xx = Math.floor(rx * Math.sqrt(t));
        fillRectClip(cx - xx, cy + y, xx * 2 + 1, 2, color);
    }
}

function fillCircleClip(cx, cy, r, color) {
    if (cy - r >= symClipTop && cy + r < symClipBottom) {
        gfx.drawFillCircle(cx - gfxOX, cy - gfxOY, r, color);
        return;
    }
    fillEllipse(cx, cy, r, r, color);
}

function drawLineClip(x0, y0, x1, y1, color) {
    if (y0 === y1) {
        if (y0 >= symClipTop && y0 <= symClipBottom) {
            gfx.drawLine(x0 - gfxOX, y0 - gfxOY, x1 - gfxOX, y1 - gfxOY, color);
        }
        return;
    }
    if ((y0 < symClipTop && y1 < symClipTop) || (y0 > symClipBottom && y1 > symClipBottom)) return;
    if (y0 < symClipTop) {
        x0 = x0 + (x1 - x0) * (symClipTop - y0) / (y1 - y0);
        y0 = symClipTop;
    } else if (y0 > symClipBottom) {
        x0 = x0 + (x1 - x0) * (symClipBottom - y0) / (y1 - y0);
        y0 = symClipBottom;
    }
    if (y1 < symClipTop) {
        x1 = x1 + (x0 - x1) * (symClipTop - y1) / (y0 - y1);
        y1 = symClipTop;
    } else if (y1 > symClipBottom) {
        x1 = x1 + (x0 - x1) * (symClipBottom - y1) / (y0 - y1);
        y1 = symClipBottom;
    }
    gfx.drawLine(Math.floor(x0) - gfxOX, Math.floor(y0) - gfxOY,
        Math.floor(x1) - gfxOX, Math.floor(y1) - gfxOY, color);
}

function drawLemon(cx, cy, r) {
    fillEllipse(cx, cy, Math.floor(r * 0.84), Math.floor(r * 0.62), C_LEMON);
    fillEllipse(cx - Math.floor(r * 0.24), cy - Math.floor(r * 0.14),
        Math.floor(r * 0.26), Math.floor(r * 0.12), C_LEMON_LIGHT);
    fillCircleClip(cx - Math.floor(r * 0.84), cy, Math.max(1, Math.floor(r * 0.11)), C_LEMON_DARK);
    fillCircleClip(cx + Math.floor(r * 0.84), cy, Math.max(1, Math.floor(r * 0.11)), C_LEMON_DARK);
    fillEllipse(cx + Math.floor(r * 0.22), cy - Math.floor(r * 0.68),
        Math.floor(r * 0.28), Math.floor(r * 0.12), C_LEAF);
    drawLineClip(cx, cy - Math.floor(r * 0.56), cx + Math.floor(r * 0.10),
        cy - Math.floor(r * 0.66), C_STEM);
}

function drawCherry(cx, cy, r) {
    var lx = cx - Math.floor(r * 0.34);
    var ly = cy + Math.floor(r * 0.22);
    var rx = cx + Math.floor(r * 0.34);
    var ry = cy + Math.floor(r * 0.10);
    var cr = Math.floor(r * 0.40);
    var top = cy - Math.floor(r * 0.62);
    drawLineClip(lx, ly - cr + 1, cx + Math.floor(r * 0.05), top, C_STEM);
    drawLineClip(rx, ry - cr + 1, cx + Math.floor(r * 0.05), top, C_STEM);
    fillEllipse(cx + Math.floor(r * 0.22), cy - Math.floor(r * 0.66),
        Math.floor(r * 0.26), Math.floor(r * 0.11), C_LEAF);
    fillCircleClip(lx, ly, cr, C_CHERRY_DARK);
    fillCircleClip(rx, ry, cr, C_CHERRY_DARK);
    fillCircleClip(lx, ly, cr - 1, C_CHERRY);
    fillCircleClip(rx, ry, cr - 1, C_CHERRY);
    fillCircleClip(lx - Math.floor(cr * 0.35), ly - Math.floor(cr * 0.35),
        Math.max(1, Math.floor(cr * 0.22)), C_CHERRY_LIGHT);
}

function drawSevenSlant(cx, cy, r, color, dx, dy) {
    var yStart = cy - Math.floor(r * 0.50) + dy;
    var yEnd = cy + Math.floor(r * 0.70) + dy;
    var xStart = cx + Math.floor(r * 0.42) + dx;
    var xEnd = cx - Math.floor(r * 0.42) + dx;
    var thick = Math.floor(r * 0.18);
    if (thick < 2) thick = 2;
    var span = yEnd - yStart;
    if (span < 1) span = 1;
    var yy;
    for (yy = yStart; yy <= yEnd; yy += 2) {
        var t = (yy - yStart) / span;
        var xx = Math.floor(xStart + (xEnd - xStart) * t);
        fillRectClip(xx - thick, yy, thick * 2 + 1, 2, color);
    }
}

function drawSeven(cx, cy, r) {
    var bw = Math.floor(r * 1.14);
    if (bw < 5) bw = 5;
    var bh = Math.floor(r * 0.28);
    if (bh < 2) bh = 2;
    var bx = cx - Math.floor(bw / 2);
    var by = cy - Math.floor(r * 0.72);
    drawSevenSlant(cx, cy, r, C_SEVEN_DARK, 1, 1);
    fillRectClip(bx + 1, by + 1, bw, bh, C_SEVEN_DARK);
    drawSevenSlant(cx, cy, r, C_SEVEN, 0, 0);
    fillRectClip(bx, by, bw, bh, C_SEVEN);
}

function drawOrange(cx, cy, r) {
    var rr = Math.floor(r * 0.84);
    if (rr < 4) rr = 4;
    fillCircleClip(cx, cy, rr, C_ORANGE_DARK);
    fillCircleClip(cx, cy - 1, rr - 2, C_ORANGE);
    fillEllipse(cx - Math.floor(r * 0.24), cy - Math.floor(r * 0.18),
        Math.floor(r * 0.22), Math.floor(r * 0.12), C_ORANGE_LIGHT);
    fillEllipse(cx + Math.floor(r * 0.22), cy - Math.floor(r * 0.78),
        Math.floor(r * 0.26), Math.floor(r * 0.11), C_LEAF);
    drawLineClip(cx, cy - rr + 1, cx + Math.floor(r * 0.10),
        cy - Math.floor(r * 0.80), C_STEM);
}

function drawSymbol(idx, cx, cy, r) {
    if (idx === 0) drawLemon(cx, cy, r);
    else if (idx === 1) drawCherry(cx, cy, r);
    else if (idx === 2) drawSeven(cx, cy, r);
    else drawOrange(cx, cy, r);
}

function setHeader(text, color) {
    display.drawFillRect(0, 0, W, headerH, C_HEADER);
    display.setTextAlign("center", "middle");
    display.setTextSize(titleSize);
    display.setTextColor(color);
    display.drawText(text, Math.floor(W / 2), Math.floor((headerH - 3) / 2));
    display.drawFillRect(margin, headerH - 3, W - margin * 2, 2, color);
}

function setFooter(text, color) {
    var top = H - footerH;
    display.drawFillRect(0, top, W, footerH, C_FOOTER);
    display.drawFillRect(0, top, W, 1, C_GOLD_DIM);
    display.setTextAlign("center", "middle");
    display.setTextSize(1);
    display.setTextColor(color);
    display.drawText(text, Math.floor(W / 2), top + Math.floor(footerH / 2));
}

function markAllDirty() {
    dirty[0] = 1;
    dirty[1] = 1;
    dirty[2] = 1;
}

function frameColor(i) {
    if (state === STATE_RESULT) {
        if (winLevel === 2) return C_GOLD;
        if (winLevel === 1 && winReels[i]) return C_GREEN;
        return C_GOLD_DIM;
    }
    if (state === STATE_READY) return C_GOLD_DIM;
    if (reelState[i] === RS_STOP) return C_GREEN;
    if (reelState[i] === RS_STOPPING) return C_GOLD;
    if (i === stopIndex) return C_GOLD;
    return C_GOLD_DIM;
}

function drawReel(i) {
    var x = reelX[i];
    var cx = x + Math.floor(reelW / 2);
    var j, yy;
    var spr = reelSprites[i];
    symClipTop = reelTop + 2;
    symClipBottom = reelTop + reelH - 2;
    gfx = display;
    gfxOX = 0;
    gfxOY = 0;
    if (spriteOk && spr) {
        /* Compose the whole reel off-screen, then blit it in one push.
         * This removes the clear-then-redraw flicker during scrolling. */
        gfx = spr;
        gfxOX = x;
        gfxOY = reelTop;
        spr.fill(C_BG);
        spr.drawFillRoundRect(0, 0, reelW, reelH, 6, frameColor(i));
        spr.drawFillRoundRect(2, 2, reelW - 4, reelH - 4, 4, C_CREAM);
    } else {
        display.drawFillRoundRect(x, reelTop, reelW, reelH, 6, frameColor(i));
        display.drawFillRoundRect(x + 2, reelTop + 2, reelW - 4, reelH - 4, 4, C_CREAM);
    }
    if (reelState[i] === RS_STOP) {
        drawSymbol(reelPos[i], cx, reelCy, symR);
    } else {
        for (j = -2; j <= 1; j++) {
            yy = reelCy + j * symStep + reelScroll[i];
            if (yy + symR < symClipTop || yy - symR > symClipBottom) continue;
            drawSymbol(mod4(reelPos[i] + j), cx, yy, symR);
        }
    }
    if (spriteOk && spr) {
        spr.pushSprite(x, reelTop, C_MAGIC);
        gfx = display;
        gfxOX = 0;
        gfxOY = 0;
    }
}

function serviceReels() {
    var i, k;
    for (k = 0; k < 3; k++) {
        i = (serviceCursor + k) % 3;
        if (dirty[i]) {
            dirty[i] = 0;
            serviceCursor = (i + 1) % 3;
            drawReel(i);
            return;
        }
    }
    for (k = 0; k < 3; k++) {
        i = (serviceCursor + k) % 3;
        if (reelState[i] !== RS_STOP && now() >= nextFrame[i]) {
            advanceReel(i);
            nextFrame[i] = now() + FRAME_MS;
            serviceCursor = (i + 1) % 3;
            drawReel(i);
            return;
        }
    }
}

function buttonReset() {
    if (!gpioOk) return;
    lastRaw = (gpio.digitalRead(BTN_PIN) === 0);
    btnDown = lastRaw;
    rawChangedAt = now();
    clickEvent = false;
}

function pollButton() {
    var raw = (gpio.digitalRead(BTN_PIN) === 0);
    var t = now();
    if (raw !== lastRaw) {
        lastRaw = raw;
        rawChangedAt = t;
    }
    if (t - rawChangedAt < DEBOUNCE_MS) return;
    if (raw && !btnDown) {
        btnDown = true;
        clickEvent = true;
    } else if (!raw && btnDown) {
        btnDown = false;
    }
}

function advanceReel(i) {
    var step = reelSpeed[i];
    var remain;
    if (reelState[i] === RS_STOPPING && stopLeft[i] === 1) {
        remain = symStep - reelScroll[i];
        if (remain > 0 && remain < step) step = remain;
    }
    reelScroll[i] = reelScroll[i] + step;
    while (reelScroll[i] >= symStep) {
        reelScroll[i] = reelScroll[i] - symStep;
        reelPos[i] = mod4(reelPos[i] - 1);
        if (reelState[i] === RS_STOPPING) {
            stopLeft[i] = stopLeft[i] - 1;
            if (stopLeft[i] <= 0) {
                reelScroll[i] = 0;
                reelPos[i] = stopTarget[i];
                reelState[i] = RS_STOP;
                break;
            }
        }
    }
}

var keyLockUntil = 0;

function drainKeys() {
    var k;
    for (k = 0; k < 2; k++) {
        keyboard.getAnyPress();
        keyboard.getSelPress();
        keyboard.getNextPress();
        keyboard.getPrevPress();
    }
}

function beginStop() {
    var i = stopIndex;
    if (i >= 3) return;
    var target = random(0, SYMBOLS);
    var steps = mod4(reelPos[i] - target);
    if (steps < 2) steps = steps + 4;
    stopTarget[i] = target;
    stopLeft[i] = steps;
    reelState[i] = RS_STOPPING;
    reelSpeed[i] = 12;
    dirty[i] = 1;
    stopIndex++;
    if (stopIndex < 3) {
        dirty[stopIndex] = 1;
        setFooter("M5: STOP REEL " + (stopIndex + 1), C_CREAM);
    } else {
        setFooter("WAIT...", C_GOLD);
    }
}

function startSpin() {
    var i;
    state = STATE_SPIN;
    stopIndex = 0;
    winLevel = 0;
    holdActive = false;
    clickEvent = false;
    waitRelease = gpioOk && btnDown;
    for (i = 0; i < 3; i++) {
        reelPos[i] = random(0, SYMBOLS);
        reelScroll[i] = 0;
        reelState[i] = RS_SPIN;
        reelSpeed[i] = 9 + i * 2;
        stopLeft[i] = 0;
        winReels[i] = false;
        nextFrame[i] = now() + i * 10;
        dirty[i] = 1;
    }
    setHeader("LUCKY SLOTS", C_GOLD);
    setFooter("M5: STOP REEL 1", C_CREAM);
}

function tickReady() {
    if (gpioOk) {
        if (!btnDown) {
            holdActive = false;
            needRelease = false;
            return;
        }
        if (needRelease) {
            holdActive = false;
            return;
        }
        if (!holdActive) {
            holdActive = true;
            holdStart = now();
        }
        if (now() - holdStart >= HOLD_MS) startSpin();
    } else {
        if (keyboard.getAnyPress()) {
            drainKeys();
            startSpin();
        }
    }
}

function tickSpin() {
    if (gpioOk) {
        if (waitRelease) {
            clickEvent = false;
            if (!btnDown) waitRelease = false;
            return;
        }
        if (clickEvent) {
            clickEvent = false;
            if (stopIndex < 3) beginStop();
        }
    } else {
        if (now() >= keyLockUntil && keyboard.getSelPress()) {
            keyLockUntil = now() + 350;
            if (stopIndex < 3) beginStop();
        }
    }
}

function tickResult() {
    clickEvent = false;
    if (now() >= resultUntil) enterReady();
}

function allStopped() {
    return reelState[0] === RS_STOP && reelState[1] === RS_STOP && reelState[2] === RS_STOP;
}

function finishSpin() {
    var a = reelPos[0];
    var b = reelPos[1];
    var c = reelPos[2];
    winLevel = 0;
    winReels[0] = false;
    winReels[1] = false;
    winReels[2] = false;
    if (a === b && b === c) {
        winLevel = 2;
        winReels[0] = true;
        winReels[1] = true;
        winReels[2] = true;
    } else if (a === b) {
        winLevel = 1;
        winReels[0] = true;
        winReels[1] = true;
    } else if (a === c) {
        winLevel = 1;
        winReels[0] = true;
        winReels[2] = true;
    } else if (b === c) {
        winLevel = 1;
        winReels[1] = true;
        winReels[2] = true;
    }
    state = STATE_RESULT;
    resultUntil = now() + RESULT_MS;
    if (winLevel === 2) {
        setHeader("JACKPOT!", C_GOLD);
        setFooter("3 OF A KIND - JACKPOT", C_GOLD);
    } else if (winLevel === 1) {
        setHeader("2 MATCH!", C_GREEN);
        setFooter("PAIR - SMALL WIN", C_GREEN);
    } else {
        setHeader("NO LUCK", C_GRAY);
        setFooter("TRY AGAIN", C_CREAM);
    }
    markAllDirty();
}

function enterReady() {
    var i;
    state = STATE_READY;
    holdActive = false;
    waitRelease = false;
    clickEvent = false;
    needRelease = gpioOk && btnDown;
    winLevel = 0;
    for (i = 0; i < 3; i++) {
        winReels[i] = false;
        reelState[i] = RS_STOP;
    }
    setHeader("LUCKY SLOTS", C_GOLD);
    setFooter(gpioOk ? "HOLD M5 TO SPIN" : "PRESS M5 TO SPIN", C_CREAM);
    markAllDirty();
}

function initSprites() {
    var i;
    var s;
    reelSprites[0] = null;
    reelSprites[1] = null;
    reelSprites[2] = null;
    spriteOk = false;
    if (typeof display.createSprite !== "function") return;
    try {
        for (i = 0; i < 3; i++) {
            s = display.createSprite(reelW, reelH);
            reelSprites[i] = s;
            /* A real PSRAM sprite reports its own dimensions. Without PSRAM
             * Bruce returns a dummy that draws straight to the screen. */
            if (!s || typeof s.pushSprite !== "function" ||
                typeof s.width !== "function" || typeof s.height !== "function" ||
                typeof s.fill !== "function" || typeof s.drawFillRoundRect !== "function" ||
                s.width() !== reelW || s.height() !== reelH) {
                freeSprites();
                return;
            }
        }
        spriteOk = true;
    } catch (e) {
        freeSprites();
    }
}

function freeSprites() {
    var i;
    for (i = 0; i < 3; i++) {
        if (reelSprites[i]) {
            if (typeof reelSprites[i].deleteSprite === "function") {
                reelSprites[i].deleteSprite();
            }
            reelSprites[i] = null;
        }
    }
    spriteOk = false;
}

function init() {
    initSprites();
    display.fill(C_BG);
    buttonReset();
    enterReady();
    keyLockUntil = 0;
}

function main() {
    init();
    while (running) {
        if (keyboard.getEscPress()) {
            running = false;
            break;
        }
        if (gpioOk) pollButton();
        if (state === STATE_READY) tickReady();
        else if (state === STATE_SPIN) tickSpin();
        else tickResult();
        serviceReels();
        if (state === STATE_SPIN && stopIndex === 3 && allStopped()) finishSpin();
        delay(LOOP_MS);
    }
    display.fill(C_BG);
    display.setTextAlign("center", "middle");
    display.setTextSize(2);
    display.setTextColor(C_GOLD);
    display.drawText("BYE!", Math.floor(W / 2), Math.floor(H / 2) - 8);
    display.setTextSize(1);
    display.setTextColor(C_CREAM);
    display.drawText("LUCKY SLOTS", Math.floor(W / 2), Math.floor(H / 2) + 12);
    delay(400);
    freeSprites();
}

main();
