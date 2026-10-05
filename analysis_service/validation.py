"""Audio and score validation utilities for analysis engine.

Provides comprehensive validation with user-friendly error messages.
"""
import math
import wave
import io
import re
import xml.etree.ElementTree as ET
from typing import Tuple

import numpy as np

from .error_messages import (
    AudioValidationError,
    ScoreValidationError,
    audio_too_short,
    audio_too_long,
    insufficient_signal,
)

MIN_DURATION_SEC = 0.4
MAX_DURATION_SEC = 300
MIN_PEAK_LEVEL = 0.005
MAX_XML_CHARS = 1_000_000


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
            if params.nchannels != 1:
                raise AudioValidationError(f"仅支持单声道，当前为 {params.nchannels} 声道")
            
            rate = params.framerate
            if not 8000 <= rate <= 48000:
                raise AudioValidationError("仅支持 8–48 kHz 音频")
            if params.nframes / rate > max_duration:
                raise AudioValidationError(audio_too_long(params.nframes / rate, max_duration))
            frames = w.readframes(params.nframes)
            pcm = np.frombuffer(frames, dtype='<i2').astype(np.float32) / 32768.0
            
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
            
            # Preserve raw levels: the analysis engine reports clipping before
            # applying its own normalization.
            
            return pcm, rate
            
    except wave.Error as e:
        raise AudioValidationError(f"WAV 文件格式无效：{e}")
    except Exception as e:
        if isinstance(e, AudioValidationError):
            raise
        raise AudioValidationError(f"音频验证失败：{e}")


def validate_musicxml(xml: str, label: str = "MusicXML") -> ET.Element:
    """Parse XML with the shared score size and entity safeguards.
    
    Args:
        xml: MusicXML string
        
    Raises:
        ScoreValidationError: If XML is invalid or malformed
    """
    if not isinstance(xml, str) or not xml:
        raise ScoreValidationError(f"{label}不能为空")
    
    if len(xml) > MAX_XML_CHARS:
        raise ScoreValidationError(f"{label}文件过大，最大支持 {MAX_XML_CHARS} 字符")
    
    # Allow standard external PUBLIC DTDs, but never internal subsets/entities.
    if '<!ENTITY' in xml.upper() or re.search(r'<!DOCTYPE\b[^>]*\[', xml, re.IGNORECASE):
        raise ScoreValidationError(f"{label}包含不支持的实体声明")
    try:
        return ET.fromstring(xml)
    except ET.ParseError as exc:
        raise ScoreValidationError(f"{label}无法解析") from exc


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
