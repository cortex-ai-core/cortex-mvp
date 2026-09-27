# Cortéx decision sidecar: Kev (https://github.com/jaredpalmer/kev), the
# open System One model, served on port 8009 with the same /v1/systemone
# API as TypeSafe's Jev. Needs an NVIDIA GPU (Kev-4B: ~10 GB).
#
# Mirrors Kev's own Modal image: Python 3.13, the locked serve extras,
# and the Gated DeltaNet kernels the Qwen3.5 backbones need on CUDA.
FROM python:3.13-slim

RUN apt-get update && apt-get install -y --no-install-recommends git curl \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir uv

ARG KEV_COMMIT=9c41005b2180347c3c646dfc9e50c4428483ec6b
WORKDIR /opt/kev
RUN git clone https://github.com/jaredpalmer/kev.git . && git checkout ${KEV_COMMIT}

ENV UV_PROJECT_ENVIRONMENT=/opt/venv UV_LINK_MODE=copy
RUN uv sync --frozen --extra serve --no-dev
ENV PATH="/opt/venv/bin:${PATH}"
RUN uv pip install --python /opt/venv/bin/python --no-deps \
    "https://github.com/Dao-AILab/causal-conv1d/releases/download/v1.7.0/causal_conv1d-1.7.0%2Bcu12torch2.8cxx11abiTRUE-cp313-cp313-linux_x86_64.whl"

# No flash-linear-attention (the fused Gated DeltaNet kernels Kev's Modal
# image adds): its Triton kernels die with "Illegal instruction" on an
# RTX 5080 (sm_120) under WSL2. Without it, transformers runs the
# reference PyTorch DeltaNet: correct, ~0.3 s per request instead of tens
# of ms. On a Linux datacenter GPU, set --build-arg FLA=1 for the kernels.
ARG FLA=0
RUN if [ "$FLA" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/* && \
      uv pip install --python /opt/venv/bin/python "flash-linear-attention==0.5.2" "triton>=3.7.1"; \
    fi
ENV KEV_FUSED=${FLA}

# model weights and compiled kernels live on a volume so rebuilds do not re-download
ENV HF_HOME=/hf TRITON_CACHE_DIR=/hf/triton-cache TOKENIZERS_PARALLELISM=false PYTHONUNBUFFERED=1

EXPOSE 8009
ENV KEV_RUN=jaredpalmer/kev-4b
CMD ["sh", "-c", "python -m kev.serve --run ${KEV_RUN} --host 0.0.0.0 --port 8009"]
