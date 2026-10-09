/*
 * wind-drift.js
 * "Release" / "Regather" wind drift for CollectionBuilder Leaflet maps.
 *
 * Release  – pins leave their clusters and drift with the wind.
 * Regather – pins glide back to their original locations and re-cluster.
 *
 * Wind: current 10 m winds from Open-Meteo (free, no API key), sampled on a
 * grid around the pins and interpolated at each pin's position, so pins in
 * different places drift in different directions. If the live request fails
 * (offline, rate-limited), it falls back to the global prevailing-wind belts
 * (trade winds, westerlies, polar easterlies).
 *
 * Usage (inside the map script, after the map and markers exist):
 *   initWindDrift(map, mapFeatures, markers, { speedFactor: 2 });
 * Pins move at a fixed ground speed (like real smoke), so they look slow when
 * zoomed out and fast when zoomed in. See speedFactor and timeLapse below.
 * Pass null instead of `markers` if clustering is turned off.
 */
(function (global) {
  'use strict';

  var DEFAULTS = {
    // Multiple of real smoke-drift speed. Smoke is carried at roughly wind speed.
    speedFactor: 2,
    // Seconds of real drift shown per second on screen. Fixed, independent of zoom.
    //   1    = true real time (motion only visible at street-level zoom)
    //   3600 = one hour of drift per second
    timeLapse: 3600,
    // 'live' = Open-Meteo current winds; 'prevailing' = climatological wind belts only.
    windSource: 'live',
    gridSize: 6,          // live wind sampled on a gridSize x gridSize grid
    refreshMinutes: 30,   // re-fetch live winds after this long
    regatherMs: 1500,     // duration of the glide home
    position: 'topleft'   // Leaflet control corner
  };

  var M_PER_DEG = 111320; // metres per degree of latitude

  /* ---------- wind helpers ---------- */

  // Meteorological direction = where the wind blows FROM. Returns u (east), v (north) in m/s.
  function fromDirection(speed, fromDeg) {
    var r = fromDeg * Math.PI / 180;
    return { u: -speed * Math.sin(r), v: -speed * Math.cos(r) };
  }

  // Global prevailing-wind belts (typical surface speeds).
  function prevailingWind(lat) {
    var a = Math.abs(lat), north = lat >= 0;
    if (a < 30) return fromDirection(6, north ? 45 : 135);   // trade winds (NE / SE)
    if (a < 60) return fromDirection(8, north ? 225 : 315);  // westerlies (SW / NW)
    return fromDirection(4, north ? 45 : 135);               // polar easterlies
  }

  function wrapLng(lng) { return ((lng + 540) % 360) - 180; }

  function expand(bounds) {
    var b = bounds.pad(0.5), c = b.getCenter();
    var halfLat = Math.max((b.getNorth() - b.getSouth()) / 2, 2);
    var halfLng = Math.max((b.getEast() - b.getWest()) / 2, 2);
    return L.latLngBounds(
      [Math.max(c.lat - halfLat, -85), c.lng - halfLng],
      [Math.min(c.lat + halfLat, 85), c.lng + halfLng]
    );
  }

  function WindField(opts) {
    this.opts = opts;
    this.points = [];
    this.bounds = null;
    this.fetchedAt = 0;
    this.failedAt = 0;
    this.loading = null;
  }

  WindField.prototype.isLive = function () { return this.points.length > 0; };

  // Make sure live wind covers `bounds`. Always resolves (never rejects).
  WindField.prototype.ensure = function (bounds) {
    var self = this;
    if (self.opts.windSource !== 'live' || typeof fetch !== 'function') return Promise.resolve();
    var fresh = Date.now() - self.fetchedAt < self.opts.refreshMinutes * 60000;
    if (fresh && self.bounds && self.bounds.contains(bounds)) return Promise.resolve();
    if (self.loading) return self.loading;
    if (Date.now() - self.failedAt < 60000) return Promise.resolve();

    var b = expand(bounds), n = Math.max(2, self.opts.gridSize);
    var s = b.getSouth(), w = b.getWest(), nn = b.getNorth(), e = b.getEast();
    var pts = [], lats = [], lngs = [];
    for (var i = 0; i < n; i++) {
      for (var j = 0; j < n; j++) {
        var lat = s + (nn - s) * i / (n - 1);
        var lng = w + (e - w) * j / (n - 1);
        pts.push({ lat: lat, lng: lng });
        lats.push(lat.toFixed(3));
        lngs.push(wrapLng(lng).toFixed(3));
      }
    }
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lats.join(',') +
      '&longitude=' + lngs.join(',') +
      '&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms';

    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 8000) : null;

    self.loading = fetch(url, ctrl ? { signal: ctrl.signal } : {})
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        var arr = Array.isArray(data) ? data : [data];
        var good = [];
        pts.forEach(function (p, k) {
          var c = arr[k] && arr[k].current;
          if (!c || c.wind_speed_10m == null || c.wind_direction_10m == null) return;
          var v = fromDirection(c.wind_speed_10m, c.wind_direction_10m);
          p.u = v.u; p.v = v.v;
          good.push(p);
        });
        if (!good.length) throw new Error('no wind values returned');
        self.points = good;
        self.bounds = b;
        self.fetchedAt = Date.now();
      })
      .catch(function (err) {
        self.failedAt = Date.now();
        if (window.console) console.warn('Wind drift: live wind unavailable, using prevailing winds.', err);
      })
      .then(function () {
        if (timer) clearTimeout(timer);
        self.loading = null;
      });
    return self.loading;
  };

  // Inverse-distance-weighted wind at a point.
  WindField.prototype.sample = function (lat, lng) {
    var pts = this.points;
    if (!pts.length) return prevailingWind(lat);
    var cosLat = Math.cos(lat * Math.PI / 180), su = 0, sv = 0, sw = 0;
    for (var i = 0; i < pts.length; i++) {
      var p = pts[i];
      var dLat = p.lat - lat;
      var dLng = wrapLng(p.lng - lng) * cosLat;
      var d2 = dLat * dLat + dLng * dLng;
      if (d2 < 1e-8) return p;
      var wt = 1 / d2;
      su += wt * p.u; sv += wt * p.v; sw += wt;
    }
    return { u: su / sw, v: sv / sw };
  };

  /* ---------- styles ---------- */

  function injectStyles() {
    if (document.getElementById('wind-drift-styles')) return;
    var css =
      '.wind-drift-control{background:#fff;padding:4px;display:flex;flex-direction:column;gap:4px;min-width:96px}' +
      '.wind-drift-control button{font:600 13px/1.2 system-ui,sans-serif;padding:6px 10px;border:1px solid #bbb;' +
      'border-radius:4px;background:#f8f9fa;color:#222;cursor:pointer}' +
      '.wind-drift-control button:hover:not(:disabled){background:#e2e6ea}' +
      '.wind-drift-control button:focus-visible{outline:2px solid #0d6efd;outline-offset:1px}' +
      '.wind-drift-control button:disabled{opacity:.45;cursor:default}' +
      '.wind-drift-control .wd-status{font:11px/1.3 system-ui,sans-serif;color:#555;max-width:140px}' +
      '.wind-drift-control .wd-status:empty{display:none}';
    var el = document.createElement('style');
    el.id = 'wind-drift-styles';
    el.textContent = css;
    document.head.appendChild(el);
  }

  function describeSpeed(opts, timeLapse) {
    var t = Math.round(timeLapse), lapse;
    if (t <= 1) return opts.speedFactor + '\u00d7 real smoke speed';
    if (t < 120) lapse = t + ' s';
    else if (t < 7200) lapse = Math.round(t / 60) + ' min';
    else lapse = Math.round(t / 360) / 10 + ' h';
    return opts.speedFactor + '\u00d7 smoke speed \u00b7 1 s = ' + lapse;
  }

  /* ---------- main ---------- */

  function initWindDrift(map, featureLayer, clusterGroup, userOpts) {
    if (!map || !featureLayer || typeof L === 'undefined') return null;
    var opts = L.extend({}, DEFAULTS, userOpts || {});
    var wind = new WindField(opts);
    var markers = featureLayer.getLayers().filter(function (l) { return typeof l.getLatLng === 'function'; });
    if (!markers.length) return null;

    var home = new Map();
    markers.forEach(function (m) { home.set(m, m.getLatLng()); });

    var state = 'home'; // 'home' | 'drifting' | 'returning'
    var rafId = null, lastT = null, lastCheck = 0, driftLayer = null, attributed = false;
    var btnRelease, btnRegather, statusEl;
    var lapse = Math.max(0, Number(opts.timeLapse) || 1); // fixed: same ground speed at every zoom

    injectStyles();

    var control = L.control({ position: opts.position });
    control.onAdd = function () {
      var div = L.DomUtil.create('div', 'leaflet-bar wind-drift-control');
      div.innerHTML =
        '<button type="button" class="wd-release" title="Let the pins drift with the wind">Release</button>' +
        '<button type="button" class="wd-regather" title="Return pins to their original locations" disabled>Regather</button>' +
        '<div class="wd-status" aria-live="polite"></div>';
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      btnRelease = div.querySelector('.wd-release');
      btnRegather = div.querySelector('.wd-regather');
      statusEl = div.querySelector('.wd-status');
      btnRelease.addEventListener('click', release);
      btnRegather.addEventListener('click', regather);
      return div;
    };
    control.addTo(map);

    function setButtons() {
      btnRelease.disabled = state !== 'home';
      btnRegather.disabled = state !== 'drifting';
    }

    function setStatus(text) { statusEl.textContent = text; }

    function updateStatus() {
      if (state !== 'drifting') return;
      var src = wind.isLive() ? 'Live winds' : 'Prevailing winds';
      setStatus(src + ' \u00b7 ' + describeSpeed(opts, lapse));
      if (wind.isLive() && !attributed && map.attributionControl) {
        map.attributionControl.addAttribution('Wind: <a href="https://open-meteo.com/">Open-Meteo</a>');
        attributed = true;
      }
    }

    function currentBounds() {
      return L.latLngBounds(markers.map(function (m) { return m.getLatLng(); }));
    }

    function step(t) {
      if (state !== 'drifting') return;
      if (lastT === null) lastT = t;
      var dt = Math.min((t - lastT) / 1000, 0.1); // cap so a background tab doesn't cause a jump
      lastT = t;
      var simSeconds = dt * lapse * opts.speedFactor;

      for (var i = 0; i < markers.length; i++) {
        var m = markers[i], p = m.getLatLng();
        var w = wind.sample(p.lat, p.lng);
        var cos = Math.max(Math.cos(p.lat * Math.PI / 180), 0.01);
        var lat = p.lat + (w.v * simSeconds) / M_PER_DEG;
        var lng = p.lng + (w.u * simSeconds) / (M_PER_DEG * cos);
        m.setLatLng([Math.max(-85, Math.min(85, lat)), lng]);
      }

      // Every few seconds, make sure the wind grid still covers the pins.
      if (t - lastCheck > 5000) {
        lastCheck = t;
        wind.ensure(currentBounds()).then(updateStatus);
      }
      rafId = requestAnimationFrame(step);
    }

    function release() {
      if (state !== 'home') return;
      map.closePopup();
      if (clusterGroup) {
        if (clusterGroup.unspiderfy) clusterGroup.unspiderfy();
        clusterGroup.clearLayers();               // take pins out of their clusters
        driftLayer = L.layerGroup(markers).addTo(map);
      }
      state = 'drifting';
      setButtons();
      setStatus('Reading the wind\u2026');
      wind.ensure(currentBounds()).then(function () {
        if (state !== 'drifting') return;
        updateStatus();
        lastT = null;
        lastCheck = performance.now();
        rafId = requestAnimationFrame(step);
      });
    }

    function regather() {
      if (state !== 'drifting') return;
      state = 'returning';
      if (rafId) cancelAnimationFrame(rafId);
      setButtons();
      setStatus('Regathering\u2026');

      var from = new Map();
      markers.forEach(function (m) { from.set(m, m.getLatLng()); });
      var start = null, dur = Math.max(1, opts.regatherMs);

      function tween(t) {
        if (start === null) start = t;
        var k = Math.min((t - start) / dur, 1);
        var e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; // ease in-out
        markers.forEach(function (m) {
          var a = from.get(m), b = home.get(m);
          m.setLatLng([a.lat + (b.lat - a.lat) * e, a.lng + (b.lng - a.lng) * e]);
        });
        if (k < 1) rafId = requestAnimationFrame(tween);
        else finish();
      }
      rafId = requestAnimationFrame(tween);
    }

    function finish() {
      markers.forEach(function (m) { m.setLatLng(home.get(m)); });
      if (clusterGroup) {
        if (driftLayer) map.removeLayer(driftLayer);
        driftLayer = null;
        clusterGroup.addLayers(markers);          // back into clusters
      }
      rafId = null;
      state = 'home';
      setButtons();
      setStatus('');
    }

    return { release: release, regather: regather, control: control };
  }

  global.initWindDrift = initWindDrift;
})(window);
