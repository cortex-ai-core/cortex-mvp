# Cortéx parser: Docling on CPU behind a tiny FastAPI endpoint.
# Models are downloaded at build time so the container starts offline.

FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DOCLING_ARTIFACTS_PATH=/models \
    OMP_NUM_THREADS=4 \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1

# tesseract is the fallback OCR engine; libgl/glib are needed by opencv (EasyOCR).
# LibreOffice renders Word/PowerPoint/Excel to PDF for the in-browser viewer (/render).
RUN apt-get update && apt-get install -y --no-install-recommends \
      tesseract-ocr tesseract-ocr-eng libtesseract-dev \
      libgl1 libglib2.0-0 curl \
      libreoffice-writer libreoffice-calc libreoffice-impress \
      fonts-liberation fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU-only torch first so docling's dependency resolution doesn't pull CUDA wheels
COPY requirements.txt .
RUN pip install --extra-index-url https://download.pytorch.org/whl/cpu torch torchvision \
    && pip install -r requirements.txt

# Bake the layout, table, and OCR models into the image
RUN HF_HUB_OFFLINE=0 TRANSFORMERS_OFFLINE=0 docling-tools models download -o /models \
    && python -c "import easyocr; easyocr.Reader(['en'], gpu=False, model_storage_directory='/models/EasyOcr', download_enabled=True)"

ENV EASYOCR_MODULE_PATH=/models/EasyOcr

COPY app.py .

EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD curl -fsS http://localhost:8090/health || exit 1

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8090", "--workers", "1", "--timeout-keep-alive", "120"]
