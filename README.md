# solar-pipeline

Airflow + MySQL (Docker) สำหรับตรวจจับแผงโซลาร์จากภาพดาวเทียม
รันบนเครื่องอาจารย์ (Ubuntu) แล้วสั่งคอนเทนเนอร์ `solar` ของอาจารย์ผ่าน Docker socket ของเครื่อง

## ขั้นตอนใน DAG `solar_pipeline`

| ขั้น | ไฟล์ | ทำอะไร |
|---|---|---|
| `generating_config` | `dags/generating_config.py` | สร้าง `config_<tid>.toml` จาก `dags/templates/template.toml` |
| `fetch_image` | `dags/fetch_image.py` | ดาวน์โหลดภาพจาก XYZ tile แล้วเขียน GeoTIFF ลง `data/inference/<tid>/input/` |
| `run_inference` | `dags/run_inference.py` | สั่ง `docker compose run solar 5 -f ...` ของอาจารย์ โดยชี้ `DATA_PATH` มาที่ `data/` ของ repo นี้ |
| `parse_result` | `dags/parse_result.py` | อ่าน `*-corrected.shp`, เขียน GeoJSON, บันทึกพื้นที่และจำนวนแผงลง `task_result` |

โปรแกรมของอาจารย์อ่านและเขียนเฉพาะใน `data/` ของ repo นี้ ไม่แตะ `solar-data/` ของอาจารย์

## ติดตั้งบนเครื่องอาจารย์

1. `git clone` repo นี้ แล้ว `mkdir -p data toml_config_files`
2. `cp .env.example .env` แล้วใส่ค่า
   - `AIRFLOW_UID` = `id -u`
   - เปิดบรรทัดส่วนเครื่องอาจารย์: `COMPOSE_FILE`, `DOCKER_GID` (`getent group docker | cut -d: -f3`), `ADVISOR_PROJECT_DIR`, `HOST_DATA_DIR` (path เต็มของ `data/`)
3. `docker compose up -d --build` แล้วเปิด http://localhost:8080 (เปิดได้จากในเครื่องเท่านั้น)
4. ใน Airflow UI
   - เปลี่ยนรหัส admin จากค่าเริ่มต้น `airflow`
   - Admin → Connections: `solar_mysql` (MySQL)
   - Admin → Pools: `advisor_gpu` 1 slot
5. รัน DAG `test_advisor_docker` เพื่อเช็กว่า Airflow สั่ง Docker และเห็นโปรเจกต์ของอาจารย์ได้

ต้องรัน `./run.sh` ของอาจารย์มาก่อนอย่างน้อยครั้งหนึ่ง เพื่อให้ image `solar` ถูก build ไว้แล้ว
