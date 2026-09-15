"""검증된 로컬 경로만 로더에 넘긴다. 허브 이름/URL은 쓰지 않는다."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .registry import ModelError, PreparedModel


def load_demucs_separator(prepared: PreparedModel, **kwargs: Any) -> Any:
    if prepared.local_repo is None or not prepared.local_repo.is_dir():
        raise ModelError("MODEL_NOT_READY", f"demucs local repo missing for {prepared.id}", id=prepared.id)
    from demucs.api import Separator

    # repo를 주면 RemoteRepo/HF hub를 타지 않는다.
    return Separator(model=prepared.id, repo=Path(prepared.local_repo), **kwargs)


def load_whisper_model(prepared: PreparedModel, **kwargs: Any) -> Any:
    if prepared.model_dir is None or not prepared.model_dir.is_dir():
        raise ModelError("MODEL_NOT_READY", f"whisper model dir missing for {prepared.id}", id=prepared.id)
    from faster_whisper import WhisperModel

    kwargs.setdefault("local_files_only", True)
    # 디렉터리 경로 + local_files_only — snapshot_download를 호출하지 않는다.
    return WhisperModel(str(prepared.model_dir), **kwargs)


def load_mms_fa(prepared: PreparedModel, *, with_star: bool = False) -> tuple[Any, dict[str, int], int]:
    """torchaudio.pipelines.MMS_FA.get_model()은 URL 다운로드라 쓰지 않는다."""
    checkpoint = prepared.checkpoint_path
    if checkpoint is None or not checkpoint.is_file():
        raise ModelError("MODEL_NOT_READY", f"mms-fa checkpoint missing for {prepared.id}", id=prepared.id)
    import torch
    import torchaudio.pipelines
    from torchaudio.pipelines._wav2vec2 import utils as wav2vec2_utils

    bundle = torchaudio.pipelines.MMS_FA
    model = wav2vec2_utils._get_model(bundle._model_type, bundle._params)
    state_dict = torch.load(str(checkpoint), map_location="cpu", weights_only=True)
    if bundle._remove_aux_axis:
        wav2vec2_utils._remove_aux_axes(state_dict, bundle._remove_aux_axis)
    model.load_state_dict(state_dict)
    model = wav2vec2_utils._extend_model(
        model,
        normalize_waveform=bundle._normalize_waveform,
        apply_log_softmax=True,
        append_star=with_star,
    )
    model.eval()
    dictionary = bundle.get_dict(star=None)
    return model, dictionary, int(bundle.sample_rate)


def load_beat_this(prepared: PreparedModel, **kwargs: Any) -> Any:
    checkpoint = prepared.checkpoint_path
    if checkpoint is None or not Path(checkpoint).is_file():
        raise ModelError(
            "MODEL_NOT_READY",
            f"beat-this checkpoint missing for {prepared.id}",
            id=prepared.id,
        )
    from beat_this.inference import Audio2Beats

    # 파일 경로를 넘기면 torch.hub 단축 이름("final0") 다운로드를 타지 않는다.
    return Audio2Beats(checkpoint_path=str(checkpoint), **kwargs)
