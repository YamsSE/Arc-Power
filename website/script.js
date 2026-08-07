/* Arc Power — site interactions (vanilla, no deps) */

(function () {
  'use strict';

  var easeOutCubic = function (t) { return 1 - Math.pow(1 - t, 3); };
  var fmt = function (el, v) {
    var dec = parseInt(el.dataset.decimals || '0', 10);
    return v.toFixed(dec);
  };

  /* ---- nav border on scroll ---- */
  var nav = document.getElementById('nav');
  window.addEventListener('scroll', function () {
    nav.classList.toggle('scrolled', window.scrollY > 8);
  }, { passive: true });

  /* ---- hero card: random GPU per load ---- */
  var HERO_GPUS = [
    { name: 'Arc A770',     family: 'Alchemist',  core: 2390, mem: 2187, temp: 62, fan: 1462, fps: 118, plMin: 105, plMax: 252, ext: 315 },
    { name: 'Arc A750',     family: 'Alchemist',  core: 2050, mem: 2000, temp: 61, fan: 1415, fps: 101, plMin: 90,  plMax: 225, ext: 315 },
    { name: 'Arc A580',     family: 'Alchemist',  core: 1700, mem: 2000, temp: 59, fan: 1305, fps: 92,  plMin: 90,  plMax: 185, ext: 315 },
    { name: 'Arc B580',     family: 'Battlemage', core: 2670, mem: 2375, temp: 64, fan: 1510, fps: 124, plMin: 100, plMax: 190, ext: null },
    { name: 'Arc B570',     family: 'Battlemage', core: 2500, mem: 2375, temp: 60, fan: 1340, fps: 109, plMin: 80,  plMax: 150, ext: null },
    { name: 'Arc Pro B50',  family: 'Battlemage', core: 2600, mem: 1750, temp: 55, fan: 980,  fps: 74,  plMin: 40,  plMax: 70,  ext: null },
    { name: 'Arc Pro B60',  family: 'Battlemage', core: 2400, mem: 2375, temp: 61, fan: 1330, fps: 108, plMin: 120, plMax: 200, ext: null }
  ];

  var heroCard = document.querySelector('.hero-card');
  var heroGpu = null;
  var heroPlMax = null;
  var heroDraw = 0;
  if (heroCard && HERO_GPUS.length) {
    heroGpu = HERO_GPUS[Math.floor(Math.random() * HERO_GPUS.length)];
    heroPlMax = heroGpu.plMax;
    // Random current draw anywhere in [30, plMax] — the whole range, no
    // fixed per-card number.
    heroDraw = Math.round(30 + Math.random() * (heroPlMax - 30));
    var setRole = function (role, val) {
      var el = heroCard.querySelector('[data-role="' + role + '"]');
      if (el) el.dataset.target = String(val);
    };
    var title = heroCard.querySelector('.card-title');
    var sub = heroCard.querySelector('.card-sub');
    if (title) title.textContent = 'Intel ' + heroGpu.name;
    if (sub) sub.textContent = 'GPU 0 \u00B7 ' + heroGpu.family;
    setRole('core', heroGpu.core);
    setRole('mem', heroGpu.mem);
    setRole('temp', heroGpu.temp);
    setRole('fan', heroGpu.fan);
    setRole('fps', heroGpu.fps);
    setRole('power', heroDraw);
    setRole('pl', heroPlMax);
    var pMin = document.getElementById('powerMin');
    var pMax = document.getElementById('powerMax');
    var pExt = document.getElementById('powerExt');
    if (pMin) pMin.textContent = String(heroGpu.plMin);
    if (pMax) pMax.textContent = String(heroGpu.plMax);
    if (pExt) {
      if (heroGpu.ext) { pExt.textContent = heroGpu.ext + ' W extended'; pExt.style.display = ''; }
      else { pExt.style.display = 'none'; }
    }
  }

  /* ---- hero card: power bar tracks the live wattage ---- */
  var powerFill = document.getElementById('powerFill');
  if (powerFill && heroPlMax) {
    powerFill.style.width = Math.max(Math.round(heroDraw / heroPlMax * 100), 2) + '%';
  }

  /* ---- hero readouts: steady live wobble ---- */
  var heroVals = Array.prototype.map.call(
    document.querySelectorAll('.hero-card .js-anim'),
    function (el) {
      var t = parseFloat(el.dataset.target);
      return { el: el, target: t, value: t };
    }
  );

  function wobble() {
    var now = Date.now();
    heroVals.forEach(function (o) {
      // Power: a random walk across the WHOLE [30, plMax] range; the bar
      // below always mirrors the displayed wattage.
      if (o.el.dataset.role === 'power' && heroPlMax) {
        var span = heroPlMax - 30;
        o.value += (Math.random() * 2 - 1) * span * 0.18;
        if (o.value < 30) o.value = 30;
        if (o.value > heroPlMax) o.value = heroPlMax;
        o.el.textContent = fmt(o.el, o.value);
        if (powerFill) powerFill.style.width = Math.round(o.value / heroPlMax * 100) + '%';
        return;
      }
      var drift = Math.sin(now / 1200 + o.target) * 1.5;
      var jitter = (Math.random() * 2 - 1) * 0.8;
      var floor = parseFloat(o.el.dataset.min || '0');
      var v = o.target + drift + jitter;
      if (v < floor) v = floor;
      o.el.textContent = fmt(o.el, v);
    });
  }
  if (heroVals.length) {
    heroVals.forEach(function (o) { o.el.textContent = fmt(o.el, o.target); });
    wobble();
    setInterval(wobble, 900);
  }

  /* ---- reveal + stat count-up on scroll ---- */
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      var el = entry.target;
      if (el.classList.contains('reveal')) el.classList.add('visible');
      if (el.classList.contains('js-count') && !el._done) {
        el._done = true;
        var target = parseFloat(el.dataset.target);
        var t0 = performance.now();
        var dur = 1200;
        (function tick(now) {
          var p = Math.min((now - t0) / dur, 1);
          el.textContent = Math.round(easeOutCubic(p) * target);
          if (p < 1) requestAnimationFrame(tick);
        })(performance.now());
      }
      io.unobserve(el);
    });
  }, { threshold: 0.25 });

  Array.prototype.forEach.call(
    document.querySelectorAll('.reveal, .js-count'),
    function (el) { io.observe(el); }
  );
})();
