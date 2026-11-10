FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app.py index.html styles.css ui.js ./

# Run as a normal user, not root
RUN useradd --create-home web
USER web

# gunicorn instead of `python app.py`: no Flask debug console in the container
# --timeout 300: a download with the satellite image can take longer than the default 30 s
EXPOSE 5000
CMD ["gunicorn", "--bind", "0.0.0.0:5000", "--workers", "2", "--timeout", "300", "app:app"]
