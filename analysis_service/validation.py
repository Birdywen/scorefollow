"""Audio and score validation utilities for analysis engine.

Provides comprehensive validation with user-friendly error messages.
"""
import math
import wave
import io
from typing import Tuple

import numpy as np

from .error_messages import (
    AudioValidationError,
    ScoreValidationError,
    audio_too_short,
    audio_too_long,
    insufficient_signal,
    clipping_detected,
)

MIN_DURATION_SEC = 1.0
MAX_DURATION_SEC = 300
MIN_PEAK_LEVEL = 0.01
MAX_CLIP_RATIO = 0.05
SUPPORTED_SAMPLE_RATES = [22050, 44100, 48000]


def validate_wav_audio(wav_bytes: bytes, max_duration: float = MAX_DURATION_SEC) -> Tuple[np.ndarray, int]:
    """Validate WAV audio file and return signal + sample rate.
    
    Args:
        wav_bytes: Raw WAV file bytes
        max_duration: Maximum allowed duration in seconds
        
    Returns:
        Tuple of (signal as float32 array, sample rate)
        
    Raises:
        AudioValidationError: If audio fails validation
    """
    try:
        with wave.open(io.BytesIO(wav_bytes), 'rb') as w:
            params = w.getparams()
            if params.sampwidth != 2:
                raise AudioValidationError(f"仅支持 16-bit 音频，当前为 {params.sampwidth * 8}-bit")
            if params.nchannels not in (1, 2):
                raise AudioValidationError(f"仅支持单声道或立体声，当前为 {params.nchannels} 声道")
            
            rate = params.framerate
            frames = w.readframes(params.nframes)
            pcm = np.frombuffer(frames, dtype='<i2').astype(np.float32) / 32768.0
            
            # Convert stereo to mono by averaging channels
            if params.nchannels == 2:
                pcm = pcm.reshape(-1, 2).mean(axis=1)
            
            duration = len(pcm) / rate
            
            # Validate duration
            if duration < MIN_DURATION_SEC:
                raise AudioValidationError(audio_too_short(duration, MIN_DURATION_SEC))
            if duration > max_duration:
                raise AudioValidationError(audio_too_long(duration, max_duration))
            
            # Validate signal level
            peak_level = float(np.max(np.abs(pcm)))
            if peak_level < MIN_PEAK_LEVEL:
                raise AudioValidationError(insufficient_signal(peak_level, MIN_PEAK_LEVEL))
            
            # Check for clipping
            clipped = np.sum(np.abs(pcm) > 0.99)
            clip_ratio = clipped / len(pcm)
            if clip_ratio > MAX_CLIP_RATIO:
                raise AudioValidationError(clipping_detected(clip_ratio))
            
            # Normalize if needed (but keep original if already normalized)
            if peak_level > 0.95:
                pcm = pcm / peak_level * 0.9
            
            return pcm, rate
            
    except wave.Error as e:
        raise AudioValidationError(f"WAV 文件格式无效：{e}")
    except Exception as e:
        if isinstance(e, AudioValidationError):
            raise
        raise AudioValidationError(f"音频验证失败：{e}")


def validate_musicxml(xml: str) -> None:
    """Validate MusicXML string for basic structural correctness.
    
    Args:
        xml: MusicXML string
        
    Raises:
        ScoreValidationError: If XML is invalid or malformed
    """
    if not xml or not isinstance(xml, str):
        raise ScoreValidationError("MusicXML 不能为空")
    
    if len(xml) > 5_000_000:
        raise ScoreValidationError(f"MusicXML 文件过大（{len(xml) / 1e6:.1f} MB），最大支持 5 MB")
    
    # Basic XML structure checks
    if '<!ENTITY' in xml or '<!DOCTYPE' in xml[:500] and 'ENTITY' in xml[:1000]:
        raise ScoreValidationError("MusicXML 包含外部实体声明，拒绝解析（安全限制）")
    
    required_tags = ['<score-partwise', '<part ', '<measure']
    for tag in required_tags:
        if tag not in xml:
            raise ScoreValidationError(f"MusicXML 缺少必需标签 {tag}")


def validate_bpm(bpm: float, min_bpm: int = 30, max_bpm: int = 200) -> None:
    """Validate BPM is within reasonable range.
    
    Args:
        bpm: Beats per minute
        min_bpm: Minimum allowed BPM
        max_bpm: Maximum allowed BPM
        
    Raises:
        ValueError: If BPM is out of range
    """
    from .error_messages import invalid_bpm
    
    if not isinstance(bpm, (int, float)) or not math.isfinite(bpm):
        raise ValueError("BPM 必须是有限数值")
    
    if not (min_bpm <= bpm <= max_bpm):
        raise ValueError(invalid_bpm(bpm, min_bpm, max_bpm))


def validate_instrument(instrument: str, supported: list[str] = None) -> None:
    """Validate instrument is supported.
    
    Args:
        instrument: Instrument name
        supported: List of supported instruments (defaults to violin, viola, cello)
        
    Raises:
        ValueError: If instrument is not supported
    """
    from .error_messages import unsupported_instrument
    
    if supported is None:
        supported = ['violin', 'viola', 'cello']
    
    if instrument not in supported:
        raise ValueError(unsupported_instrument(instrument, supported))
