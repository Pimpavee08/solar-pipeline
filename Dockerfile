FROM apache/airflow:3.3.2
# Docker CLI + compose plugin, so run_inference can start the advisor's solar container
# through the host's /var/run/docker.sock (see docker-compose.advisor.yml)
COPY --from=docker:27.5.1-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:27.5.1-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY requirements.txt /requirements.txt
RUN pip install --no-cache-dir -r /requirements.txt
