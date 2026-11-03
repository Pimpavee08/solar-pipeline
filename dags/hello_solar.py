from airflow.sdk import dag, task

@dag(
    dag_id="hello_solar"
)
def hello_solar():

    @task
    def say_hello():
        print("Hello from Airflow! DAG folder is working.")
        return "ok"

    @task
    def say_done(result):
        print(f"Previous task returned: {result}")

    first = say_hello()
    second = say_done(first)

    first >> second

hello_solar()