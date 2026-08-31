#!/usr/bin/env bash
set -euo pipefail
python -m pip install --upgrade pip
pip install -r requirements.txt
rm -rf vendor/MOSS-TTS-Nano
mkdir -p vendor
git clone --depth 1 https://github.com/OpenMOSS/MOSS-TTS-Nano.git vendor/MOSS-TTS-Nano
# ONNX inference itself does not need PyTorch. Upstream currently imports
# torch/torchaudio only for prompt-audio loading; Masroufi supplies decoded
# PCM to the runtime directly, so remove those imports for low-memory hosts.
python - <<'PY'
from pathlib import Path
p = Path('vendor/MOSS-TTS-Nano/onnx_tts_runtime.py')
s = p.read_text()
s = s.replace('import torch\n', '').replace('import torchaudio\n', '')
p.write_text(s)
PY
