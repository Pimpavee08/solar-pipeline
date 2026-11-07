from datetime import datetime
from airflow.sdk import dag, task
from generating_config import generating_config_file
from fetch_image import fetch_image_file
from run_inference import run_inference_file
from parse_result import parse_result_file

@dag(
    dag_id="solar_pipeline",
    start_date=datetime(2026, 1, 1),
    # Every minute: each task only picks up rows in `task` waiting for its step,
    # so a run with nothing to do finishes in a few seconds.
    # One run at a time, so a long inference never overlaps the next run.
    schedule="* * * * *",
    max_active_runs=1,
    catchup=False,
    is_paused_upon_creation=False,
    tags=['solar', 'config_file_generator'],
)
def solar_pipeline():

    @task(task_id="generating_config")
    def generate_config_files():
        generating_config_file()

    @task(task_id="fetch_image")
    def fetch_image_files():
        fetch_image_file()

    @task(task_id="run_inference", pool="advisor_gpu")
    def run_inference_files():
        run_inference_file()

    @task(task_id="parse_result")
    def parse_result_files():
        parse_result_file()

    generate_config_files() >> fetch_image_files() >> run_inference_files() >> parse_result_files()

solar_pipeline()