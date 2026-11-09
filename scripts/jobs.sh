#!/bin/sh
# Show the latest jobs with the status and retry count of every step.
#   bash scripts/jobs.sh        → last 3 jobs
#   bash scripts/jobs.sh 10     → last 10 jobs
# The MySQL password comes from the solar-mysql container's own environment.
set -eu

n="${1:-3}"
case "$n" in
  ''|*[!0-9]*) echo "usage: $0 [number of jobs]" >&2; exit 2 ;;
esac

docker exec -i solar-mysql sh -c 'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot -t "$MYSQL_DATABASE"' <<SQL
SELECT LEFT(t.tid, 8) AS tid, LEFT(t.title, 28) AS title, t.status AS job_status,
       s.step_name, s.status AS step_status, s.retry_count AS retries,
       LEFT(s.error_msg, 40) AS error
FROM (SELECT tid FROM task ORDER BY created_at DESC LIMIT $n) latest
JOIN task t ON t.tid = latest.tid
JOIN task_step s ON s.tid = t.tid
ORDER BY t.created_at DESC,
         FIELD(s.step_name, 'generating_config', 'fetch_image', 'run_inference', 'parse_result');
SQL
