"""User-friendly error messages for analysis engine.

Provides consistent, actionable error messages in Chinese for common failure modes.
"""


class AnalysisError(ValueError):
    """Base exception for analysis failures with user-friendly Chinese messages."""
    pass


class AudioValidationError(AnalysisError):
    """Audio file validation failures."""
    pass


class ScoreValidationError(AnalysisError):
    """MusicXML score validation failures."""
    pass


class AlignmentError(AnalysisError):
    """Fragment location and alignment failures."""
    pass


def audio_too_short(duration_sec: float, minimum_sec: float) -> str:
    """Error message for audio duration below minimum."""
    return f"录音时长 {duration_sec:.1f} 秒不足以进行分析，至少需要 {minimum_sec:.1f} 秒"


def audio_too_long(duration_sec: float, maximum_sec: float) -> str:
    """Error message for audio duration exceeding maximum."""
    return f"录音时长 {duration_sec:.1f} 秒超过限制，最长支持 {maximum_sec} 秒"


def insufficient_signal(peak_level: float, threshold: float) -> str:
    """Error message for low audio signal level."""
    return f"录音信号太弱（峰值 {peak_level:.3f}，需要 >{threshold:.3f}），请增加音量或靠近麦克风重新录制"


def clipping_detected(clip_ratio: float) -> str:
    """Error message for audio clipping."""
    return f"录音削波过多（{clip_ratio*100:.1f}% 采样点达到上限），请降低录音音量重试"


def unsupported_instrument(instrument: str, supported: list[str]) -> str:
    """Error message for unsupported instrument."""
    supported_str = '、'.join(supported)
    return f"不支持的乐器 '{instrument}'，当前仅支持：{supported_str}"


def invalid_bpm(bpm: float, min_bpm: int, max_bpm: int) -> str:
    """Error message for BPM out of valid range."""
    return f"BPM {bpm} 超出有效范围，须在 {min_bpm}–{max_bpm} 之间"


def insufficient_pitch_events(count: int, minimum: int) -> str:
    """Error message for too few reliable pitch events."""
    return f"可靠音高事件不足（检测到 {count} 个，需要至少 {minimum} 个），录音可能过短、过于安静或背景噪音过大"


def fragment_not_located(best_cost: float, threshold: float) -> str:
    """Error message when fragment location fails."""
    return f"录音片段与乐谱不吻合（对齐成本 {best_cost:.2f} > {threshold:.2f}），请检查：1) 演奏的是否为所选乐谱；2) 起始小节是否正确；3) 录音是否包含足够的音符"


def ambiguous_repeat(best_cost: float, alt_cost: float, margin: float) -> str:
    """Error message when repeated passages cannot be distinguished."""
    return f"乐谱中有重复乐句无法区分（最优成本 {best_cost:.2f}，次优 {alt_cost:.2f}，差距 <{margin:.2f}），请指定起始小节"


def inconsistent_location(long_start: int, short_start: int) -> str:
    """Error message when long/short fragment location disagrees."""
    return f"长短片段定位起点不一致（长片段从音符 {long_start} 开始，短片段从 {short_start} 开始），无法可靠评分；请指定起始小节"


def tempo_mismatch_detected(detected_bpm: float, panel_bpm: float, tolerance: float) -> str:
    """Info message when detected tempo differs from panel BPM."""
    deviation = abs(detected_bpm - panel_bpm) / panel_bpm * 100
    return f"检测到的演奏速度（{detected_bpm:.1f} BPM）与面板设置（{panel_bpm:.1f} BPM）相差 {deviation:.1f}%，已退回固定节拍模式"


def score_too_short(note_count: int, minimum: int) -> str:
    """Error message when score has too few notes."""
    return f"乐谱音符数量不足（{note_count} 个，需要至少 {minimum} 个）"


def no_notes_in_measure_range(start_measure: int, total_measures: int) -> str:
    """Error message when specified measure range contains no notes."""
    return f"起始小节 {start_measure} 超出乐谱范围（共 {total_measures} 小节）或该小节没有可演奏音符"


def recording_too_short_for_excerpt(recording_sec: float, required_sec: float) -> str:
    """Error message when recording doesn't cover the excerpt."""
    return f"录音时长 {recording_sec:.1f} 秒不足以覆盖所选开始小节（需要至少 {required_sec:.1f} 秒）"
