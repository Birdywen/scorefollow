"""Performance monitoring utilities for analysis engine.

Provides timing decorators and performance tracking for key analysis stages.
"""
import functools
import time
from typing import Callable, TypeVar, ParamSpec

P = ParamSpec('P')
R = TypeVar('R')

# Global performance log (in-memory for this session)
performance_log: list[dict] = []


def track_performance(stage_name: str) -> Callable[[Callable[P, R]], Callable[P, R]]:
    """Decorator to track execution time of analysis stages.
    
    Args:
        stage_name: Human-readable name for this processing stage
        
    Returns:
        Decorated function that logs timing information
    """
    def decorator(func: Callable[P, R]) -> Callable[P, R]:
        @functools.wraps(func)
        def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
            start = time.perf_counter()
            try:
                result = func(*args, **kwargs)
                elapsed = time.perf_counter() - start
                performance_log.append({
                    'stage': stage_name,
                    'function': func.__name__,
                    'elapsed_ms': round(elapsed * 1000, 2),
                    'success': True
                })
                return result
            except Exception as e:
                elapsed = time.perf_counter() - start
                performance_log.append({
                    'stage': stage_name,
                    'function': func.__name__,
                    'elapsed_ms': round(elapsed * 1000, 2),
                    'success': False,
                    'error': str(e)
                })
                raise
        return wrapper
    return decorator


def get_performance_summary() -> dict:
    """Get summary of performance metrics for the current session.
    
    Returns:
        Dictionary with stage-wise timing statistics
    """
    if not performance_log:
        return {}
    
    stages = {}
    for entry in performance_log:
        stage = entry['stage']
        if stage not in stages:
            stages[stage] = {'total_ms': 0, 'count': 0, 'failures': 0}
        stages[stage]['total_ms'] += entry['elapsed_ms']
        stages[stage]['count'] += 1
        if not entry['success']:
            stages[stage]['failures'] += 1
    
    for stage_data in stages.values():
        stage_data['avg_ms'] = round(stage_data['total_ms'] / stage_data['count'], 2)
    
    return stages


def clear_performance_log() -> None:
    """Clear the performance log."""
    performance_log.clear()
