import os
from airflow.providers.mysql.hooks.mysql import MySqlHook

def generating_config_file():

    mysql_hook = MySqlHook(mysql_conn_id='solar_mysql')
    connection = None

    try:
        # connect to MySQL database and get cursor
        connection = mysql_hook.get_conn()
        cursor = connection.cursor()

        # 1. Fetch tasks waiting for config file generation
        # Scan for tasks with "generating_config:pending" statuses
        fetch_query = """
            SELECT tid, title
            FROM task
            WHERE status = 'generating_config:pending';
        """
        cursor.execute(fetch_query)
        pending_tasks = cursor.fetchall()

        # Scan for tasks with "generating_config:failed" statuses
        fetch_query = """
            SELECT tid, title
            FROM task
            WHERE status = 'generating_config:failed';
        """
        cursor.execute(fetch_query)
        failed_tasks = cursor.fetchall()

        # If there are no tasks, the function stops working

        if not (pending_tasks or failed_tasks):
            print("No tasks currently waiting for config files generation.")
            return

        # Otherwise, the function keeps working
        template_path = '/opt/airflow/dags/templates/template.toml'
        config_output_dir = '/opt/airflow/toml_config_files/'

        # Ensure config files directory exists
        os.makedirs(config_output_dir, exist_ok=True)

        # Read the config file template content
        if not os.path.exists(template_path):
            raise FileNotFoundError(f"Template configuration file '{template_path}' not found.")

        with open(template_path, 'r') as file:
            template_content = file.read()

        # 2. Generate config files for waiting tasks
        # 2.1 Generating config files for pending tasks
        if pending_tasks:
            for task in pending_tasks:
                tid = task['tid']
                title = task['title']
                print(f"Processing task ID: {tid}")
                print(f"Processing task Title: {title}")

                try:
                    # Update status to running for Task and Task_Step
                    update_running_step = """
                        UPDATE task_step
                        SET status = 'running', started_at = CURRENT_TIMESTAMP
                        WHERE tid = %s AND step_name = 'generating_config';
                    """
                    cursor.execute(update_running_step, (tid,))

                    update_running_task = """
                        UPDATE task
                        SET status = 'generating_config:running'
                        WHERE tid = %s;
                    """
                    cursor.execute(update_running_task, (tid,))

                    # Generating config file according to the template
                    customized_config = template_content.replace(
                        "inference_path = 'data/inference/'",
                        f"inference_path = '/opt/airflow/data/inference/{tid}/'"
                    ).replace(
                        "job_name = 'job_google_full'",
                        f"job_name = '{title}'"
                    )

                    # Save generated config file
                    output_file_path = os.path.join(config_output_dir, f"config_{tid}.toml")

                    with open(output_file_path, 'w') as out_file:
                        out_file.write(customized_config)

                    print(f"Generated config file at: {output_file_path}")

                    # Update status to completed for Task_Step and pending for the next task
                    update_completed_step = """
                        UPDATE task_step
                        SET status = 'completed', completed_at = CURRENT_TIMESTAMP
                        WHERE tid = %s AND step_name = 'generating_config';
                    """
                    cursor.execute(update_completed_step, (tid,))

                    update_completed_task = """
                        UPDATE task
                        SET status = 'fetch_image:pending'
                        WHERE tid = %s;
                    """
                    cursor.execute(update_completed_task, (tid,))

                    # Commit changes to the database
                    connection.commit()
                    print(f"Task ID {tid} status updated to 'fetch_image:pending'.\n")

                except Exception as task_err:
                    # If failed, throw away the draft
                    connection.rollback()
                    # Show error message
                    error_message = str(task_err)
                    print(f"Failed to generate config file for task ID {tid}: {error_message}.")

                    # Update task step
                    fail_step_sql = """
                        UPDATE task_step
                        SET status = 'failed', error_msg = %s, completed_at = CURRENT_TIMESTAMP
                        WHERE tid = %s AND step_name = 'generating_config';
                    """
                    cursor.execute(fail_step_sql, (error_message, tid))

                    # Update task status
                    fail_task_sql = """
                        UPDATE task
                        SET status = 'generating_config:failed'
                        WHERE tid = %s;
                    """
                    cursor.execute(fail_task_sql, (tid,))

                    # Commit changes to the database
                    connection.commit()
                    print(f"Task ID {tid} status updated to 'generating_config:failed'.\n")

        # 2.2 Generating config files for failed tasks
        if failed_tasks:
            for task in failed_tasks:
                tid = task['tid']
                title = task['title']
                print(f"Verifying retriability of Task ID: {tid}")
                print(f"Verifying retriability of Task Title: {title}")

                # Check if retry count has reached 5
                retry_count_sql = """
                    SELECT retry_count
                    FROM task_step
                    WHERE tid = %s AND step_name = 'generating_config';
                """
                cursor.execute(retry_count_sql, (tid,))
                retry_num = cursor.fetchone()

                if retry_num and retry_num['retry_count'] >= 5:
                    continue

                print(f"Retrying Task ID: {tid}")
                print(f"Retrying Task Title: {title}")

                # Increment the number of retry count by 1
                update_retry_sql = """
                    UPDATE task_step
                    SET retry_count = retry_count + 1
                    WHERE tid = %s AND step_name = 'generating_config';
                """
                cursor.execute(update_retry_sql, (tid,))
                connection.commit()

                try:
                    # Update status to running for Task and Task_Step
                    update_running_step = """
                        UPDATE task_step
                        SET status = 'running', started_at = CURRENT_TIMESTAMP
                        WHERE tid = %s AND step_name = 'generating_config';
                    """
                    cursor.execute(update_running_step, (tid,))

                    update_running_task = """
                        UPDATE task
                        SET status = 'generating_config:running'
                        WHERE tid = %s;
                    """
                    cursor.execute(update_running_task, (tid,))

                    # Generating config file according to the template
                    customized_config = template_content.replace(
                        "inference_path = 'data/inference/'",
                        f"inference_path = '/opt/airflow/data/inference/{tid}/'"
                    ).replace(
                        "job_name = 'job_google_full'",
                        f"job_name = '{title}'"
                    )

                    # Save generated config file
                    output_file_path = os.path.join(config_output_dir, f"config_{tid}.toml")

                    with open(output_file_path, 'w') as out_file:
                        out_file.write(customized_config)

                    print(f"Generated config file at: {output_file_path}")

                    # Update status to completed for Task_Step and pending for the next task
                    update_completed_step = """
                        UPDATE task_step
                        SET status = 'completed', completed_at = CURRENT_TIMESTAMP, error_msg = NULL
                        WHERE tid = %s AND step_name = 'generating_config';
                    """
                    cursor.execute(update_completed_step, (tid,))

                    update_completed_task = """
                        UPDATE task
                        SET status = 'fetch_image:pending'
                        WHERE tid = %s;
                    """
                    cursor.execute(update_completed_task, (tid,))

                    # Commit changes to the database
                    connection.commit()
                    print(f"Task ID {tid} status updated to 'fetch_image:pending'.\n")

                except Exception as task_err:
                    # If failed, throw away the draft
                    connection.rollback()
                    # Show the error message
                    error_message = str(task_err)
                    print(f"Failed to retry for Task ID {tid}: {error_message}")

                    # Update task step
                    fail_step_sql = """
                        UPDATE task_step
                        SET status = 'failed', error_msg = %s, completed_at = CURRENT_TIMESTAMP
                        WHERE tid = %s AND step_name = 'generating_config';
                    """
                    cursor.execute(fail_step_sql, (error_message, tid))

                    # Update task status
                    fail_task_sql = """
                        UPDATE task
                        SET status = 'generating_config:failed'
                        WHERE tid = %s;
                    """
                    cursor.execute(fail_task_sql, (tid,))

                    # Commit changes to the database
                    connection.commit()
                    print(f"Task ID {tid} status updated to 'generating_config:failed'.\n")

        cursor.close()
        connection.close()

    except Exception as ex:
        if connection:
            connection.rollback()
        print(f"Execution error: {ex}")
        raise
        