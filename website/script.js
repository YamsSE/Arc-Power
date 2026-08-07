/* Arc Power - site interactions (vanilla, no deps) */

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
    { name: 'Arc A770',     family: 'Alchemist',  core: 2390, mem: 2187, temp: 62, fan: 1462, fps: 118, plMax: 252, ext: 315 },
    { name: 'Arc A750',     family: 'Alchemist',  core: 2050, mem: 2000, temp: 61, fan: 1415, fps: 101, plMax: 225, ext: 315 },
    { name: 'Arc A580',     family: 'Alchemist',  core: 1700, mem: 2000, temp: 59, fan: 1305, fps: 92,  plMax: 185, ext: 315 },
    { name: 'Arc B580',     family: 'Battlemage', core: 2670, mem: 2375, temp: 64, fan: 1510, fps: 124, plMax: 190, ext: null },
    { name: 'Arc B570',     family: 'Battlemage', core: 2500, mem: 2375, temp: 60, fan: 1340, fps: 109, plMax: 150, ext: null },
    { name: 'Arc Pro B50',  family: 'Battlemage', core: 2600, mem: 1750, temp: 55, fan: 980,  fps: 74,  plMax: 70,  ext: null },
    { name: 'Arc Pro B60',  family: 'Battlemage', core: 2400, mem: 2375, temp: 61, fan: 1330, fps: 108, plMax: 200, ext: null }
  ];

  var heroCard = document.querySelector('.hero-card');
  var heroGpu = null;
  var heroLimit = null; // bar + scale max: extended max on Alchemist, else the card's own max
  var heroDraw = 0;     // current power draw (fake telemetry)
  var heroPL = 0;       // SET power limit: jumps randomly in 100 W+ steps
  if (heroCard && HERO_GPUS.length) {
    heroGpu = HERO_GPUS[Math.floor(Math.random() * HERO_GPUS.length)];
    heroLimit = heroGpu.ext || heroGpu.plMax;
    heroPL = Math.round(30 + Math.random() * (heroLimit - 30));
    // Current draw starts below the set limit and can never exceed it.
    heroDraw = Math.round(30 + Math.random() * (heroPL - 30));
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
    setRole('pl', heroPL);
    var pMin = document.getElementById('powerMin');
    var pMax = document.getElementById('powerMax');
    if (pMin) pMin.textContent = '0';
    if (pMax) pMax.textContent = String(heroGpu.plMax);
    var pExt = document.getElementById('powerExt');
    if (pExt) {
      if (heroGpu.ext) { pExt.textContent = heroGpu.ext + ' W extended'; pExt.style.display = ''; }
      else { pExt.style.display = 'none'; }
    }
  }

  /* ---- hero card: power bar + set-limit marker (0 to the card max) ---- */
  var powerFill = document.getElementById('powerFill');
  var powerMarker = document.getElementById('powerMarker');
  var powerMetaVal = heroCard ? heroCard.querySelector('[data-role="pl"]') : null;

  // The SET power limit re-rolls at random in jumps of 100 W+ (as far as the
  // card's range allows); the red divider marks it and the telemetry never
  // climbs above it.
  function rollPowerLimit() {
    if (!heroLimit) return;
    var next;
    var tries = 0;
    do {
      next = Math.round(30 + Math.random() * (heroLimit - 30));
      tries += 1;
    } while (Math.abs(next - heroPL) < 100 && tries < 12);
    heroPL = next;
    if (powerMetaVal) powerMetaVal.textContent = String(heroPL);
    if (powerMarker) {
      var pct = Math.round(heroPL / heroLimit * 100);
      powerMarker.style.left = Math.max(Math.min(pct, 99), 1) + '%';
    }
  }

  if (powerFill && heroLimit) {
    powerFill.style.width = Math.max(Math.round(heroDraw / heroLimit * 100), 2) + '%';
  }
  rollPowerLimit();
  setInterval(rollPowerLimit, 4500);

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
      // Power: the draw wanders below the SET power limit, never above it.
      if (o.el.dataset.role === 'power' && heroLimit) {
        var span = heroPL - 30;
        o.value += (Math.random() * 2 - 1) * span * 0.18;
        if (o.value < 30) o.value = 30;
        if (o.value > heroPL) o.value = heroPL;
        o.el.textContent = fmt(o.el, o.value);
        if (powerFill) powerFill.style.width = Math.round(o.value / heroLimit * 100) + '%';
        return;
      }
      if (o.el.dataset.role === 'pl') return; // the set limit updates on its own re-roll
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
