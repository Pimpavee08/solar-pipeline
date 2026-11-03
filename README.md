# solar-pipeline

Airflow + MySQL (Docker) สำหรับตรวจจับแผงโซลาร์จากภาพดาวเทียม
โมเดล AI อยู่บนเครื่องอาจารย์ (Ubuntu) และ Airflow สั่งงานผ่าน SSH/SFTP

## ขั้นตอนใน DAG `solar_pipeline`

| ขั้น | ไฟล์ | ทำอะไร |
|---|---|---|
| `generating_config` | `dags/generating_config.py` | สร้าง `config_<tid>.toml` จาก `dags/templates/template.toml` |
| `fetch_image` | `dags/fetch_image.py` | ดาวน์โหลดภาพจาก XYZ tile แล้วเขียน GeoTIFF ลง `input/` |
| `run_inference` | `dags/run_inference.py` | อัปโหลด config + `input/` ไปเครื่องอาจารย์, รัน `run.sh`, ดึง `output/` กลับมา |
| `parse_result` | `dags/parse_result.py` | อ่าน `*-corrected.shp`, เขียน GeoJSON, บันทึกพื้นที่และจำนวนแผงลง `task_result` |

## เริ่มใช้

1. `cp .env.example .env` แล้วใส่ค่าให้ครบ
2. สร้าง SSH key ไว้นอก repo แล้วชี้ `SSH_KEY_DIR` ไปที่โฟลเดอร์นั้น
   `ssh-keygen -t ed25519 -N "" -C solar-airflow -f C:/Users/<you>/.ssh/solar-airflow/id_ed25519`
3. `docker compose up -d --build` แล้วเปิด http://localhost:8080
4. ใน Airflow UI
   - Admin → Connections: `solar_mysql` (MySQL) และ `advisor_ssh` (SSH, Extra `{"key_file": "/opt/airflow/ssh/id_ed25519"}`)
   - Admin → Variables: `advisor_project_dir` (โฟลเดอร์ที่มี `run.sh`), `advisor_run_mode` (ค่าเริ่มต้น `5`), `advisor_cleanup` (`true` = ลบไฟล์ job บนเครื่องอาจารย์หลังดึงผล)
   - Admin → Pools: `advisor_gpu` 1 slot
5. รัน DAG `test_advisor_ssh` เพื่อเช็กว่าต่อเครื่องอาจารย์ได้
