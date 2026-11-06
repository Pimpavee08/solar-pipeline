from airflow.sdk import dag
from airflow.providers.standard.operators.bash import BashOperator

# ทดสอบว่า Airflow สั่ง Docker ของเครื่องอาจารย์ได้ และเห็นโปรเจกต์ของอาจารย์ (ไม่รันโมเดล)
@dag(
    dag_id="test_advisor_docker",
    schedule=None,
)
def test_advisor_docker():

    BashOperator(
        task_id="check_docker",
        bash_command=(
            "docker version | grep -A2 Server && "
            "docker compose -f \"$ADVISOR_PROJECT_DIR/dist/docker-compose.yml\" config --services && "
            "docker images | grep -E 'dist-(solar|mlflow)' && "
            "ls \"$ADVISOR_PROJECT_DIR/config\" && echo \"HOST_DATA_DIR=$HOST_DATA_DIR\""
        ),
    )

test_advisor_docker()
