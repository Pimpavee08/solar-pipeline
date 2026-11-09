#!/bin/sh
# Force one step of a job into failed or running, to test the retry (bug 3) and
# interrupted-run recovery (bug 5) without waiting for a real failure.
#   bash scripts/sim_step.sh <first 8 chars of tid> <step> <failed|running>
# e.g. bash scripts/sim_step.sh 1a1af0ae parse_result failed
# Pause the solar_pipeline DAG first if you want to look at the state before it is retried.
set -eu

usage() { echo "usage: $0 <tid (8 hex chars)> <generating_config|fetch_image|run_inference|parse_result> <failed|running>" >&2; exit 2; }
[ $# -eq 3 ] || usage
tid="$1"; step="$2"; state="$3"

# Every argument is checked against a fixed pattern before it goes into SQL
echo "$tid" | grep -Eqx '[0-9a-f]{8}' || usage
case "$step" in generating_config|fetch_image|run_inference|parse_result) ;; *) usage ;; esac
case "$state" in failed|running) ;; *) usage ;; esac

if [ "$state" = failed ]; then msg="'Simulated failure (scripts/sim_step.sh)'"; else msg="NULL"; fi

docker exec -i solar-mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -t "$MYSQL_DATABASE"' <<SQL
SET @n = (SELECT COUNT(*) FROM task WHERE tid LIKE '$tid%');
SELECT IF(@n = 1, 'ok', CONCAT('ERROR: ', @n, ' jobs match $tid, nothing changed')) AS result;
UPDATE task_step SET status = '$state', error_msg = $msg, completed_at = NULL
  WHERE @n = 1 AND tid LIKE '$tid%' AND step_name = '$step';
UPDATE task SET status = '$step:$state'
  WHERE @n = 1 AND tid LIKE '$tid%';
SELECT LEFT(t.tid, 8) AS tid, t.status AS job_status, s.step_name, s.status AS step_status, s.retry_count AS retries
  FROM task t JOIN task_step s ON s.tid = t.tid
  WHERE t.tid LIKE '$tid%' AND s.step_name = '$step';
SQL
