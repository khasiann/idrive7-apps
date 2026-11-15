'use strict';

/**
 * Intake air temperature and ethanol content, for the HUD's IAT and ETH readouts.
 * Modelled on knock.js: the engine unit (DME, 0x12) over read-only UDS 22, on the gearbox reader's
 * shared diagnostics link. Nothing is ever written to the car.
 *
 *   580F  intake air temperature   (Live Data "Intake air", engine unit; OBD 0F is its fallback)
 *   550D  ethanol in the fuel      (Live Data "Ethanol in the fuel"; OBD 52 is its fallback)
 *
 * The raw byte is read as is and scaled below, so the scaling is easy to correct.
 *   ethanol  550D: one byte, raw x 100 / 255 %, FF = no data. Taken from the Perea flex fuel app's
 *            protocol.js (alexpereap/pereaperformance-idrive7-apps, PROZENT_ALK_KRST): the alcohol
 *            percentage the DME itself believes the fuel has.
 *   iat      580F: NOT confirmed. The default is the standard OBD one, raw - 40 degrees C. Check the
 *            first-run log line against Live Data (21 C = 70 F should log raw 61).
 * The first reading of each is logged (raw and scaled), and a value outside its range is dropped, so
 * a wrong scale shows nothing rather than a wrong number.
 *
 * Read every 2 s while wanted (the HUD shows one of them and the engine runs). Never throws.
 * value() is { iat (degrees C or null), ethanol (% or null) }.
 */

const { DidReader } = require('./kit/dids');

const ECU = 0x12;
// CHANGE HERE if the first-run log line shows the scale is off: value = raw * factor + offset
const SLOTS = [
    { key: 'iat', did: '580F', label: 'intake air temperature', unit: 'C', factor: 1, offset: -40, lo: -40, hi: 120 },
    // bad: raw bytes that mean "no data" (the DME answers FF when it has no alcohol percentage)
    { key: 'ethanol', did: '550D', label: 'ethanol content', unit: '%', factor: 100 / 255, offset: 0, lo: 0, hi: 100, bad: [255] },
];

const POLL_MS = 2000, STALE_MS = 8000, FAIL_RETRY_MS = 60000;

class IntakeWatch {
    /** linkOf: () => a ReadOnlyDiag (the gearbox reader's, shared). */
    constructor(ctx, linkOf) {
        this.ctx = ctx; this.log = ctx.log; this.linkOf = linkOf;
        this.rd = null; this.timer = null; this.busy = false;
        this.slots = SLOTS.map((s) => Object.assign({ v: null, t: 0, fails: 0, triedT: 0, logged: false }, s));
    }

    start() {
        if (this.timer) return;
        try {
            if (!this.rd) this.rd = new DidReader(this.linkOf(), { ecu: ECU });
            this._wake(); // a new start (the engine on again): asked even if the link gave up on it
            this.timer = setInterval(() => this._poll(), POLL_MS);
            this._poll();
        } catch (e) { this.log.warn('intake: ' + (e && e.message || e)); }
    }

    stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

    /** The link stops asking a unit after 5 misses in a row (other readers count too) until it is woken. */
    _wake() { const l = this.rd && this.rd.diag; if (l && typeof l.wake === 'function') { try { l.wake(ECU); } catch (e) { /* never */ } } }

    _poll() {
        if (this.busy || !this.rd) return;
        // the shared link not up yet: not a failed read (it would count towards the back-off)
        const link = this.rd.diag;
        if (link && (link.ready === false || link.available === false)) return;
        const now = Date.now();
        // a value that has not answered 3 times is tried once a minute
        const due = this.slots.filter((s) => s.fails < 3 || now - s.triedT >= FAIL_RETRY_MS);
        if (!due.length) return;
        if (due.some((s) => s.fails >= 3)) this._wake();
        this.busy = true;
        let chain = Promise.resolve();
        due.forEach((s) => { chain = chain.then(() => this._read(s)); });
        chain.catch((e) => { this.log.warn('intake: ' + (e && e.message || e)); }).then(() => { this.busy = false; });
    }

    _read(s) {
        // one descriptor per call, as knock.js does; the raw byte, scaled here
        const desc = [{ ecu: ECU, did: s.did, bytes: 1, at: 0, factor: 1, offset: 0, min: 0, max: 255 }];
        return Promise.resolve().then(() => this.rd.value('intake-' + s.key, desc)).then((raw) => {
            s.triedT = Date.now();
            if (raw === null || raw === undefined) {
                if (++s.fails === 3) this.log.info('intake: the engine unit gives no ' + s.label + ' (' + s.did + '); no ' + s.key + ' readout on this car');
                return;
            }
            if (s.bad && s.bad.indexOf(raw) >= 0) {
                if (++s.fails === 3) this.log.info('intake: the engine unit has no ' + s.label + ' (' + s.did + ' answers ' + raw + ' = no data)');
                return;
            }
            const v = raw * s.factor + s.offset;
            if (!(v >= s.lo && v <= s.hi)) {
                s.fails++;
                this.log.info('intake: ' + s.label + ' raw ' + raw + ' scales to ' + v.toFixed(1) + ' ' + s.unit + ', outside ' + s.lo + '..' + s.hi + ': dropped (the scale may differ)');
                return;
            }
            if (!s.logged) { s.logged = true; this.log.info('intake: ' + s.label + ' (' + s.did + ') raw ' + raw + ' = ' + v.toFixed(1) + ' ' + s.unit); }
            s.fails = 0; s.v = v; s.t = s.triedT;
        }).catch((e) => { s.triedT = Date.now(); s.fails++; this.log.warn('intake: ' + (e && e.message || e)); });
    }

    value() {
        const now = Date.now(), out = {};
        this.slots.forEach((s) => { out[s.key] = s.v !== null && now - s.t < STALE_MS ? s.v : null; });
        return out;
    }
}

module.exports = IntakeWatch;
