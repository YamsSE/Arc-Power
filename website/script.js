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

  /* ---- hero card: power bar fill ---- */
  var powerFill = document.getElementById('powerFill');
  if (powerFill) {
    setTimeout(function () { powerFill.style.width = '88%'; }, 350);
  }

  /* ---- hero readouts: steady live wobble ---- */
  var heroVals = Array.prototype.map.call(
    document.querySelectorAll('.hero-card .js-anim'),
    function (el) {
      return { el: el, target: parseFloat(el.dataset.target), base: parseFloat(el.dataset.target) };
    }
  );

  function wobble() {
    var now = Date.now();
    heroVals.forEach(function (o) {
      var drift = Math.sin(now / 1200 + o.target) * 1.5;
      var jitter = (Math.random() * 2 - 1) * 0.8;
      var v = o.target + drift + jitter;
      if (o.target === 118 && v < 62) v = 62;
      if (v < 0) v = 0;
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
