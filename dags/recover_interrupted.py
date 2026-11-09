from airflow.providers.mysql.hooks.mysql import MySqlHook

# Marks steps left at 'running' by a run that stopped part-way (Airflow restarted, machine
# rebooted, ...) as failed, so the normal retry picks them up again (NFR-03).
#
# This is safe only because solar_pipeline has max_active_runs=1: when a new run starts,
# no step can really be running, so any 'running' row is left over from a run that is gone.
# Do not remove max_active_runs=1 from the DAG.

INTERRUPTED_MSG = "Interrupted: the pipeline stopped while this step was running"


def recover_interrupted_tasks():
    mysql_hook = MySqlHook(mysql_conn_id='solar_mysql')
    connection = mysql_hook.get_conn()
    cursor = connection.cursor()

    try:
        # task.status is '<step>:running' → '<step>:failed'
        n_tasks = cursor.execute(
            """
            UPDATE task
            SET status = CONCAT(SUBSTRING_INDEX(status, ':', 1), ':failed')
            WHERE RIGHT(status, 8) = ':running';
            """
        )
        n_steps = cursor.execute(
            """
            UPDATE task_step
            SET status = 'failed', error_msg = %s, completed_at = CURRENT_TIMESTAMP
            WHERE status = 'running';
            """,
            (INTERRUPTED_MSG,),
        )
        connection.commit()
        print(f"Marked {n_tasks} interrupted task(s) and {n_steps} step(s) as failed.")

    except Exception:
        connection.rollback()
        raise
    finally:
        cursor.close()
        connection.close()
