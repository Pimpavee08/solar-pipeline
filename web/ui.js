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
  // TODO: เลื่อนแผนที่ไปยังพื้นที่นี้ เมื่อใส่แผนที่แล้ว
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

/* ---------------------------------------------------- เครื่องมือบนแผนที่ */
document.querySelectorAll('.tool').forEach(function (tool) {
  tool.onclick = function () {
    var isOn = tool.classList.contains('on');
    document.querySelectorAll('.tool').forEach(function (t) { t.classList.remove('on'); });

    if (tool.dataset.tool === 'fit') {
      $('drawer').classList.toggle('on');
      return;
    }

    if (isOn) {                       // กดซ้ำ = ปิดโหมด
      $('readout').classList.remove('on');
      return;
    }
    tool.classList.add('on');

    // TODO: ต่อกับเครื่องมือวาด/วัดระยะของแผนที่ที่คุณเลือกใช้
    if (tool.dataset.tool === 'draw') {
      showReadout('Drag a box on the map <b>(not wired up yet)</b>');
    } else {
      showReadout('Click the map to start measuring <b>(not wired up yet)</b>');
    }
  };
});

function showReadout(html) {
  $('readout').innerHTML = html;
  $('readout').classList.add('on');
}

/* ---------------------------------------------------- แถบเลื่อนความทึบ */
document.querySelectorAll('input[type=range][data-out]').forEach(function (slider) {
  slider.oninput = function () {
    $(slider.dataset.out).textContent = slider.value + '%';
    // TODO: ส่งค่านี้ไปปรับความทึบของชั้นข้อมูลบนแผนที่
  };
});

/* ---------------------------------------------------- ลิ้นชักผลลัพธ์ */
function closeDrawer() { $('drawer').classList.remove('on'); }

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
  stopPolling();
  $('pill_job').textContent = 'No job selected';
  renderStepper(null);
  renderStats(null);
}

function showJob(job) {
  $('pill_job').innerHTML = 'Current job: <b>' + esc(job.title) + '</b>';
  renderStepper(job);
  renderStats(job.result);
  // งานที่ยังไม่จบ → ถามสถานะใหม่เรื่อย ๆ
  if (job.state === 'pending' || job.state === 'running') startPolling(); else stopPolling();
  // TODO: ซูมแผนที่ไปที่ job.bbox และแสดง overlay / shapefile ของงานนี้
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
  $('readout').classList.remove('on');
  document.querySelectorAll('.tool').forEach(function (t) { t.classList.remove('on'); });
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
