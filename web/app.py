"""
Solar Detection Console — ตัวเชื่อมระหว่างหน้าเว็บกับฐานข้อมูล MySQL

รัน:   python app.py      แล้วเปิด http://localhost:5000
ตั้งค่าการเชื่อมต่อใน .env (ดูตัวอย่างใน .env.example)

ไฟล์นี้ทำ 2 อย่าง
  1. เสิร์ฟหน้าเว็บ (index.html, styles.css, ui.js)
  2. เปิด API ใต้ /api/... ให้ ui.js เรียกอ่าน/เขียนฐานข้อมูล solar_panel_pipeline
"""
import hmac
import os
import secrets
import uuid
from functools import wraps
from pathlib import Path

import pymysql
from dotenv import load_dotenv
from flask import Flask, abort, jsonify, request, send_from_directory, session
from werkzeug.security import check_password_hash, generate_password_hash

ROOT = Path(__file__).resolve().parent
load_dotenv(ROOT / '.env')

app = Flask(__name__, static_folder=None)
app.secret_key = os.getenv('SECRET_KEY') or secrets.token_hex(32)

# ขั้นตอนของงานตามลำดับ — ชื่อต้องตรงกับ task_step.step_name ในฐานข้อมูล
STEPS = ['generating_config', 'fetch_image', 'run_inference', 'parse_result']

# ไฟล์หน้าเว็บที่อนุญาตให้เปิดได้ (ห้ามเสิร์ฟทั้งโฟลเดอร์ เพราะมี .env อยู่ด้วย)
PUBLIC_FILES = {'index.html', 'styles.css', 'ui.js'}

# โฟลเดอร์ผลลัพธ์ของ Airflow (data/ ของ repo) — ในคอนเทนเนอร์เว็บ mount ไว้ที่ path เดียวกับฝั่ง Airflow
# task_result.shapefile_path จึงชี้ไฟล์ได้ตรง ๆ ส่วนไฟล์นอกโฟลเดอร์นี้จะไม่ถูกส่งออกไปเด็ดขาด
RESULTS_DIR = Path(os.getenv('RESULTS_DIR', '/opt/airflow/data')).resolve()

# พลังงานที่ผลิตได้ จากเปเปอร์ของอาจารย์ (Sullivan & Witayangkurn, IEEE Access 2025, สมการ 2)
#   kWh ต่อวัน = kWp x ชั่วโมงแดดต่อวัน x ประสิทธิภาพ   (ไทย: แดดเฉลี่ย 5 ชม./วัน, ประสิทธิภาพ 0.75)
# kWp (task_result.power_generation) คำนวณใน dags/parse_result.py จากพื้นที่แผง x 211.73 W/m²
SUN_HOURS_PER_DAY = 5
EFFICIENCY = 0.75


def annual_mwh(kwp):
    if kwp is None:
        return None
    return round(float(kwp) * SUN_HOURS_PER_DAY * EFFICIENCY * 365 / 1000, 2)


# ---------------------------------------------------------------- ฐานข้อมูล
def db():
    return pymysql.connect(
        host=os.getenv('DB_HOST', '127.0.0.1'),
        port=int(os.getenv('DB_PORT', '3306')),
        user=os.getenv('DB_USER', 'root'),
        password=os.getenv('DB_PASSWORD', ''),
        database=os.getenv('DB_NAME', 'solar_panel_pipeline'),
        charset='utf8mb4',
        cursorclass=pymysql.cursors.DictCursor,
        autocommit=False,
    )


def query(sql, args=None, one=False):
    with db() as conn, conn.cursor() as cur:
        cur.execute(sql, args)
        return cur.fetchone() if one else cur.fetchall()


def iso(value):
    return value.isoformat(sep=' ') if value else None


# ---------------------------------------------------------------- สถานะงาน
def job_state(steps):
    """สรุปสถานะงานจากสถานะของแต่ละขั้น: completed / failed / running / pending"""
    states = [s['status'] for s in steps]
    if not states:
        return 'pending'
    if 'failed' in states:
        return 'failed'
    if all(s == 'completed' for s in states):
        return 'completed'
    if any(s in ('running', 'completed') for s in states):
        return 'running'
    return 'pending'


def step_json(row):
    seconds = None
    if row['started_at'] and row['completed_at']:
        seconds = round((row['completed_at'] - row['started_at']).total_seconds(), 1)
    return {
        'name': row['step_name'],
        'status': row['status'],
        'retry_count': row['retry_count'],
        'error_msg': row['error_msg'],
        'seconds': seconds,
    }


def load_jobs(uid, tid=None):
    where, args = 't.uid = %s', [uid]
    if tid:
        where += ' AND t.tid = %s'
        args.append(tid)

    tasks = query(f"""
        SELECT t.*, r.surface_area, r.power_generation, r.panel_count,
               r.overlay_image_path, r.shapefile_path
        FROM task t
        LEFT JOIN task_result r ON r.tid = t.tid
        WHERE {where}
        ORDER BY t.created_at DESC
    """, args)
    if not tasks:
        return []

    tids = [t['tid'] for t in tasks]
    marks = ','.join(['%s'] * len(tids))
    steps = {}
    for row in query(f'SELECT * FROM task_step WHERE tid IN ({marks})', tids):
        steps.setdefault(row['tid'], []).append(row)

    jobs = []
    for t in tasks:
        rows = sorted(steps.get(t['tid'], []),
                      key=lambda s: STEPS.index(s['step_name']) if s['step_name'] in STEPS else 99)
        jobs.append({
            'tid': t['tid'],
            'title': t['title'],
            'status': t['status'],
            'state': job_state(rows),
            'bbox': [t['bbox_min_lat'], t['bbox_min_lng'], t['bbox_max_lat'], t['bbox_max_lng']],
            'created_at': iso(t['created_at']),
            'updated_at': iso(t['updated_at']),
            'steps': [step_json(s) for s in rows],
            'result': None if t['panel_count'] is None and t['surface_area'] is None else {
                'surface_area': t['surface_area'],
                'power_generation': t['power_generation'],
                'annual_mwh': annual_mwh(t['power_generation']),
                'panel_count': t['panel_count'],
                'overlay_image_path': t['overlay_image_path'],
                'shapefile_path': t['shapefile_path'],
            },
        })
    return jobs


# ---------------------------------------------------------------- ล็อกอิน
def login_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if 'uid' not in session:
            return jsonify(error='Please sign in'), 401
        return view(*args, **kwargs)
    return wrapper


def password_ok(stored, given):
    # ผู้ใช้เก่าในไฟล์ .sql เก็บรหัสเป็นข้อความธรรมดา ผู้ใช้ใหม่เก็บเป็น hash
    if stored.startswith(('scrypt:', 'pbkdf2:')):
        return check_password_hash(stored, given)
    return hmac.compare_digest(stored.encode(), given.encode())


def user_json(row):
    return {'uid': row['uid'], 'name': row['name'], 'email': row['email']}


@app.post('/api/register')
def register():
    data = request.get_json(silent=True) or {}
    name = (data.get('name') or '').strip()
    email = (data.get('email') or '').strip().lower()
    password = data.get('password') or ''
    if not name or not email or len(password) < 6:
        return jsonify(error='Name, email and a password of at least 6 characters are required'), 400

    if query('SELECT uid FROM user WHERE email = %s', [email], one=True):
        return jsonify(error='This email is already registered'), 409

    uid = str(uuid.uuid4())
    with db() as conn, conn.cursor() as cur:
        cur.execute('INSERT INTO user (uid, passwd, name, email) VALUES (%s, %s, %s, %s)',
                    [uid, generate_password_hash(password), name, email])
        conn.commit()

    session['uid'] = uid
    return jsonify(user={'uid': uid, 'name': name, 'email': email})


@app.post('/api/login')
def login():
    data = request.get_json(silent=True) or {}
    email = (data.get('email') or '').strip().lower()
    password = data.get('password') or ''

    row = query('SELECT * FROM user WHERE email = %s', [email], one=True)
    if not row or not password_ok(row['passwd'], password):
        return jsonify(error='Wrong email or password'), 401

    # รหัสแบบข้อความธรรมดา → เปลี่ยนเป็น hash ทันทีที่ล็อกอินสำเร็จ
    if not row['passwd'].startswith(('scrypt:', 'pbkdf2:')):
        with db() as conn, conn.cursor() as cur:
            cur.execute('UPDATE user SET passwd = %s WHERE uid = %s',
                        [generate_password_hash(password), row['uid']])
            conn.commit()

    session['uid'] = row['uid']
    return jsonify(user=user_json(row))


@app.post('/api/logout')
def logout():
    session.clear()
    return jsonify(ok=True)


@app.get('/api/me')
@login_required
def me():
    row = query('SELECT * FROM user WHERE uid = %s', [session['uid']], one=True)
    if not row:
        session.clear()
        return jsonify(error='Please sign in'), 401
    return jsonify(user=user_json(row))


# ---------------------------------------------------------------- งาน
@app.get('/api/jobs')
@login_required
def list_jobs():
    return jsonify(jobs=load_jobs(session['uid']))


@app.get('/api/jobs/<tid>')
@login_required
def get_job(tid):
    jobs = load_jobs(session['uid'], tid)
    if not jobs:
        return jsonify(error='Job not found'), 404
    return jsonify(job=jobs[0])


@app.get('/api/jobs/<tid>/panels')
@login_required
def job_panels(tid):
    """รูปหลายเหลี่ยมแผงโซลาร์ที่ตรวจพบ (GeoJSON, lat/lng) ที่ parse_result เขียนไว้ข้างไฟล์ shapefile"""
    row = query("""
        SELECT r.shapefile_path FROM task t JOIN task_result r ON r.tid = t.tid
        WHERE t.tid = %s AND t.uid = %s
    """, [tid, session['uid']], one=True)
    if not row or not row['shapefile_path']:
        return jsonify(error='No detection result for this job yet'), 404

    geojson = Path(row['shapefile_path']).with_suffix('.geojson').resolve()
    if RESULTS_DIR not in geojson.parents or not geojson.is_file():
        return jsonify(error='Result file not found'), 404
    return send_from_directory(geojson.parent, geojson.name, mimetype='application/geo+json')


@app.post('/api/jobs')
@login_required
def create_job():
    data = request.get_json(silent=True) or {}
    title = (data.get('title') or '').strip()[:255] or 'Untitled job'
    try:
        min_lat, min_lng, max_lat, max_lng = [float(v) for v in data.get('bbox', [])]
    except (TypeError, ValueError):
        return jsonify(error='bbox must be [min_lat, min_lng, max_lat, max_lng]'), 400
    if not (-90 <= min_lat < max_lat <= 90 and -180 <= min_lng < max_lng <= 180):
        return jsonify(error='Invalid area'), 400

    tid = str(uuid.uuid4())
    with db() as conn, conn.cursor() as cur:
        cur.execute("""
            INSERT INTO task (tid, uid, title, status, bbox_min_lat, bbox_min_lng, bbox_max_lat, bbox_max_lng)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        """, [tid, session['uid'], title, f'{STEPS[0]}:pending', min_lat, min_lng, max_lat, max_lng])
        cur.executemany(
            "INSERT INTO task_step (sid, tid, step_name, status) VALUES (%s, %s, %s, 'pending')",
            [(str(uuid.uuid4()), tid, name) for name in STEPS])
        conn.commit()

    # TODO: สั่งให้ระบบประมวลผลจริงเริ่มทำงานกับ tid นี้ (ตอนนี้แค่บันทึกงานไว้ในฐานข้อมูล)
    return jsonify(job=load_jobs(session['uid'], tid)[0]), 201


@app.post('/api/jobs/<tid>/rerun')
@login_required
def rerun_job(tid):
    with db() as conn, conn.cursor() as cur:
        if not cur.execute('SELECT tid FROM task WHERE tid = %s AND uid = %s', [tid, session['uid']]):
            return jsonify(error='Job not found'), 404
        cur.execute("""
            UPDATE task_step SET status = 'pending', retry_count = 0, error_msg = NULL,
                                 started_at = CURRENT_TIMESTAMP, completed_at = NULL
            WHERE tid = %s
        """, [tid])
        cur.execute('DELETE FROM task_result WHERE tid = %s', [tid])
        cur.execute('UPDATE task SET status = %s WHERE tid = %s', [f'{STEPS[0]}:pending', tid])
        conn.commit()
    return jsonify(job=load_jobs(session['uid'], tid)[0])


@app.delete('/api/jobs/<tid>')
@login_required
def delete_job(tid):
    with db() as conn, conn.cursor() as cur:
        # task_step และ task_result ถูกลบตามอัตโนมัติ (ON DELETE CASCADE)
        deleted = cur.execute('DELETE FROM task WHERE tid = %s AND uid = %s', [tid, session['uid']])
        conn.commit()
    if not deleted:
        return jsonify(error='Job not found'), 404
    return jsonify(ok=True)


# ---------------------------------------------------------------- หน้าเว็บ
@app.get('/')
def index():
    return send_from_directory(ROOT, 'index.html')


@app.get('/<path:name>')
def public_file(name):
    if name not in PUBLIC_FILES:
        abort(404)
    return send_from_directory(ROOT, name)


@app.errorhandler(pymysql.err.OperationalError)
def db_down(err):
    return jsonify(error=f'Cannot reach the database: {err.args[-1]}'), 503


if __name__ == '__main__':
    app.run(host='127.0.0.1', port=int(os.getenv('PORT', '5000')), debug=True)
