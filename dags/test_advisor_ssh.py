from airflow.sdk import dag
from airflow.providers.ssh.operators.ssh import SSHOperator

# ทดสอบว่า Airflow ต่อ SSH ไปเครื่องอาจารย์ได้ (ต้องสร้าง Connection ชื่อ advisor_ssh ก่อน)
@dag(
    dag_id="test_advisor_ssh",
    schedule=None,
)
def test_advisor_ssh():

    SSHOperator(
        task_id="check_remote",
        ssh_conn_id="advisor_ssh",
        command="hostname && whoami && (nvidia-smi || echo 'no nvidia-smi')",
        cmd_timeout=60,
    )

test_advisor_ssh()
