/* =============================================================
   Solar Detection Console — พฤติกรรมของหน้าจอ + ดึงข้อมูลจาก app.py

   ข้อมูลทั้งหมดมาจาก API ใน app.py (/api/...) ซึ่งอ่าน/เขียนฐานข้อมูล
   solar_panel_pipeline อีกที ส่วนที่ยังไม่ได้ต่อของจริงคอมเมนต์ไว้ด้วย  // TODO:
   ============================================================= */
'use strict';

var $ = function (id) { return document.getElementById(id); };

var STEP_LABELS = {
  generating_config: 'Generate config file (.toml)',
  fetch_image: 'Fetch satellite imagery',
  run_inference: 'AI solar panel detection',
  parse_result: 'Parse results and save'
};
var STATE_BADGE = {
  completed: ['b-done', 'Completed'],
  running: ['b-run', 'Running'],
  failed: ['b-fail', 'Failed'],
  pending: ['b-wait', 'Queued']
};
var MAX_TILES = 100;
var POLL_MS = 5000;

var jobs = [];            // รายการงานล่าสุดจาก /api/jobs
var currentTid = null;    // งานที่เลือกอยู่
var aoi = null;           // [min_lat, min_lng, max_lat, max_lng]
var pollTimer = null;

/* ---------------------------------------------------- ตัวช่วย */
function esc(text) {
  var div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML;
}

function fmt(value, digits) {
  if (value == null) return '—';
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: digits || 0 });
}

function api(method, url, body) {
  return fetch(url, {
    method: method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  }).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (data) {
      if (!res.ok) {
        var err = new Error(data.error || ('Request failed (' + res.status + ')'));
        err.status = res.status;
        throw err;
      }
      return data;
    });
  });
}

/* ---------------------------------------------------- ข้อความแจ้งเตือน */
function toast(message, kind) {
  var el = document.createElement('div');
  el.className = 'toast ' + (kind || '');
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(function () {
    el.style.transition = '.3s';
    el.style.opacity = '0';
    setTimeout(function () { el.remove(); }, 300);
  }, 3000);
}

// 401 = ยังไม่ล็อกอิน → เปิดหน้าเข้าสู่ระบบ, อย่างอื่นแจ้งเป็น toast
function handleError(err) {
  if (err.status === 401) { showGate(); return; }
  toast(err.message, 'err');
}

/* ---------------------------------------------------- แท็บซ้าย */
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(function (tab) {
    tab.classList.toggle('on', tab.dataset.pane === name);
  });
  document.querySelectorAll('.pane').forEach(function (pane) {
    pane.classList.toggle('on', pane.id === 'pane_' + name);
  });
}
document.querySelectorAll('.tab').forEach(function (tab) {
  tab.onclick = function () { switchTab(tab.dataset.pane); };
});

/* ---------------------------------------------------- พื้นที่ที่เลือก */
function lngToTile(lng, z) { return Math.floor((lng + 180) / 360 * Math.pow(2, z)); }
function latToTile(lat, z) {
  var r = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z));
}
function tileCount(bbox, z) {
  var x = lngToTile(bbox[3], z) - lngToTile(bbox[1], z) + 1;
  var y = latToTile(bbox[0], z) - latToTile(bbox[2], z) + 1;
  return x * y;
}
function areaKm2(bbox) {
  var midLat = (bbox[0] + bbox[2]) / 2 * Math.PI / 180;
  return (bbox[2] - bbox[0]) * 110.574 * (bbox[3] - bbox[1]) * 111.32 * Math.cos(midLat);
}

function setAoi(bbox) {
  aoi = bbox;
  $('aoi_sw').textContent = bbox[0] + ', ' + bbox[1];
  $('aoi_ne').textContent = bbox[2] + ', ' + bbox[3];
  $('aoi_size').innerHTML = areaKm2(bbox).toFixed(3) + ' km&sup2;';
  updateTiles();
  showAoi(bbox, true);
}

function updateTiles() {
  if (!aoi) return;
  var n = tileCount(aoi, Number($('zoom').value));
  $('aoi_tiles').textContent = n + ' / ' + MAX_TILES;
  $('aoi_tiles').style.color = n > MAX_TILES ? 'var(--err)' : '';
}
$('zoom').onchange = updateTiles;

function chipBbox(chip) { return chip.dataset.bbox.split(',').map(Number); }

document.querySelectorAll('.chip').forEach(function (chip) {
  chip.onclick = function () {
    document.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('on'); });
    chip.classList.add('on');
    setAoi(chipBbox(chip));
    if (!$('title').value) $('title').placeholder = chip.textContent + ' rooftop survey';
  };
});

/* ---------------------------------------------------- แผนที่ (Leaflet) */
var PANEL_COLOR = '#facc15';
var MEASURE_COLOR = '#38bdf8';
var hasMap = !!window.L;     // โหลด Leaflet จาก CDN ไม่ได้ → หน้าเว็บยังใช้ได้ แค่ไม่มีแผนที่
var DOTS_BELOW_ZOOM = 18;   // ซูมต่ำกว่านี้แสดงแผงเป็นจุด
var map, baseLayer, aoiLayer, panelsLayer, dotsLayer;
var panelsTid = null;        // งานที่โหลดรูปแผงมาแสดงอยู่
var shownTid = null;         // งานที่แผนที่ซูมไปหาแล้ว (ซูมครั้งเดียวตอนเลือกงาน ไม่ซูมทุกครั้งที่ poll)

function bboxBounds(b) { return L.latLngBounds([b[0], b[1]], [b[2], b[3]]); }
function boundsToBbox(b) {
  var r = function (v) { return Math.round(v * 1e6) / 1e6; };
  return [r(b.getSouth()), r(b.getWest()), r(b.getNorth()), r(b.getEast())];
}

if (hasMap) {
  map = L.map('map', { maxZoom: 21 }).setView([13.75, 100.55], 6);

  // "Satellite" ใช้ภาพชุดเดียวกับที่ fetch_image ดึงไปให้โมเดล จะได้เทียบตำแหน่งกรอบที่ตรวจพบได้ตรง
  var google = function (lyrs) {
    return L.tileLayer('https://mt{s}.google.com/vt/lyrs=' + lyrs + '&x={x}&y={y}&z={z}', {
      subdomains: '0123', maxZoom: 21, attribution: 'Imagery &copy; Google'
    });
  };
  var baseLayers = {
    sat: google('s'),
    hybrid: google('y'),
    osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxNativeZoom: 19, maxZoom: 21, attribution: '&copy; OpenStreetMap contributors'
    })
  };
  baseLayer = baseLayers.sat.addTo(map);
  document.querySelectorAll('input[name=base]').forEach(function (radio) {
    radio.onchange = function () {
      map.removeLayer(baseLayer);
      baseLayer = baseLayers[radio.value].addTo(map);
    };
  });

  aoiLayer = L.rectangle([[0, 0], [0, 0]], {
    color: PANEL_COLOR, weight: 2, dashArray: '6 5', fill: false, interactive: false
  });
  panelsLayer = L.geoJSON(null, {
    style: panelStyle,
    onEachFeature: function (feature, layer) { layer.bindPopup(panelPopup(feature.properties)); }
  });
  // แผงหลังหนึ่งเล็กมากเมื่อมองทั้งพื้นที่ → ตอนซูมออกแสดงเป็นจุดแทน ซูมเข้ามาถึงจะเห็นรูปจริง
  dotsLayer = L.layerGroup();
  map.on('zoomend', syncPanelLayers);
  syncPanelLayers();
}

function syncPanelLayers() {
  if (!hasMap) return;
  var on = $('l_panels').checked;
  var dots = map.getZoom() < DOTS_BELOW_ZOOM;
  if (on && !dots) panelsLayer.addTo(map); else map.removeLayer(panelsLayer);
  if (on && dots) dotsLayer.addTo(map); else map.removeLayer(dotsLayer);
}

function buildDots() {
  dotsLayer.clearLayers();
  panelsLayer.eachLayer(function (layer) {
    L.circleMarker(layer.getBounds().getCenter(), {
      radius: 5, color: '#1a1400', weight: 1, fillColor: PANEL_COLOR, fillOpacity: 0.9
    }).on('click', function () { focusPanel(layer); }).addTo(dotsLayer);
  });
}

function focusPanel(layer) {
  map.fitBounds(layer.getBounds(), { padding: [80, 80], maxZoom: 20 });
  layer.openPopup();
}

function showAoi(bbox, fit) {
  if (!hasMap) return;
  aoiLayer.setBounds(bboxBounds(bbox));
  if ($('l_aoi').checked && !map.hasLayer(aoiLayer)) aoiLayer.addTo(map);
  if (fit) map.fitBounds(bboxBounds(bbox), { padding: [60, 60], maxZoom: 19 });
}

/* ---------- ชั้นข้อมูลแผงที่ตรวจพบ ---------- */
function panelStyle() {
  var op = Number($('l_op').value) / 100;
  return { color: PANEL_COLOR, weight: 1.5, opacity: op, fillColor: PANEL_COLOR, fillOpacity: op * 0.5 };
}

// คอลัมน์ใน shapefile ของอาจารย์: no_panel = จำนวนแผงโดยประมาณ, adjusted_a = พื้นที่ (m²) หลังปรับค่า
function panelPopup(p) {
  return '<b>' + fmt(p.no_panel, 1) + ' panels</b><br>' +
    'Area: ' + fmt(p.adjusted_a, 1) + ' m&sup2;<br>' +
    'Size class: ' + esc(p.size);
}

function loadPanels(job) {
  if (!hasMap || panelsTid === job.tid) return;
  panelsTid = job.tid;
  api('GET', '/api/jobs/' + job.tid + '/panels')
    .then(function (geojson) {
      if (panelsTid !== job.tid) return;          // เลือกงานอื่นไปแล้วระหว่างรอ
      panelsLayer.clearLayers();
      panelsLayer.addData(geojson);
      buildDots();
      renderDrawer();
    })
    .catch(function (err) {
      if (panelsTid !== job.tid) return;
      renderDrawer(err.status === 404 ? err.message : 'Could not load the result');
      if (err.status !== 404) handleError(err);
    });
}

function clearPanels() {
  if (!hasMap) return;
  panelsTid = null;
  panelsLayer.clearLayers();
  dotsLayer.clearLayers();
  renderDrawer();
}

$('l_panels').onchange = syncPanelLayers;
$('l_aoi').onchange = function () {
  if (!hasMap) return;
  if (this.checked && aoi) aoiLayer.addTo(map); else map.removeLayer(aoiLayer);
};

/* ---------- ลิ้นชักรายการแผงที่ตรวจพบ ---------- */
function renderDrawer(message) {
  var layers = hasMap ? panelsLayer.getLayers() : [];
  if (!layers.length) {
    $('drawer_body').innerHTML = '<div class="empty">' + esc(message || 'No detection results yet') + '</div>';
    return;
  }
  layers.sort(function (a, b) { return (b.feature.properties.no_panel || 0) - (a.feature.properties.no_panel || 0); });
  $('drawer_body').innerHTML = layers.map(function (layer, i) {
    var p = layer.feature.properties;
    return '<div class="det" data-id="' + L.stamp(layer) + '">' +
      '<div class="det-top"><span>#' + (i + 1) + '</span><b>' + fmt(p.no_panel, 1) + ' panels</b></div>' +
      '<div class="det-sub"><span>' + fmt(p.adjusted_a, 1) + ' m&sup2;</span><span>size ' + esc(p.size) + '</span></div>' +
    '</div>';
  }).join('');
}

$('drawer_body').onclick = function (event) {
  var row = event.target.closest('.det');
  if (!row) return;
  document.querySelectorAll('.det').forEach(function (d) { d.classList.toggle('on', d === row); });
  focusPanel(panelsLayer.getLayer(Number(row.dataset.id)));
};

function closeDrawer() { $('drawer').classList.remove('on'); }

function zoomToResult() {
  if (!hasMap) return;
  if (panelsLayer.getLayers().length) {
    map.fitBounds(panelsLayer.getBounds(), { padding: [60, 60], maxZoom: 20 });
    $('drawer').classList.add('on');
    return;
  }
  var job = currentTid && findJob(currentTid);
  if (job) map.fitBounds(bboxBounds(job.bbox), { padding: [60, 60] });
  toast(job ? 'This job has no detection result yet' : 'Select a finished job first', 'err');
}

/* ---------- เครื่องมือ: วาดพื้นที่ / วัดระยะ ---------- */
var activeTool = null;        // 'draw' | 'measure' | null
var drawStart = null, drawRect = null;
var measurePts = [], measureLine = null;

function setTool(name) {
  if (!hasMap) { toast('The map could not be loaded', 'err'); return; }
  activeTool = name;
  document.querySelectorAll('.tool').forEach(function (t) { t.classList.toggle('on', t.dataset.tool === name); });
  $('map').classList.toggle('drawing', !!name);

  // ตอนวาดกรอบ ต้องปิดการลากแผนที่ ไม่งั้นลากเมาส์แล้วแผนที่จะเลื่อนแทน
  if (name === 'draw') map.dragging.disable(); else map.dragging.enable();

  if (measureLine) { map.removeLayer(measureLine); measureLine = null; }
  measurePts = [];

  if (name === 'draw') showReadout('Drag a box over the area to scan');
  else if (name === 'measure') showReadout('Click points on the map to measure &mdash; Esc to stop');
  else $('readout').classList.remove('on');
}

document.querySelectorAll('.tool').forEach(function (btn) {
  btn.onclick = function () {
    if (btn.dataset.tool === 'fit') { zoomToResult(); return; }
    setTool(activeTool === btn.dataset.tool ? null : btn.dataset.tool);
  };
});

function showReadout(html) {
  $('readout').innerHTML = html;
  $('readout').classList.add('on');
}

function pathLength(points) {
  var total = 0;
  for (var i = 1; i < points.length; i++) total += map.distance(points[i - 1], points[i]);
  return total;
}
function fmtDistance(m) { return m < 1000 ? m.toFixed(1) + ' m' : (m / 1000).toFixed(2) + ' km'; }

if (hasMap) {
  map.on('mousedown', function (e) {
    if (activeTool !== 'draw') return;
    drawStart = e.latlng;
    drawRect = L.rectangle(L.latLngBounds(e.latlng, e.latlng), {
      color: PANEL_COLOR, weight: 2, dashArray: '6 5', fillOpacity: 0.08, interactive: false
    }).addTo(map);
  });

  map.on('mousemove', function (e) {
    if (activeTool === 'draw' && drawStart) {
      var bounds = L.latLngBounds(drawStart, e.latlng);
      drawRect.setBounds(bounds);
      var box = boundsToBbox(bounds);
      showReadout('Area <b>' + areaKm2(box).toFixed(3) + ' km&sup2;</b> &middot; ' +
        '<b>' + tileCount(box, Number($('zoom').value)) + '</b> / ' + MAX_TILES + ' tiles');
    } else if (activeTool === 'measure' && measurePts.length) {
      showReadout('Distance <b>' + fmtDistance(pathLength(measurePts.concat([e.latlng]))) + '</b> &mdash; Esc to stop');
    }
  });

  map.on('mouseup', function (e) {
    if (activeTool !== 'draw' || !drawStart) return;
    var bounds = L.latLngBounds(drawStart, e.latlng);
    map.removeLayer(drawRect);
    drawStart = drawRect = null;
    var box = boundsToBbox(bounds);
    if (box[0] === box[2] || box[1] === box[3]) { showReadout('Drag a box, not a single click'); return; }

    document.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('on'); });
    $('title').placeholder = 'e.g. My rooftop survey';
    setTool(null);
    setAoi(box);
    switchTab('new');
    toast('Area selected');
  });

  map.on('click', function (e) {
    if (activeTool !== 'measure') return;
    measurePts.push(e.latlng);
    if (!measureLine) measureLine = L.polyline([], { color: MEASURE_COLOR, weight: 3, dashArray: '5 5', interactive: false }).addTo(map);
    measureLine.setLatLngs(measurePts);
    showReadout('Distance <b>' + fmtDistance(pathLength(measurePts)) + '</b> &mdash; Esc to stop');
  });
}

/* ---------------------------------------------------- แถบเลื่อนความทึบ */
document.querySelectorAll('input[type=range][data-out]').forEach(function (slider) {
  slider.oninput = function () {
    $(slider.dataset.out).textContent = slider.value + '%';
    if (hasMap && slider.id === 'l_op') panelsLayer.setStyle(panelStyle());
  };
});

/* ---------------------------------------------------- รายการงาน */
function loadJobs() {
  return api('GET', '/api/jobs').then(function (data) {
    jobs = data.jobs;
    renderJobs();
    if (currentTid) {
      var job = findJob(currentTid);
      if (job) showJob(job); else clearJob();
    }
  });
}

function findJob(tid) {
  return jobs.filter(function (j) { return j.tid === tid; })[0];
}

function renderJobs() {
  var term = $('search').value.trim().toLowerCase();
  var shown = jobs.filter(function (j) { return (j.title || '').toLowerCase().indexOf(term) !== -1; });

  $('jobs_count').textContent = '(' + jobs.length + ')';
  $('jobs_empty').hidden = shown.length > 0;
  $('jobs_empty').innerHTML = jobs.length
    ? 'No job matches &ldquo;' + esc(term) + '&rdquo;'
    : 'No jobs yet<br>Start from the &ldquo;New job&rdquo; tab';

  $('job_list').innerHTML = shown.map(function (job) {
    var badge = STATE_BADGE[job.state];
    var r = job.result || {};
    return '' +
      '<div class="job' + (job.tid === currentTid ? ' on' : '') + '" data-tid="' + esc(job.tid) + '">' +
        '<div class="job-top">' +
          '<div class="job-name">' + esc(job.title || 'Untitled job') + '</div>' +
          '<div class="badge ' + badge[0] + '">' + badge[1] + '</div>' +
        '</div>' +
        '<div class="job-meta">' +
          '<div><b>' + fmt(r.panel_count) + '</b> panels</div>' +
          '<div><b>' + fmt(r.surface_area) + '</b> m&sup2;</div>' +
          '<div style="color:var(--muted-2)">' + esc(job.tid.slice(0, 8)) + '</div>' +
        '</div>' +
        '<div class="job-acts">' +
          '<button class="icon-btn" data-act="reuse">Reuse area</button>' +
          (job.state === 'failed' ? '<button class="icon-btn" data-act="rerun">Rerun</button>' : '') +
          '<button class="icon-btn danger" data-act="delete">Delete</button>' +
        '</div>' +
      '</div>';
  }).join('');
}

$('search').oninput = renderJobs;

$('job_list').onclick = function (event) {
  var card = event.target.closest('.job');
  if (!card) return;
  var job = findJob(card.dataset.tid);
  var act = event.target.dataset.act;

  if (act === 'reuse') {
    document.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('on'); });
    setAoi(job.bbox);
    switchTab('new');
    toast('Area copied from "' + job.title + '"');
  } else if (act === 'rerun') {
    rerunJob(job);
  } else if (act === 'delete') {
    deleteJob(job);
  } else {
    selectJob(job.tid);
  }
};

function selectJob(tid) {
  currentTid = tid;
  renderJobs();
  showJob(findJob(tid));
}

function clearJob() {
  currentTid = null;
  shownTid = null;
  stopPolling();
  $('pill_job').textContent = 'No job selected';
  renderStepper(null);
  renderStats(null);
  clearPanels();
}

function showJob(job) {
  $('pill_job').innerHTML = 'Current job: <b>' + esc(job.title) + '</b>';
  renderStepper(job);
  renderStats(job.result);
  // งานที่ยังไม่จบ → ถามสถานะใหม่เรื่อย ๆ
  if (job.state === 'pending' || job.state === 'running') startPolling(); else stopPolling();

  // แผนที่: ซูมไปที่พื้นที่ของงานครั้งเดียวตอนเลือก แล้วแสดงแผงที่ตรวจพบเมื่องานเสร็จ
  if (shownTid !== job.tid) {
    shownTid = job.tid;
    showAoi(job.bbox, true);
  }
  if (job.state === 'completed' && job.result) loadPanels(job);
  else if (panelsTid !== null) clearPanels();   // เปลี่ยนงาน หรือสั่งรันใหม่ → ล้างผลเก่าออก
}

function renderStepper(job) {
  $('rerun_row').hidden = !job || job.state !== 'failed';
  if (!job) {
    $('stepper').innerHTML = Object.keys(STEP_LABELS).map(function (name) {
      return '<div class="pstep"><div class="mk"></div><div>' + STEP_LABELS[name] + '</div></div>';
    }).join('');
    return;
  }

  $('stepper').innerHTML = job.steps.map(function (step, i) {
    var cls = { completed: 'done', running: 'active', failed: 'failed' }[step.status] || '';
    var mark = step.status === 'completed' ? '&#10003;' : step.status === 'failed' ? '!' : '';
    var retry = step.retry_count > 0
      ? ' <span style="color:var(--warn)">(retry ' + step.retry_count + ')</span>' : '';
    var time = step.seconds != null ? '<span class="step-time">' + step.seconds.toFixed(1) + ' s</span>' : '';
    var log = step.error_msg
      ? '<a class="log-link" href="#" data-step="' + i + '">log</a>' : '';
    return '<div class="pstep ' + cls + '"><div class="mk">' + mark + '</div>' +
      '<div>' + esc(STEP_LABELS[step.name] || step.name) + retry + time + '</div>' + log + '</div>';
  }).join('');
}

$('stepper').onclick = function (event) {
  var link = event.target.closest('.log-link');
  if (!link) return;
  event.preventDefault();
  var step = findJob(currentTid).steps[Number(link.dataset.step)];
  openLog(STEP_LABELS[step.name] || step.name, step.error_msg);
};

function renderStats(result) {
  var r = result || {};
  $('st_area').textContent = fmt(r.surface_area);
  $('st_panels').textContent = fmt(r.panel_count);
  $('st_kwp').textContent = fmt(r.power_generation, 2);
  $('st_mwh').textContent = '—';
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(function () {
    if (!currentTid) return stopPolling();
    var tid = currentTid;
    api('GET', '/api/jobs/' + tid).then(function (data) {
      jobs = jobs.map(function (j) { return j.tid === data.job.tid ? data.job : j; });
      renderJobs();
      // ผู้ใช้อาจเลือกงานอื่นไปแล้วระหว่างรอคำตอบ — อย่าเอางานเก่ามาทับหน้าจอ
      if (tid === currentTid) showJob(data.job);
    }).catch(function (err) {
      if (tid !== currentTid) return;
      stopPolling();
      if (err.status === 404) { loadJobs(); return; }
      handleError(err);
    });
  }, POLL_MS);
}
function stopPolling() { clearInterval(pollTimer); pollTimer = null; }

/* ---------------------------------------------------- สร้าง / สั่งซ้ำ / ลบงาน */
$('btn_run').onclick = function () {
  if (!aoi) { toast('Pick an area first', 'err'); return; }
  if (tileCount(aoi, Number($('zoom').value)) > MAX_TILES) {
    toast('Area too large for this zoom level - pick a smaller area or lower zoom', 'err');
    return;
  }
  var title = $('title').value.trim() || $('title').placeholder;
  var btn = $('btn_run');
  btn.disabled = true;

  // TODO: ตาราง task ยังไม่มีคอลัมน์ zoom — ถ้าระบบประมวลผลต้องใช้ ให้เพิ่มคอลัมน์แล้วส่ง $('zoom').value ไปด้วย
  api('POST', '/api/jobs', { title: title, bbox: aoi })
    .then(function (data) {
      jobs.unshift(data.job);
      $('title').value = '';
      selectJob(data.job.tid);
      toast('Job saved - waiting for the processing system to pick it up');
    })
    .catch(handleError)
    .then(function () { btn.disabled = false; });
};

$('btn_rerun').onclick = function () { rerunJob(findJob(currentTid)); };

function rerunJob(job) {
  api('POST', '/api/jobs/' + job.tid + '/rerun')
    .then(function (data) {
      jobs = jobs.map(function (j) { return j.tid === job.tid ? data.job : j; });
      selectJob(job.tid);
      toast('Job queued again');
    })
    .catch(handleError);
}

function deleteJob(job) {
  if (!confirm('Delete job "' + job.title + '"? This cannot be undone.')) return;
  api('DELETE', '/api/jobs/' + job.tid)
    .then(function () {
      jobs = jobs.filter(function (j) { return j.tid !== job.tid; });
      if (currentTid === job.tid) clearJob();
      renderJobs();
      toast('Job deleted');
    })
    .catch(handleError);
}

/* ---------------------------------------------------- หน้าต่าง log */
function openLog(title, text) {
  $('log_title').textContent = 'Log — ' + title;
  $('log_body').textContent = text || 'No log to show.';
  $('logbox').classList.add('on');
}
function closeLog() { $('logbox').classList.remove('on'); }

/* ---------------------------------------------------- หน้าเข้าสู่ระบบ */
var gateMode = 'login';     // 'login' | 'register'

function showGate() { $('gate').classList.add('on'); $('gate_email').focus(); }
function hideGate() { $('gate').classList.remove('on'); }

function toggleGateMode() {
  gateMode = (gateMode === 'login') ? 'register' : 'login';
  var isRegister = (gateMode === 'register');

  $('gate_name_row').style.display = isRegister ? '' : 'none';
  $('gate_sub').textContent = isRegister
    ? 'Create a new account. Jobs you create are visible only to this account.'
    : 'Sign in to view and create your detection jobs';
  $('gate_submit').textContent = isRegister ? 'Create account' : 'Sign in';
  $('gate_switch_text').textContent = isRegister ? 'Already have an account?' : 'No account yet?';
  $('gate_switch_btn').textContent = isRegister ? 'Sign in' : 'Create one';
  $('gate_password').autocomplete = isRegister ? 'new-password' : 'current-password';
  $('gate_err').classList.remove('on');
}

function submitGate() {
  var body = { email: $('gate_email').value, password: $('gate_password').value };
  if (gateMode === 'register') body.name = $('gate_name').value;

  $('gate_submit').disabled = true;
  api('POST', gateMode === 'register' ? '/api/register' : '/api/login', body)
    .then(function (data) {
      $('gate_password').value = '';
      $('gate_err').classList.remove('on');
      signedIn(data.user);
    })
    .catch(function (err) {
      $('gate_err').textContent = err.message;
      $('gate_err').classList.add('on');
    })
    .then(function () { $('gate_submit').disabled = false; });
}

function signedIn(user) {
  $('user_name').textContent = user.name;
  hideGate();
  loadJobs().catch(handleError);
}

function signOut() {
  api('POST', '/api/logout').catch(function () {}).then(function () {
    jobs = [];
    clearJob();
    renderJobs();
    $('user_name').textContent = '—';
    showGate();
  });
}

/* ---------------------------------------------------- คีย์ลัด */
document.addEventListener('keydown', function (event) {
  if (event.key !== 'Escape') return;
  closeLog();
  if (activeTool) setTool(null);
});

/* ---------------------------------------------------- เริ่มต้น */
renderStepper(null);
setAoi(chipBbox(document.querySelector('.chip.on')));

if (location.protocol === 'file:') {
  toast('Open this page through "python app.py" at http://localhost:5000 to load data', 'err');
} else {
  api('GET', '/api/me')
    .then(function (data) { signedIn(data.user); })
    .catch(function (err) {
      if (err.status === 401) showGate(); else toast(err.message, 'err');
    });
}
