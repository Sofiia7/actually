/* =====================================================================
   FROST EFFECT — texture generator + pointer tracking.

   Two exports (also attached to window for plain-script use):
     • buildFrostTexture(opts?)        → paints the static needle-crystal
                                         pattern once and sets the CSS var
                                         --frost-tex on :root (or a target).
     • attachFrostTracking(el, opts?)  → wires --mx/--my + .is-tracking on a
                                         .frost-host element. Returns a
                                         cleanup fn (call on unmount).

   No app logic, no dependencies. Safe to call buildFrostTexture() once at
   startup; call attachFrostTracking per panel.
   ===================================================================== */
(function (global) {
  'use strict';

  /* ---- 1. STATIC TEXTURE ------------------------------------------- */
  function buildFrostTexture(opts) {
    opts = opts || {};
    var T       = opts.tile     || 300;   // logical tile size (px)
    var dpr     = opts.dpr      || 2;     // crispness multiplier
    var N       = opts.nuclei   || 135;   // number of crystal bursts
    var cssVar  = opts.cssVar   || '--frost-tex';
    var target  = opts.target   || document.documentElement;

    var cv  = document.createElement('canvas');
    cv.width = cv.height = T * dpr;
    var ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.lineCap = 'round';

    // A single fine spicule: a thin straight ice needle with a couple of
    // even thinner barbs — thousands of these read as needle-frost.
    function needle(x, y, ang, len, w, alpha) {
      var x2 = x + Math.cos(ang) * len;
      var y2 = y + Math.sin(ang) * len;
      ctx.strokeStyle = 'rgba(255,255,255,' + alpha + ')';
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      var barbs = 2 + Math.floor(Math.random() * 3);
      for (var i = 1; i <= barbs; i++) {
        var t  = i / (barbs + 1);
        var bx = x + (x2 - x) * t;
        var by = y + (y2 - y) * t;
        var bl = len * 0.28 * (1 - t);
        for (var s = -1; s <= 1; s += 2) {
          var a2 = ang + s * 0.7;
          ctx.lineWidth = w * 0.7;
          ctx.beginPath();
          ctx.moveTo(bx, by);
          ctx.lineTo(bx + Math.cos(a2) * bl, by + Math.sin(a2) * bl);
          ctx.stroke();
        }
      }
    }

    // A burst = a radial starburst of needles from one nucleus.
    function burst(cx, cy) {
      var spikes = 10 + Math.floor(Math.random() * 14);
      var base   = Math.random() * Math.PI * 2;
      for (var i = 0; i < spikes; i++) {
        var ang = base + i / spikes * Math.PI * 2 + (Math.random() - 0.5) * 0.35;
        var len = 6 + Math.random() * 22;
        needle(cx, cy, ang, len, 0.5 + Math.random() * 0.4, 0.55 + Math.random() * 0.35);
      }
    }

    // Soft icy glow so the fine white needles read against the glass.
    ctx.shadowColor = 'rgba(180,205,245,0.55)';
    ctx.shadowBlur  = 0.8;

    // Scatter nuclei, each drawn across a 3×3 offset grid so the texture
    // tiles seamlessly when repeated.
    var offs = [-T, 0, T];
    for (var k = 0; k < N; k++) {
      var sx = Math.random() * T;
      var sy = Math.random() * T;
      for (var oi = 0; oi < 3; oi++) {
        for (var oj = 0; oj < 3; oj++) {
          burst(sx + offs[oi], sy + offs[oj]);
        }
      }
    }

    // Fine sparkle dust between the crystals.
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    for (var d = 0; d < 500; d++) {
      var r = Math.random() * 0.6 + 0.2;
      ctx.beginPath();
      ctx.arc(Math.random() * T, Math.random() * T, r, 0, Math.PI * 2);
      ctx.fill();
    }

    var url = cv.toDataURL('image/png');
    target.style.setProperty(cssVar, 'url("' + url + '")');
    return url;
  }

  /* ---- 2. POINTER TRACKING ----------------------------------------- */
  // Attach to a .frost-host element. Updates --mx/--my and toggles
  // .is-tracking when the pointer is over the element. Returns cleanup.
  function attachFrostTracking(el, opts) {
    opts = opts || {};
    if (!el) return function () {};
    function onMove(e) {
      var r = el.getBoundingClientRect();
      var x = ((e.clientX - r.left) / r.width) * 100;
      var y = ((e.clientY - r.top) / r.height) * 100;
      el.style.setProperty('--mx', x + '%');
      el.style.setProperty('--my', y + '%');
      var inside = e.clientX >= r.left && e.clientX <= r.right &&
                   e.clientY >= r.top && e.clientY <= r.bottom;
      el.classList.toggle('is-tracking', inside);
    }
    // Listen on window so the reveal eases out as the cursor leaves.
    window.addEventListener('mousemove', onMove);
    return function cleanup() {
      window.removeEventListener('mousemove', onMove);
      el.classList.remove('is-tracking');
    };
  }

  var api = { buildFrostTexture: buildFrostTexture, attachFrostTracking: attachFrostTracking };

  // UMD-ish: CommonJS / ESM-interop / plain global.
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.Frost = api;

  // Auto-build the texture once on load (skip with window.FROST_NO_AUTOBUILD).
  if (typeof document !== 'undefined' && !global.FROST_NO_AUTOBUILD) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { buildFrostTexture(); });
    } else {
      buildFrostTexture();
    }
  }
})(typeof window !== 'undefined' ? window : this);
