# Ported from graphlearn/apps/eval/app/pattern_hash.py (65b56d6).
import hashlib
import json
from typing import Any


def _sort_value(value: Any) -> Any:
    if isinstance(value, list):
        return [_sort_value(v) for v in value]
    if isinstance(value, dict):
        return {k: _sort_value(value[k]) for k in sorted(value)}
    return value


def canonical_user_input_json(user_input: dict[str, Any]) -> str:
    return json.dumps(_sort_value(user_input), separators=(",", ":"), ensure_ascii=False)


def user_input_pattern_hash(user_input: dict[str, Any]) -> str:
    return hashlib.sha256(canonical_user_input_json(user_input).encode("utf-8")).hexdigest()
